import { describe, it, expect, vi } from "vitest";
import { recordComparison } from "../../../src/observability/comparison-recorder.js";
import type { RetrievalComparisonStore } from "../../../src/persistence/ports.js";

function mockStore(): { store: RetrievalComparisonStore; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  return { store: { record }, record };
}

describe("recordComparison — generic per-source breakdown (US3, D017)", () => {
  it("computes source_breakdown per key against finalList, no 'both' key, aggregate unchanged", async () => {
    const { store, record } = mockStore();

    await recordComparison(
      {
        sessionId: "s1",
        runId: "r1",
        ragList: ["Confirmation Bias", "Anchoring Bias", "Halo Effect"],
        sourceLists: {
          vector: ["Confirmation Bias", "Anchoring Bias"],
          llm: ["Confirmation Bias", "Halo Effect"],
        },
        llmListRaw: ["Confirmation Bias", "Sunk Cost Fallacy"],
        finalList: ["Confirmation Bias", "Anchoring Bias", "Sunk Cost Fallacy"],
        ragCase: "retrieved",
        selectionStrategy: "llm_union",
        llmModel: "google_gemma-3-4b-it",
      },
      store,
    );

    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0][0];
    expect(arg.sourceBreakdown).toEqual({
      vector: { list: ["Confirmation Bias", "Anchoring Bias"], hitFinal: 2 },
      llm: { list: ["Confirmation Bias", "Halo Effect"], hitFinal: 1 },
    });
    expect(arg.sourceBreakdown.both).toBeUndefined();
    // existing aggregate unchanged: confirmation + anchoring in final (halo not) = 2
    expect(arg.ragHitFinal).toBe(2);
    expect(arg.selectionStrategy).toBe("llm_union");
    expect(arg.llmModel).toBe("google_gemma-3-4b-it");
  });

  it("stores sourceBreakdown as NULL (not {}) when sourceLists is empty", async () => {
    const { store, record } = mockStore();

    await recordComparison(
      {
        sessionId: "s2",
        runId: "r2",
        ragList: [],
        sourceLists: {},
        llmListRaw: [],
        finalList: [],
        ragCase: "unavailable",
      },
      store,
    );

    const arg = record.mock.calls[0][0];
    expect(arg.sourceBreakdown).toBeNull();
  });

  it("stays fire-and-forget: a throwing store does not reject", async () => {
    const store: RetrievalComparisonStore = {
      record: vi.fn().mockRejectedValue(new Error("db down")),
    };
    await expect(
      recordComparison(
        {
          sessionId: "s3",
          runId: "r3",
          ragList: [],
          sourceLists: {},
          llmListRaw: [],
          finalList: [],
          ragCase: "unavailable",
        },
        store,
      ),
    ).resolves.toBeUndefined();
  });

  it("passes selectionStrategy/llmModel through unchanged when present, null when absent", async () => {
    const { store, record } = mockStore();

    await recordComparison(
      {
        sessionId: "s4",
        runId: "r4",
        ragList: [],
        sourceLists: {},
        llmListRaw: [],
        finalList: [],
        ragCase: "unavailable",
        // selectionStrategy/llmModel omitted entirely
      },
      store,
    );

    const arg = record.mock.calls[0][0];
    expect(arg.selectionStrategy).toBeNull();
    expect(arg.llmModel).toBeNull();
  });
});
