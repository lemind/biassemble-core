import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsertRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockInsertClaim = vi.fn();

vi.mock("../../../src/db/queries.js", () => ({
  insertGrounnelRun: (...args: unknown[]) => mockInsertRun(...args),
  updateGrounnelRun: (...args: unknown[]) => mockUpdateRun(...args),
  insertGrounnelClaim: (...args: unknown[]) => mockInsertClaim(...args),
}));

const { DrizzleGrounnelHistoryStore } = await import("../../../src/persistence/grounnel-history-store.js");

describe("DrizzleGrounnelHistoryStore (T024) — D023 §7: best-effort, never throws", () => {
  beforeEach(() => {
    mockInsertRun.mockReset();
    mockUpdateRun.mockReset();
    mockInsertClaim.mockReset();
  });

  it("createRun calls insertGrounnelRun with the exact data given", async () => {
    mockInsertRun.mockResolvedValue({ runId: "r1" });
    const store = new DrizzleGrounnelHistoryStore();
    const data = { runId: "r1", sessionId: null, text: "article", source: "production" as const, maxClaims: 100, truncated: false };
    await store.createRun(data);
    expect(mockInsertRun).toHaveBeenCalledWith(data);
  });

  it("createRun swallows a DB failure instead of throwing", async () => {
    mockInsertRun.mockRejectedValue(new Error("connection refused"));
    const store = new DrizzleGrounnelHistoryStore();
    await expect(
      store.createRun({ runId: "r1", sessionId: null, text: "article", source: "production", maxClaims: 100, truncated: false })
    ).resolves.toBeUndefined();
  });

  it("updateRun calls updateGrounnelRun with the exact patch given", async () => {
    mockUpdateRun.mockResolvedValue(undefined);
    const store = new DrizzleGrounnelHistoryStore();
    await store.updateRun("r1", { status: "done" });
    expect(mockUpdateRun).toHaveBeenCalledWith("r1", { status: "done" });
  });

  it("updateRun swallows a DB failure instead of throwing", async () => {
    mockUpdateRun.mockRejectedValue(new Error("connection refused"));
    const store = new DrizzleGrounnelHistoryStore();
    await expect(store.updateRun("r1", { status: "done" })).resolves.toBeUndefined();
  });

  it("createClaim calls insertGrounnelClaim with the exact data given", async () => {
    mockInsertClaim.mockResolvedValue({ claimId: "c1" });
    const store = new DrizzleGrounnelHistoryStore();
    const data = {
      claimId: "c1",
      runId: "r1",
      claimText: "The sky is blue.",
      verdict: "supported" as const,
      evidence: "the sky appears blue",
      confidence: 0.9,
      reason: "confirmed",
      sources: [],
      status: "done" as const,
    };
    await store.createClaim(data);
    expect(mockInsertClaim).toHaveBeenCalledWith(data);
  });

  it("createClaim swallows a DB failure instead of throwing", async () => {
    mockInsertClaim.mockRejectedValue(new Error("connection refused"));
    const store = new DrizzleGrounnelHistoryStore();
    await expect(
      store.createClaim({
        claimId: "c1",
        runId: "r1",
        claimText: "text",
        verdict: null,
        evidence: null,
        confidence: null,
        reason: null,
        sources: [],
        status: "failed",
      })
    ).resolves.toBeUndefined();
  });
});
