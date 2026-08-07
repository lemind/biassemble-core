import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsertSearchCall = vi.fn();

vi.mock("../../../src/db/queries.js", () => ({
  insertGrounnelSearchCall: (...args: unknown[]) => mockInsertSearchCall(...args),
}));

const { DrizzleGrounnelSearchCallStore } = await import("../../../src/persistence/grounnel-search-call-store.js");

describe("DrizzleGrounnelSearchCallStore (T026) — D023 §6, best-effort, never throws", () => {
  beforeEach(() => {
    mockInsertSearchCall.mockReset();
  });

  it("recordSearchCall calls insertGrounnelSearchCall with the exact data given", async () => {
    mockInsertSearchCall.mockResolvedValue({ id: "s1" });
    const store = new DrizzleGrounnelSearchCallStore();
    const data = {
      runId: "r1",
      claimId: "c1",
      query: "some claim text",
      callType: "diy_fetch" as const,
      url: "https://example.com",
      resultCount: 1,
      status: "ok" as const,
      durationMs: 42,
    };
    store.recordSearchCall(data);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockInsertSearchCall).toHaveBeenCalledWith(data);
  });

  it("does not throw when the DB insert fails", async () => {
    mockInsertSearchCall.mockRejectedValue(new Error("connection refused"));
    const store = new DrizzleGrounnelSearchCallStore();
    expect(() =>
      store.recordSearchCall({
        runId: "r1",
        claimId: "c1",
        query: "q",
        callType: "tavily_fallback",
        url: null,
        resultCount: 0,
        status: "unreachable",
        durationMs: 5,
      })
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
