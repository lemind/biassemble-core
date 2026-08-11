import type { GrounnelHistoryStore } from "../../src/persistence/grounnel-history-store.js";

/** Test double for the Postgres-backed history store (D023 §7 — best-effort, never on the critical path). */
export class NoopGrounnelHistoryStore implements GrounnelHistoryStore {
  async createRun(): Promise<void> {}
  async updateRun(): Promise<void> {}
  async createClaim(): Promise<void> {}
}
