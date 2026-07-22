import {
  insertAudit as dbInsertAudit,
  updateAudit as dbUpdateAudit,
  getAudit as dbGetAudit,
  insertClaims as dbInsertClaims,
  updateClaimRetrieval as dbUpdateClaimRetrieval,
  updateClaimVerdict as dbUpdateClaimVerdict,
  getClaimsByAudit as dbGetClaimsByAudit,
  insertSourcePassages as dbInsertSourcePassages,
  insertClaimPassages as dbInsertClaimPassages,
  getClaimPassagesByAudit as dbGetClaimPassagesByAudit,
} from "../db/queries";
import type { Audit, Claim, SourcePassage } from "../db/schema";

// T035 (data-model.md/Phase 5): re-exported so callers that only import from
// this port (not db/queries.ts directly) can still catch it. Defined in
// db/queries.ts, not here, to avoid a circular import — this file already
// imports the db*() functions that throw it.
export { AuditImmutableError } from "../db/queries";

export interface AuditStore {
  createAudit(data: {
    auditId: string;
    inputRef: string;
    domain: "general" | "finance" | "legal" | "healthcare";
    threshold: number;
  }): Promise<void>;

  updateAudit(
    auditId: string,
    data: Partial<{
      status: "running" | "complete" | "failed";
      failedStage: "extract" | "retrieve" | "verify" | "gate";
      errorSummary: string;
      completedAt: Date;
      promptRevisionExtract: string;
      promptRevisionVerify: string;
      modelRevisionExtract: string;
      modelRevisionVerify: string;
      corpusId: string;
      retrievalProvider: string;
      pipelineCodeVersion: string;
      truncated: boolean;
    }>
  ): Promise<void>;

  getAudit(auditId: string): Promise<Audit | null>;

  createClaims(
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
  ): Promise<Claim[]>;

  updateClaimRetrieval(
    claimId: string,
    data: { passagesRetrievedCount: number; retrievalStatus: "ok" | "error" }
  ): Promise<void>;

  updateClaimVerdict(
    claimId: string,
    data: {
      verdict: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable";
      evidence: string[] | null;
      sourceRefs: string[];
      synthesized: boolean;
      confidence: number;
      note: string | null;
    }
  ): Promise<void>;

  getClaimsByAudit(auditId: string): Promise<Claim[]>;

  createSourcePassages(
    rows: Array<{ passageId: string; auditId: string; docId: string; location: string | null; text: string }>
  ): Promise<SourcePassage[]>;

  createClaimPassages(
    rows: Array<{
      claimId: string;
      passageId: string;
      retrievalRank: number;
      retrievalScore: number;
      selectedForVerification: boolean;
    }>
  ): Promise<void>;

  getClaimPassagesByAudit(
    auditId: string
  ): Promise<Array<{ claimId: string; passageId: string; retrievalScore: number; selectedForVerification: boolean }>>;
}

export class DrizzleAuditStore implements AuditStore {
  async createAudit(data: {
    auditId: string;
    inputRef: string;
    domain: "general" | "finance" | "legal" | "healthcare";
    threshold: number;
  }): Promise<void> {
    await dbInsertAudit(data);
  }

  async updateAudit(auditId: string, data: Parameters<AuditStore["updateAudit"]>[1]): Promise<void> {
    await dbUpdateAudit(auditId, data);
  }

  async getAudit(auditId: string): Promise<Audit | null> {
    return await dbGetAudit(auditId);
  }

  async createClaims(rows: Parameters<AuditStore["createClaims"]>[0]): Promise<Claim[]> {
    return await dbInsertClaims(rows);
  }

  async updateClaimRetrieval(
    claimId: string,
    data: { passagesRetrievedCount: number; retrievalStatus: "ok" | "error" }
  ): Promise<void> {
    await dbUpdateClaimRetrieval(claimId, data);
  }

  async updateClaimVerdict(claimId: string, data: Parameters<AuditStore["updateClaimVerdict"]>[1]): Promise<void> {
    await dbUpdateClaimVerdict(claimId, data);
  }

  async getClaimsByAudit(auditId: string): Promise<Claim[]> {
    return await dbGetClaimsByAudit(auditId);
  }

  async createSourcePassages(rows: Parameters<AuditStore["createSourcePassages"]>[0]): Promise<SourcePassage[]> {
    return await dbInsertSourcePassages(rows);
  }

  async createClaimPassages(rows: Parameters<AuditStore["createClaimPassages"]>[0]): Promise<void> {
    await dbInsertClaimPassages(rows);
  }

  async getClaimPassagesByAudit(
    auditId: string
  ): Promise<Array<{ claimId: string; passageId: string; retrievalScore: number; selectedForVerification: boolean }>> {
    return await dbGetClaimPassagesByAudit(auditId);
  }
}
