import { describe, it, expect, vi } from "vitest";
import { backfillComparisonSourceData } from "../../../src/observability/comparison-recorder.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { RetrievalComparisonStore } from "../../../src/persistence/ports.js";
import type { BiasResult, EngineResponse, RagClientResult } from "../../../src/rag/engine-client.js";

// D017 follow-up: RAG regularly takes 35s-120s+ to complete (measured against live data),
// while the full assessment's recordComparison fires immediately after the LLM call — so
// most real requests record rag_status="unavailable" even though RAG eventually succeeds a
// few seconds/minutes later. This backfill re-derives the RAG-side fields once that late
// result becomes available, instead of leaving the row permanently incomplete.

const catalog = new BiasCatalogService().getAll();

function bias(partial: Partial<BiasResult> & { id: string; retrieval_score: number }): BiasResult {
  return { name: partial.id, indicators: "i", ...partial };
}

function retrievedResult(biases: BiasResult[]): RagClientResult {
  const data: EngineResponse = {
    biases,
    retrieved_chunks: biases.length,
    taxonomy_version: "t",
    embedding_model: "m",
    request_id: "req",
    selection_strategy: "llm_union",
    llm_model: "google_gemma-3-4b-it",
  };
  return { status: "ok", data };
}

function mockStore(unbackfilled: Array<{ id: string; llmList: string[]; finalList: string[] }>) {
  const backfillSourceData = vi.fn().mockResolvedValue(undefined);
  const findUnbackfilledBySession = vi.fn().mockResolvedValue(unbackfilled);
  const store: RetrievalComparisonStore = {
    record: vi.fn().mockResolvedValue(undefined),
    findUnbackfilledBySession,
    backfillSourceData,
  };
  return { store, backfillSourceData, findUnbackfilledBySession };
}

describe("backfillComparisonSourceData (D017 backfill)", () => {
  it("recomputes and writes RAG-derived fields against the row's frozen llmList/finalList", async () => {
    const { store, backfillSourceData } = mockStore([
      { id: "row-1", llmList: ["Confirmation Bias", "Sunk Cost Fallacy"], finalList: ["Confirmation Bias"] },
    ]);

    await backfillComparisonSourceData(
      "sess-1",
      retrievedResult([
        bias({ id: "confirmation_bias", name: "Confirmation Bias", retrieval_score: 0.9, source: ["vector", "llm"] }),
        bias({ id: "anchoring", name: "Anchoring Bias", retrieval_score: 0.7, source: ["llm"] }),
      ]),
      catalog,
      store,
    );

    expect(backfillSourceData).toHaveBeenCalledTimes(1);
    const [id, data] = backfillSourceData.mock.calls[0];
    expect(id).toBe("row-1");
    expect(data.ragStatus).toBe("retrieved");
    expect(data.ragList).toEqual(["Confirmation Bias", "Anchoring Bias"]);
    // overlap: ragList ∩ llmList = ["Confirmation Bias"]
    expect(data.overlap).toBe(1);
    // ragOnly: ragList - llmList = ["Anchoring Bias"]
    expect(data.ragOnly).toBe(1);
    // llmOnly: llmList - ragList = ["Sunk Cost Fallacy"] (depends on ragList — must be recomputed)
    expect(data.llmOnly).toBe(1);
    // ragHitFinal: ragList ∩ finalList = ["Confirmation Bias"]
    expect(data.ragHitFinal).toBe(1);
    expect(data.sourceBreakdown).toEqual({
      vector: { list: ["Confirmation Bias"], hitFinal: 1 },
      llm: { list: ["Confirmation Bias", "Anchoring Bias"], hitFinal: 1 },
    });
    expect(data.selectionStrategy).toBe("llm_union");
    expect(data.llmModel).toBe("google_gemma-3-4b-it");
  });

  it("does nothing when the new RAG result is still not usable (e.g. still unavailable)", async () => {
    const { store, backfillSourceData, findUnbackfilledBySession } = mockStore([
      { id: "row-1", llmList: [], finalList: [] },
    ]);

    await backfillComparisonSourceData("sess-2", { status: "unavailable" }, catalog, store);

    expect(findUnbackfilledBySession).not.toHaveBeenCalled();
    expect(backfillSourceData).not.toHaveBeenCalled();
  });

  it("does nothing when there are no unbackfilled rows for the session", async () => {
    const { store, backfillSourceData } = mockStore([]);

    await backfillComparisonSourceData(
      "sess-3",
      retrievedResult([bias({ id: "confirmation_bias", name: "Confirmation Bias", retrieval_score: 0.9, source: ["vector"] })]),
      catalog,
      store,
    );

    expect(backfillSourceData).not.toHaveBeenCalled();
  });

  it("logs and continues if one row's backfill write fails, without throwing", async () => {
    const { store } = mockStore([
      { id: "row-1", llmList: [], finalList: [] },
      { id: "row-2", llmList: [], finalList: [] },
    ]);
    (store.backfillSourceData as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);

    await expect(
      backfillComparisonSourceData(
        "sess-4",
        retrievedResult([bias({ id: "confirmation_bias", name: "Confirmation Bias", retrieval_score: 0.9, source: ["vector"] })]),
        catalog,
        store,
      ),
    ).resolves.toBeUndefined();

    expect(store.backfillSourceData).toHaveBeenCalledTimes(2);
  });
});
