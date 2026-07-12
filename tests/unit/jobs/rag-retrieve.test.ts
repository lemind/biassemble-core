import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRagRetrieveJob } from "../../../src/jobs/rag-retrieve.js";
import { logger } from "../../../src/observability/logger.js";
import type { RagEngineClient } from "../../../src/rag/engine-client.js";
import type { RunStore, RetrievalComparisonStore } from "../../../src/persistence/ports.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";

// job.fn (below) reaches into an Inngest implementation detail — createFunction()
// exposes the raw handler at `.fn`, undocumented but stable across recent SDK
// versions. If an Inngest upgrade changes this shape, these tests fail as
// "fn is not a function" rather than a meaningful assertion — check here first.

function buildEvent(data: Record<string, unknown> = {}) {
  return {
    event: {
      name: "rag/retrieve.requested",
      data: {
        story: "a story",
        sessionId: "session-1",
        runId: "run-1",
        startedAt: new Date().toISOString(),
        ...data,
      },
    },
  } as never;
}

function buildRunStore(): RunStore {
  return {
    createRun: vi.fn(),
    getRunsBySession: vi.fn(),
    storeRagResult: vi.fn().mockResolvedValue(undefined),
    getRagResultForSession: vi.fn(),
    recordRagStarted: vi.fn(),
    getRagStartedAtForSession: vi.fn(),
    recordRagCompleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as RunStore;
}

describe("rag-retrieve job", () => {
  let runStore: RunStore;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runStore = buildRunStore();
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("success path calls storeRagResult(runId, engineData) and does not throw", async () => {
    const engineData = {
      biases: [],
      retrieved_chunks: 0,
      taxonomy_version: "v1",
      embedding_model: "mock-embed",
      request_id: "req-1",
    };
    const ragClient = {
      retrieve: vi.fn().mockResolvedValue({ status: "ok", data: engineData }),
    } as unknown as RagEngineClient;
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());

    expect(runStore.storeRagResult).toHaveBeenCalledWith("run-1", engineData);
    expect(runStore.recordRagCompleted).toHaveBeenCalledWith("run-1", expect.any(Date));
  });

  it("success path trims bulky per-bias text before storing (see toStorableEngineResponse)", async () => {
    const engineData = {
      biases: [{
        id: "confirmation_bias",
        name: "Confirmation Bias",
        retrieval_score: 0.5,
        indicators: "seeks confirming evidence",
        source: ["llm"],
        definition: "a very long definition".repeat(50),
        examples: "many examples".repeat(50),
        false_positives: "notes".repeat(50),
        related_biases: "Anchoring Bias",
      }],
      retrieved_chunks: 1,
      taxonomy_version: "v1",
      embedding_model: "mock-embed",
      request_id: "req-2",
    };
    const ragClient = {
      retrieve: vi.fn().mockResolvedValue({ status: "ok", data: engineData }),
    } as unknown as RagEngineClient;
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());

    const stored = (runStore.storeRagResult as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.biases[0].definition).toBeUndefined();
    expect(stored.biases[0].examples).toBeUndefined();
    expect(stored.biases[0].id).toBe("confirmation_bias");
    expect(stored.biases[0].indicators).toBe("seeks confirming evidence");
  });

  it("engine-unavailable path calls storeRagResult(runId, null) and does NOT set rag_completed_at", async () => {
    const ragClient = {
      retrieve: vi.fn().mockResolvedValue({ status: "unavailable" }),
    } as unknown as RagEngineClient;
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());

    expect(runStore.storeRagResult).toHaveBeenCalledWith("run-1", null);
    // rag_completed_at means "genuinely finished" — a timeout/unavailable outcome
    // must leave it null, not stamp a false-positive completion time.
    expect(runStore.recordRagCompleted).not.toHaveBeenCalled();
  });

  it("failure path (thrown error) calls storeRagResult(runId, null), does not throw, does NOT set rag_completed_at", async () => {
    const ragClient = {
      retrieve: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as RagEngineClient;
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());

    expect(runStore.storeRagResult).toHaveBeenCalledWith("run-1", null);
    expect(runStore.recordRagCompleted).not.toHaveBeenCalled();
  });

  it("logs rag_retrieve_complete on success", async () => {
    const ragClient = {
      retrieve: vi.fn().mockResolvedValue({ status: "ok", data: { biases: [], retrieved_chunks: 0, taxonomy_version: "v1", embedding_model: "m", request_id: "r" } }),
    } as unknown as RagEngineClient;
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", sessionId: "session-1", runId: "run-1" }),
      "rag_retrieve_complete"
    );
  });

  it("triggers the D017 backfill when a comparisonStore is wired and RAG succeeds", async () => {
    const engineData = {
      biases: [{
        id: "confirmation_bias",
        name: "Confirmation Bias",
        retrieval_score: 0.9,
        indicators: "i",
        source: ["vector"],
      }],
      retrieved_chunks: 1,
      taxonomy_version: "v1",
      embedding_model: "mock-embed",
      request_id: "req-3",
    };
    const ragClient = {
      retrieve: vi.fn().mockResolvedValue({ status: "ok", data: engineData }),
    } as unknown as RagEngineClient;
    const comparisonStore: RetrievalComparisonStore = {
      record: vi.fn(),
      findUnbackfilledBySession: vi.fn().mockResolvedValue([
        { id: "row-1", llmList: ["Confirmation Bias"], finalList: ["Confirmation Bias"] },
      ]),
      backfillSourceData: vi.fn().mockResolvedValue(undefined),
    };
    const job = createRagRetrieveJob(ragClient, runStore, new BiasCatalogService().getAll(), comparisonStore);

    await job.fn(buildEvent());

    expect(comparisonStore.findUnbackfilledBySession).toHaveBeenCalledWith("session-1");
    expect(comparisonStore.backfillSourceData).toHaveBeenCalledWith(
      "row-1",
      expect.objectContaining({ ragStatus: "retrieved", ragList: ["Confirmation Bias"] }),
    );
  });

  it("does not touch comparisonStore when it isn't configured (undefined)", async () => {
    const ragClient = {
      retrieve: vi.fn().mockResolvedValue({ status: "ok", data: { biases: [], retrieved_chunks: 0, taxonomy_version: "v1", embedding_model: "m", request_id: "r" } }),
    } as unknown as RagEngineClient;
    // no comparisonStore passed — should not throw, should just skip backfill
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());
  });

  it("logs warn on catch", async () => {
    const ragClient = {
      retrieve: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as RagEngineClient;
    const job = createRagRetrieveJob(ragClient, runStore, []);

    await job.fn(buildEvent());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", runId: "run-1" }),
      "rag_retrieve_failed"
    );
  });
});
