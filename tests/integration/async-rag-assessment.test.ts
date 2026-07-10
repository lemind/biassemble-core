import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";
import { logger } from "../../src/observability/logger.js";
import type { LlmCallStore, RunStore, TraceStore } from "../../src/persistence/ports.js";
import type { RagEngineClient } from "../../src/rag/engine-client.js";
import type { Inngest } from "inngest";

const mockLlmCallStore: LlmCallStore = {
  recordCall: vi.fn().mockResolvedValue({ id: "test-llm-call-id" }),
  getCallsBySession: vi.fn().mockResolvedValue([]),
  getCallsByStage: vi.fn().mockResolvedValue([]),
  getCallsByProvider: vi.fn().mockResolvedValue([]),
  getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
  updateParsedOutput: vi.fn().mockResolvedValue(undefined),
  updateFailure: vi.fn().mockResolvedValue(undefined),
  getCallsForMetrics: vi.fn().mockResolvedValue([]),
};

const mockTraceStore: TraceStore = {
  persistTrace: vi.fn().mockResolvedValue(undefined),
  getTrace: vi.fn().mockResolvedValue(null),
};

const VALID_ASSESSMENT_RESPONSE = {
  biases: [
    {
      name: "confirmation bias",
      explanation: "You tend to favor information that confirms your existing beliefs about your situation.",
      storyConnection: "In your story, you mention reading articles that confirm your current leaning.",
      alternativePerspective: "Consider seeking out perspectives that challenge your current view.",
    },
  ],
  reflectionPrompt: "Reflect on how your beliefs might be influencing your interpretation of events.",
};

function buildRunStore(overrides: Partial<RunStore> = {}): RunStore {
  return {
    createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    getRunsBySession: vi.fn().mockResolvedValue([]),
    storeRagResult: vi.fn().mockResolvedValue(undefined),
    getRagResultForSession: vi.fn().mockResolvedValue(null),
    recordRagStarted: vi.fn().mockResolvedValue(undefined),
    getRagStartedAtForSession: vi.fn().mockResolvedValue(null),
    recordRagCompleted: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RunStore;
}

describe("Async RAG submission — assessment flow (spec-005)", () => {
  let mockProvider: MockProvider;
  let prompts: PromptRegistry;
  let catalog: BiasCatalogService;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockProvider = new MockProvider();
    mockProvider.setDefault(VALID_ASSESSMENT_RESPONSE);
    prompts = new PromptRegistry();
    catalog = new BiasCatalogService();
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("scenario 1 — story_only fires the RAG job instead of blocking, response is fast", async () => {
    const runStore = buildRunStore();
    const ragClient = { retrieve: vi.fn() } as unknown as RagEngineClient;
    const inngestSend = vi.fn().mockResolvedValue({ ids: ["evt-1"] });
    const inngestClient = { send: inngestSend } as unknown as Inngest;

    const service = new AssessmentService(
      mockProvider, prompts, catalog, "mock-model",
      mockLlmCallStore, runStore, mockTraceStore, ragClient, inngestClient,
    );

    const t0 = Date.now();
    await service.runStoryOnlyAssessment("00000000-0000-4000-8000-000000000001", "a".repeat(100), "req-1");
    const elapsedMs = Date.now() - t0;

    expect(elapsedMs).toBeLessThan(5000);
    expect(ragClient.retrieve).not.toHaveBeenCalled();
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "rag/retrieve.requested" })
    );
  });

  it("scenario 2 — full assessment: RAG already stored, rag_available: true logged, no poll", async () => {
    const storedEngineResponse = {
      biases: [
        {
          id: "confirmation_bias",
          name: "Confirmation Bias",
          retrieval_score: 0.9,
          definition: "def",
          examples: "ex",
          indicators: "sought only confirming evidence",
          false_positives: "fp",
          related_biases: "rb",
        },
      ],
      retrieved_chunks: 1,
      taxonomy_version: "v1",
      embedding_model: "mock-embed",
      request_id: "req-stored",
    };
    const getRagResultForSession = vi.fn().mockResolvedValue(storedEngineResponse);
    const runStore = buildRunStore({ getRagResultForSession });
    const ragClient = { retrieve: vi.fn() } as unknown as RagEngineClient;

    const service = new AssessmentService(
      mockProvider, prompts, catalog, "mock-model",
      mockLlmCallStore, runStore, mockTraceStore, ragClient,
    );

    const result = await service.runFullAssessment(
      "00000000-0000-4000-8000-000000000001", "a".repeat(100), ["Q1?"], ["A1 with enough detail."], "req-2",
    );

    expect(result.ragCase).toBe("retrieved");
    expect(getRagResultForSession).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ rag_available: true }),
      "rag_availability_at_assessment"
    );
  });

  it("scenario 3 — full assessment: RAG not ready, rag_available: false logged, roster-only, no poll/wait", async () => {
    const getRagResultForSession = vi.fn().mockResolvedValue(null);
    const runStore = buildRunStore({ getRagResultForSession });
    const ragClient = { retrieve: vi.fn() } as unknown as RagEngineClient;

    const service = new AssessmentService(
      mockProvider, prompts, catalog, "mock-model",
      mockLlmCallStore, runStore, mockTraceStore, ragClient,
    );

    const t0 = Date.now();
    const result = await service.runFullAssessment(
      "00000000-0000-4000-8000-000000000001", "a".repeat(100), ["Q1?"], ["A1 with enough detail."], "req-3",
    );
    const elapsedMs = Date.now() - t0;

    expect(result.ragCase).toBe("unavailable");
    // exactly one read — no polling loop retrying the query
    expect(getRagResultForSession).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(1000);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ rag_available: false }),
      "rag_availability_at_assessment"
    );
  });
});
