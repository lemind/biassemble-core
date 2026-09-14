import type { GrounnelHistoryStore } from "../../src/persistence/grounnel-history-store.js";
import type { SharedAssessment } from "../../src/contracts/grounnel.schemas.js";

/** Test double for the Postgres-backed history store (D023 §7 — best-effort, never on the critical path). */
export class NoopGrounnelHistoryStore implements GrounnelHistoryStore {
  /** Seeded by token, so a test can stand up a shared assessment without a database. */
  constructor(private assessments: Map<string, SharedAssessment> = new Map()) {}
  async createRun(): Promise<void> {}
  async updateRun(): Promise<void> {}
  async createClaim(): Promise<void> {}
  async readAssessmentByToken(shareToken: string): Promise<SharedAssessment | null> {
    return this.assessments.get(shareToken) ?? null;
  }
}
