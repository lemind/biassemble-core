import { AuditImmutableError, type AuditStore } from "../../src/persistence/audit-store.js";
import type { Audit, Claim, SourcePassage } from "../../src/db/schema.js";

/**
 * In-memory AuditStore for tests — no real database. Mirrors the real
 * DrizzleAuditStore's T035 immutability guard (db/queries.ts) so tests
 * exercise the same invariant against this port's contract, not just the
 * Drizzle-backed implementation.
 */
export class MockAuditStore implements AuditStore {
  audits = new Map<string, Audit>();
  claims = new Map<string, Claim>();
  passages = new Map<string, SourcePassage>();
  claimPassageRows: Array<{
    claimId: string;
    passageId: string;
    retrievalRank: number;
    retrievalScore: number;
    selectedForVerification: boolean;
  }> = [];

  async createAudit(data: { auditId: string; inputRef: string; domain: "general" | "finance" | "legal" | "healthcare"; threshold: number }): Promise<void> {
    this.audits.set(data.auditId, {
      auditId: data.auditId,
      inputRef: data.inputRef,
      domain: data.domain,
      status: "running",
      failedStage: null,
      errorSummary: null,
      createdAt: new Date(),
      completedAt: null,
      promptRevisionExtract: null,
      promptRevisionVerify: null,
      modelRevisionExtract: null,
      modelRevisionVerify: null,
      corpusId: null,
      retrievalProvider: null,
      threshold: data.threshold,
      pipelineCodeVersion: null,
      truncated: false,
    } as Audit);
  }

  async updateAudit(auditId: string, data: Partial<Audit>): Promise<void> {
    const existing = this.audits.get(auditId);
    if (!existing) throw new Error(`updateAudit: no audit ${auditId}`);
    this.assertAuditMutable(auditId);
    this.audits.set(auditId, { ...existing, ...data });
  }

  async getAudit(auditId: string): Promise<Audit | null> {
    return this.audits.get(auditId) ?? null;
  }

  /**
   * Mirrors db/queries.ts's TERMINAL_AUDIT_STATUSES — complete OR failed are
   * both permanent, append-only states (data-model.md's Audit entity), not
   * just complete. Factored into one helper (found on review: the four call
   * sites below each re-inlined this check instead of sharing it).
   */
  private assertAuditMutable(auditId: string): void {
    const status = this.audits.get(auditId)?.status;
    if (status === "complete" || status === "failed") {
      throw new AuditImmutableError(auditId);
    }
  }

  private assertClaimsAuditMutable(claimId: string): void {
    const claim = this.claims.get(claimId);
    if (claim) this.assertAuditMutable(claim.auditId);
  }

  async createClaims(
    rows: Array<{
      claimId: string;
      auditId: string;
      type: "numeric" | "entity" | "attribution" | "causal" | "derived";
      claimText: string;
      excerpt: string;
      locations: string[];
      period: string | null;
      derived: boolean;
    }>
  ): Promise<Claim[]> {
    if (rows.length > 0) this.assertAuditMutable(rows[0]!.auditId);
    const inserted: Claim[] = [];
    for (const row of rows) {
      const claim: Claim = {
        ...row,
        passagesRetrievedCount: 0,
        retrievalStatus: null,
        verdict: null,
        evidence: null,
        sourceRefs: null,
        synthesized: null,
        confidence: null,
        note: null,
      } as Claim;
      this.claims.set(row.claimId, claim);
      inserted.push(claim);
    }
    return inserted;
  }

  async updateClaimRetrieval(claimId: string, data: { passagesRetrievedCount: number; retrievalStatus: "ok" | "error" }): Promise<void> {
    const existing = this.claims.get(claimId);
    if (!existing) throw new Error(`updateClaimRetrieval: no claim ${claimId}`);
    this.assertClaimsAuditMutable(claimId);
    this.claims.set(claimId, { ...existing, ...data });
  }

  async updateClaimVerdict(
    claimId: string,
    data: {
      verdict: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable";
      evidence: string[] | null;
      sourceRefs: string[];
      synthesized: boolean;
      confidence: number;
      note: string | null;
    }
  ): Promise<void> {
    const existing = this.claims.get(claimId);
    if (!existing) throw new Error(`updateClaimVerdict: no claim ${claimId}`);
    this.assertClaimsAuditMutable(claimId);
    this.claims.set(claimId, { ...existing, ...data });
  }

  async getClaimsByAudit(auditId: string): Promise<Claim[]> {
    return [...this.claims.values()].filter((c) => c.auditId === auditId);
  }

  async createSourcePassages(
    rows: Array<{ passageId: string; auditId: string; docId: string; location: string | null; text: string }>
  ): Promise<SourcePassage[]> {
    if (rows.length > 0) this.assertAuditMutable(rows[0]!.auditId);
    const inserted: SourcePassage[] = [];
    for (const row of rows) {
      this.passages.set(row.passageId, row as SourcePassage);
      inserted.push(row as SourcePassage);
    }
    return inserted;
  }

  async createClaimPassages(
    rows: Array<{ claimId: string; passageId: string; retrievalRank: number; retrievalScore: number; selectedForVerification: boolean }>
  ): Promise<void> {
    if (rows.length > 0) this.assertClaimsAuditMutable(rows[0]!.claimId);
    this.claimPassageRows.push(...rows);
  }

  async getClaimPassagesByAudit(
    auditId: string
  ): Promise<Array<{ claimId: string; passageId: string; retrievalScore: number; selectedForVerification: boolean }>> {
    const claimIds = new Set([...this.claims.values()].filter((c) => c.auditId === auditId).map((c) => c.claimId));
    return this.claimPassageRows
      .filter((r) => claimIds.has(r.claimId))
      .map(({ claimId, passageId, retrievalScore, selectedForVerification }) => ({ claimId, passageId, retrievalScore, selectedForVerification }));
  }

  reset(): void {
    this.audits.clear();
    this.claims.clear();
    this.passages.clear();
    this.claimPassageRows = [];
  }
}
