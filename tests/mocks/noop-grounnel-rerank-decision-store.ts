import type { GrounnelRerankDecisionStore } from "../../src/persistence/grounnel-rerank-decision-store.js";

/** Test double for the Postgres-backed rerank-decision store (D026 §19 — best-effort, never on the critical path). */
export class NoopGrounnelRerankDecisionStore implements GrounnelRerankDecisionStore {
  recordRerankDecisions(): void {}
}
