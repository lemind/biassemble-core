import { describe, it, expect } from "vitest";
import { startCheck, type CheckQueue } from "../../../../src/orchestrators/grounnel/start-check.js";
import type { GrounnelCheckEvent } from "../../../../src/jobs/grounnel-check.js";
import type { Provider } from "../../../../src/providers/types.js";

const KEY = "sk-start-check-secret";
const provider = { mode: "qwen", model: "m", preflight: async () => undefined, completeJson: async () => ({}) } as unknown as Provider;

function services(queue: CheckQueue) {
  const inProcess: string[] = [];
  return {
    inProcess,
    extractService: {
      run: async () => ({ id: "run-1", shareToken: "share-1", pendingClaims: [{ id: "c1", text: "claim" }] }),
      classifyEligibility: async () => { inProcess.push("eligibility"); return []; },
    } as never,
    pipelineService: {} as never,
    queue,
  };
}

describe("startCheck queue hand-off", () => {
  it("seals the own key in the vault and sends an event without it", async () => {
    const sealed: string[] = [];
    const sent: GrounnelCheckEvent[] = [];
    const queue: CheckQueue = {
      vault: { put: async (_id: string, key: string) => void sealed.push(key), delete: async () => undefined } as never,
      send: async (data) => void sent.push(data),
    };
    const s = services(queue);
    const result = await startCheck(s, { text: "t", sessionId: null, searchEngine: "defaultFlow", provider, keySource: "own", entryPoint: "mcp", ownKey: KEY });
    expect(result.ok).toBe(true);
    expect(sealed).toEqual([KEY]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ runId: "run-1", providerId: "qwen", keySource: "own" });
    expect(JSON.stringify(sent)).not.toContain(KEY);
    expect(s.inProcess).toEqual([]);
  });

  it("falls back to the in-process run and deletes the sealed key when the event can't be sent", async () => {
    const deleted: string[] = [];
    const queue: CheckQueue = {
      vault: { put: async () => undefined, delete: async (id: string) => void deleted.push(id) } as never,
      send: async () => { throw new Error("inngest down"); },
    };
    const s = services(queue);
    const result = await startCheck(s, { text: "t", sessionId: null, searchEngine: "defaultFlow", provider, keySource: "own", entryPoint: "website", ownKey: KEY });
    expect(result.ok).toBe(true);
    expect(deleted).toEqual(["run-1"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.inProcess).toEqual(["eligibility"]);
  });
});
