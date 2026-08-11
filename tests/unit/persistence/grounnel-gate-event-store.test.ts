import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsertGateEvents = vi.fn();

vi.mock("../../../src/db/queries.js", () => ({
  insertGrounnelGateEvents: (...args: unknown[]) => mockInsertGateEvents(...args),
}));

const { DrizzleGrounnelGateEventStore } = await import("../../../src/persistence/grounnel-gate-event-store.js");

describe("DrizzleGrounnelGateEventStore (T027) — D023 §5, best-effort, never throws", () => {
  beforeEach(() => {
    mockInsertGateEvents.mockReset();
  });

  it("recordGateEvents batches all events into one insertGrounnelGateEvents call, each row carrying runId/claimId", async () => {
    mockInsertGateEvents.mockResolvedValue([]);
    const store = new DrizzleGrounnelGateEventStore();
    store.recordGateEvents("r1", "c1", [
      { gate: "reason_consistency", verdictBefore: "unsupported", verdictAfter: "unsupported", overridden: false, reason: null },
      { gate: "implicit_negation", verdictBefore: "unsupported", verdictAfter: "contradicted", overridden: true, reason: "bare_negation_matched" },
      { gate: "contradiction_evidence", verdictBefore: "contradicted", verdictAfter: "contradicted", overridden: false, reason: null },
      { gate: "numeric", verdictBefore: "contradicted", verdictAfter: "contradicted", overridden: false, reason: null },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInsertGateEvents).toHaveBeenCalledTimes(1);
    const rows = mockInsertGateEvents.mock.calls[0]![0] as Array<{ runId: string; claimId: string; gate: string; reason: string | null }>;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.runId === "r1" && r.claimId === "c1")).toBe(true);
    expect(rows.map((r) => r.gate)).toEqual(["reason_consistency", "implicit_negation", "contradiction_evidence", "numeric"]);
    expect(rows.map((r) => r.reason)).toEqual([null, "bare_negation_matched", null, null]);
  });

  it("does nothing (no insert call at all) when given an empty events array", () => {
    const store = new DrizzleGrounnelGateEventStore();
    store.recordGateEvents("r1", "c1", []);
    expect(mockInsertGateEvents).not.toHaveBeenCalled();
  });

  it("does not throw when the DB insert fails (e.g. the claim row's own insert silently failed first — FK violation)", async () => {
    mockInsertGateEvents.mockRejectedValue(new Error("insert or update on table violates foreign key constraint"));
    const store = new DrizzleGrounnelGateEventStore();
    expect(() =>
      store.recordGateEvents("r1", "c1", [{ gate: "numeric", verdictBefore: "supported", verdictAfter: "supported", overridden: false, reason: null }])
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
