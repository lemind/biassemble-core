import type { GrounnelRerankDecisionStore, RerankDecisionInput } from "../../src/persistence/grounnel-rerank-decision-store.js";

/** Recording test double — captures every recordRerankDecisions() invocation. */
export class FakeGrounnelRerankDecisionStore implements GrounnelRerankDecisionStore {
  calls: Array<{ runId: string; claimId: string; decisions: RerankDecisionInput[] }> = [];
  recordRerankDecisions(runId: string, claimId: string, decisions: RerankDecisionInput[]): void {
    this.calls.push({ runId, claimId, decisions });
  }
}
