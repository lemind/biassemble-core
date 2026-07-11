import { describe, it, expect, vi } from "vitest";
import { recordComparison } from "../../../src/observability/comparison-recorder.js";
import type { RetrievalComparisonStore } from "../../../src/persistence/ports.js";

function mockStore(): { store: RetrievalComparisonStore; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  return { store: { record }, record };
}

describe("recordComparison — per-source split & confirmation counts (US3, D015)", () => {
  it("computes name-keyed per-source hit counts against finalList without inflating ragHitFinal", async () => {
    const { store, record } = mockStore();

    await recordComparison(
      {
        sessionId: "s1",
        runId: "r1",
        ragList: ["Confirmation Bias", "Anchoring Bias", "Halo Effect"],
        ragVectorList: ["Confirmation Bias", "Anchoring Bias"], // confirmation=both, anchoring=vector-only
        ragLlmList: ["Confirmation Bias", "Halo Effect"], // confirmation=both, halo=llm-only
        llmListRaw: ["Confirmation Bias", "Sunk Cost Fallacy"],
        finalList: ["Confirmation Bias", "Anchoring Bias", "Sunk Cost Fallacy"],
        ragCase: "retrieved",
      },
      store,
    );

    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0][0];
    // per-source lists persisted verbatim (a both-bias is in both)
    expect(arg.ragVectorList).toEqual(["Confirmation Bias", "Anchoring Bias"]);
    expect(arg.ragLlmList).toEqual(["Confirmation Bias", "Halo Effect"]);
    // confirmation + anchoring reached final
    expect(arg.ragVectorHitFinal).toBe(2);
    // confirmation reached final; halo did not
    expect(arg.ragLlmHitFinal).toBe(1);
    // both-source names (confirmation) that reached final
    expect(arg.ragBothHitFinal).toBe(1);
    // existing aggregate unchanged: confirmation + anchoring in final (halo not) = 2
    expect(arg.ragHitFinal).toBe(2);
    expect(arg.ragStatus).toBe("retrieved");
  });

  it("stays fire-and-forget: a throwing store does not reject", async () => {
    const store: RetrievalComparisonStore = {
      record: vi.fn().mockRejectedValue(new Error("db down")),
    };
    await expect(
      recordComparison(
        {
          sessionId: "s2",
          runId: "r2",
          ragList: [],
          ragVectorList: [],
          ragLlmList: [],
          llmListRaw: [],
          finalList: [],
          ragCase: "unavailable",
        },
        store,
      ),
    ).resolves.toBeUndefined();
  });
});
