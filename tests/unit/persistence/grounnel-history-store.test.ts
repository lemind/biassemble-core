import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsertRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockInsertClaim = vi.fn();
const mockSelectRunByToken = vi.fn();
const mockSelectClaims = vi.fn();

vi.mock("../../../src/db/queries.js", () => ({
  insertGrounnelRun: (...args: unknown[]) => mockInsertRun(...args),
  updateGrounnelRun: (...args: unknown[]) => mockUpdateRun(...args),
  insertGrounnelClaim: (...args: unknown[]) => mockInsertClaim(...args),
  selectGrounnelRunByShareToken: (...args: unknown[]) => mockSelectRunByToken(...args),
  selectGrounnelClaimsByRunId: (...args: unknown[]) => mockSelectClaims(...args),
}));

const { DrizzleGrounnelHistoryStore } = await import("../../../src/persistence/grounnel-history-store.js");

describe("DrizzleGrounnelHistoryStore (T024) — D023 §7: best-effort, never throws", () => {
  beforeEach(() => {
    mockInsertRun.mockReset();
    mockUpdateRun.mockReset();
    mockInsertClaim.mockReset();
    mockSelectRunByToken.mockReset();
    mockSelectClaims.mockReset();
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
      citations: [{ source: "s1", sentence: 0, url: "https://a.example/x", text: "the sky appears blue" }],
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
        citations: [],
        status: "failed",
      })
    ).resolves.toBeUndefined();
  });
});

// The whole point of the column: a shared link must render the same page the runner saw, which
// means the quoted sentences have to survive the round trip rather than being rebuilt from sources.
describe("readAssessmentByToken — citations round-trip (shared link parity)", () => {
  const run = {
    runId: "r1",
    status: "done" as const,
    text: "The sky is blue.",
    createdAt: new Date("2026-09-13T00:00:00Z"),
    completedAt: new Date("2026-09-13T00:01:00Z"),
    score: null,
  };
  const claimRow = {
    claimText: "The sky is blue.",
    verdict: "supported" as const,
    evidence: "the sky appears blue",
    confidence: 0.9,
    reason: "confirmed",
    sources: [],
    citations: null as unknown,
    sourceExcerpt: "The sky is blue.",
  };

  beforeEach(() => {
    mockSelectRunByToken.mockReset();
    mockSelectClaims.mockReset();
  });

  it("passes stored citations through untouched", async () => {
    const citations = [{ source: "s1", sentence: 2, url: "https://a.example/x", text: "the sky appears blue" }];
    mockSelectRunByToken.mockResolvedValue(run);
    mockSelectClaims.mockResolvedValue([{ ...claimRow, citations }]);
    const store = new DrizzleGrounnelHistoryStore();
    const assessment = await store.readAssessmentByToken("tok");
    expect(assessment?.claims[0]?.citations).toEqual(citations);
  });

  it("reports a pre-column row as [] rather than null, so the reader falls back to sources", async () => {
    mockSelectRunByToken.mockResolvedValue(run);
    mockSelectClaims.mockResolvedValue([claimRow]);
    const store = new DrizzleGrounnelHistoryStore();
    const assessment = await store.readAssessmentByToken("tok");
    expect(assessment?.claims[0]?.citations).toEqual([]);
  });
});
