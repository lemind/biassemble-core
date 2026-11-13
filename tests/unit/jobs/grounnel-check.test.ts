import { describe, it, expect, beforeEach } from "vitest";
import { runQueuedCheck, failQueuedCheck, CLAIMS_PER_STEP, type GrounnelCheckDeps, type GrounnelCheckEvent, type StepRunner } from "../../../src/jobs/grounnel-check.js";
import type { PipelineClaimInput } from "../../../src/orchestrators/grounnel/pipeline.service.js";
import type { Provider } from "../../../src/providers/types.js";

const claims = (n: number): PipelineClaimInput[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `claim ${i}` }) as PipelineClaimInput);

describe("queued Grounnel check", () => {
  let steps: string[];
  let chunks: string[][];
  let unchecked: string[][];
  let finished: Array<string | undefined>;
  let failed: string[];
  let deleted: string[];
  let builtWith: Array<string | undefined>;
  let stopOnChunk: number | null;
  let vaultKey: string | null;
  let deps: GrounnelCheckDeps;
  const step: StepRunner = { run: async (id, fn) => { steps.push(id); return fn(); } };

  beforeEach(() => {
    steps = []; chunks = []; unchecked = []; finished = []; failed = []; deleted = []; builtWith = [];
    stopOnChunk = null;
    vaultKey = "sk-own-key";
    deps = {
      extractService: { classifyEligibility: async (_id: string, c: PipelineClaimInput[]) => c } as never,
      pipelineService: {
        runChunk: async (_id: string, chunk: PipelineClaimInput[]) => {
          chunks.push(chunk.map((c) => c.id));
          return chunks.length === stopOnChunk ? "provider_quota" : undefined;
        },
        markUnchecked: async (_id: string, chunk: PipelineClaimInput[]) => void unchecked.push(chunk.map((c) => c.id)),
        finishRun: async (_id: string, stoppedBy?: string) => void finished.push(stoppedBy),
        failRun: async (_id: string, reason: string) => void failed.push(reason),
      } as never,
      vault: { get: async () => vaultKey, delete: async (id: string) => void deleted.push(id), put: async () => undefined } as never,
      buildProvider: (id, _source, key) => { builtWith.push(key); return { mode: id, model: "m" } as Provider; },
    };
  });

  const own = (n: number): GrounnelCheckEvent => ({ runId: "run-1", text: "t", pendingClaims: claims(n), searchEngine: "defaultFlow", providerId: "deepseek", keySource: "own" });

  it("verifies 40 claims in steps of 8, then finishes and deletes the key", async () => {
    const result = await runQueuedCheck(own(40), step, deps);
    expect(CLAIMS_PER_STEP).toBe(8);
    expect(chunks.map((c) => c.length)).toEqual([8, 8, 8, 8, 8]);
    expect(steps).toEqual(["eligibility", "verify-0", "verify-8", "verify-16", "verify-24", "verify-32", "finish"]);
    expect(finished).toEqual([undefined]);
    expect(deleted).toEqual(["run-1"]);
    expect(result).toEqual({ claims: 40, stoppedBy: null });
    expect(builtWith.every((k) => k === "sk-own-key")).toBe(true);
  });

  it("after a provider stop, marks the remaining chunks unchecked and records the reason on done", async () => {
    stopOnChunk = 2;
    await runQueuedCheck(own(40), step, deps);
    expect(chunks).toHaveLength(2);
    expect(unchecked.flat()).toHaveLength(24);
    expect(finished).toEqual(["provider_quota"]);
  });

  it("fails the run as time_limit when the own key expired before a step", async () => {
    vaultKey = null;
    const error = await runQueuedCheck(own(8), step, deps).catch((e: Error) => e);
    expect((error as Error).name).toBe("KeyGoneError");
    await failQueuedCheck(own(8), error as Error, deps);
    expect(failed).toEqual(["time_limit"]);
    expect(deleted).toEqual(["run-1"]);
  });

  it("builds no own-key judge for a site check and never touches the vault for its key", async () => {
    await runQueuedCheck({ ...own(3), providerId: undefined, keySource: undefined }, step, deps);
    expect(builtWith).toEqual([]);
    expect(chunks).toEqual([["c0", "c1", "c2"]]);
  });
});
