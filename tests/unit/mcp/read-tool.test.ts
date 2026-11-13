import { describe, it, expect } from "vitest";
import { handleGetFactCheck, mapStatus, type ReadToolDeps } from "../../../src/mcp/tools/read.js";
import type { SharedAssessment } from "../../../src/contracts/grounnel.schemas.js";

const TOKEN = "knrYomRVILN14zljAhoJeeja7POX0EE_";
const allow = { consume: async () => ({ allowed: true as const }) };

function run(overrides: Partial<SharedAssessment>): SharedAssessment {
  return {
    status: "done", text: "t", createdAt: "", completedAt: null, provider: "qwen", model: "m", ownKeyTokens: null,
    truncated: false, failureReason: null,
    claims: [{ text: "c", verdict: "supported", evidence: null, confidence: 0.9, reason: "r", sources: [], citations: [], status: "done", sourceExcerpt: null }],
    ...overrides,
  };
}

function deps(overrides: Partial<ReadToolDeps> = {}): ReadToolDeps {
  return { tokenLimiter: allow, globalLimiter: allow, readAssessment: async () => run({}), ...overrides };
}

describe("get_fact_check", () => {
  it.each([
    ["extracting", { status: "running", phase: "extracting" }],
    ["verifying", { status: "running", phase: "verifying" }],
    ["done", { status: "done", phase: null }],
    ["failed", { status: "failed", phase: null }],
  ] as const)("maps %s", (status, expected) => {
    expect(mapStatus(status)).toEqual(expected);
  });

  it("asks to read again while running and stops asking at the end", async () => {
    const running = await handleGetFactCheck({ shareToken: TOKEN }, deps({ readAssessment: async () => run({ status: "verifying" }) }));
    expect(running.structuredContent).toMatchObject({ status: "running", readAfterSeconds: 10, progress: { finished: 1, total: null } });
    const done = await handleGetFactCheck({ shareToken: TOKEN }, deps());
    expect(done.structuredContent).toMatchObject({ status: "done", readAfterSeconds: null, progress: { finished: 1, total: 1 } });
  });

  it("returns a failed or provider-stopped check as a normal result with its reason", async () => {
    const failed = await handleGetFactCheck({ shareToken: TOKEN }, deps({ readAssessment: async () => run({ status: "failed", failureReason: "time_limit" }) }));
    expect(failed.isError).toBeUndefined();
    expect(failed.structuredContent).toMatchObject({ status: "failed", failureReason: "time_limit" });
    const stopped = await handleGetFactCheck({ shareToken: TOKEN }, deps({ readAssessment: async () => run({ failureReason: "provider_quota" }) }));
    expect(stopped.structuredContent).toMatchObject({ status: "done", failureReason: "provider_quota" });
  });

  it("answers unknown and malformed tokens as not found", async () => {
    expect((await handleGetFactCheck({ shareToken: TOKEN }, deps({ readAssessment: async () => null }))).structuredContent).toMatchObject({ code: "not_found" });
    expect((await handleGetFactCheck({ shareToken: "short" }, deps())).structuredContent).toMatchObject({ code: "not_found" });
  });

  it("fails closed when Redis or the database throws", async () => {
    const broken = { consume: async () => { throw new Error("redis down"); } };
    expect((await handleGetFactCheck({ shareToken: TOKEN }, deps({ tokenLimiter: broken }))).structuredContent).toMatchObject({ code: "service_unavailable" });
    expect((await handleGetFactCheck({ shareToken: TOKEN }, deps({ readAssessment: async () => { throw new Error("db"); } }))).structuredContent).toMatchObject({ code: "service_unavailable" });
  });

  it("reports the read limit with its retry time", async () => {
    const limited = await handleGetFactCheck({ shareToken: TOKEN }, deps({ tokenLimiter: { consume: async () => ({ allowed: false as const, retryAfterSeconds: 77 }) } }));
    expect(limited.structuredContent).toMatchObject({ code: "rate_limited", retryAfterSeconds: 77 });
  });
});
