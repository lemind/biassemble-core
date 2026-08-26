import type { GrounnelHistoryStore } from "../../src/persistence/grounnel-history-store.js";

type Calls<T extends keyof GrounnelHistoryStore> = Array<Parameters<GrounnelHistoryStore[T]>[0]>;

/** Recording test double — unlike NoopGrounnelHistoryStore, captures what it was called with. */
export class FakeGrounnelHistoryStore implements GrounnelHistoryStore {
  createRunCalls: Calls<"createRun"> = [];
  updateRunCalls: Array<{ runId: string; data: Parameters<GrounnelHistoryStore["updateRun"]>[1] }> = [];
  createClaimCalls: Calls<"createClaim"> = [];
  // Injects a write failure — review finding regression test needs a real throw from the
  // background eligibility-write path, not just the LLM classifier's own fail-open path.
  failCreateClaim = false;

  async createRun(data: Parameters<GrounnelHistoryStore["createRun"]>[0]): Promise<void> {
    this.createRunCalls.push(data);
  }
  async updateRun(runId: string, data: Parameters<GrounnelHistoryStore["updateRun"]>[1]): Promise<void> {
    this.updateRunCalls.push({ runId, data });
  }
  async createClaim(data: Parameters<GrounnelHistoryStore["createClaim"]>[0]): Promise<void> {
    if (this.failCreateClaim) throw new Error("simulated transient write failure");
    this.createClaimCalls.push(data);
  }
}
