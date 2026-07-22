import { logger } from "../../observability/logger.js";
import { CorpusClient, type AuditSourceInput, type RetrievedPassage } from "../../rag/corpus-client.js";
import { computeCorpusId } from "../../lib/hash.js";
import type { ExtractService } from "./extract.service.js";
import type { VerifyService, ClaimWithPassages } from "./verify.service.js";
import type { GateService } from "./gate.service.js";
import type { AuditStore } from "../../persistence/audit-store.js";
import type { Claim } from "../../db/schema.js";

const MODULE = "audit-service";
const RETRIEVAL_TOP_K = 5;
const RETRIEVAL_PROVIDER = "stub-lexical";

export interface AuditRunRequest {
  outputText: string;
  sources: AuditSourceInput[];
  task: string | undefined;
  threshold: number;
  maxClaims: number;
}

type Stage = "extract" | "retrieve" | "verify" | "gate";

/**
 * Orchestrates EXTRACT → RETRIEVE → VERIFY → GATE (T020). The `audits` row
 * (status="running") must already exist before `run()` is called — created
 * synchronously by the route handler before returning 202 (schema.ts's
 * ordering note) — this method only ever transitions it to complete/failed.
 */
export class AuditService {
  constructor(
    private extractService: ExtractService,
    private verifyService: VerifyService,
    private gateService: GateService,
    private auditStore: AuditStore,
    private pipelineCodeVersion: string
  ) {}

  async run(auditId: string, request: AuditRunRequest): Promise<void> {
    let claims: Claim[];
    try {
      const extracted = await this.extractService.run(auditId, request.outputText, request.task, request.maxClaims);
      claims = extracted.claims;
    } catch (err) {
      await this.markFailed(auditId, "extract", err);
      return;
    }

    let corpusClient: CorpusClient;
    try {
      corpusClient = new CorpusClient(request.sources);
      const allPassages = corpusClient.getAllPassages();
      if (allPassages.length > 0) {
        await this.auditStore.createSourcePassages(
          allPassages.map((p) => ({ passageId: p.passageId, auditId, docId: p.docId, location: p.location, text: p.text }))
        );
      }
      await this.auditStore.updateAudit(auditId, {
        corpusId: computeCorpusId(request.sources),
        retrievalProvider: RETRIEVAL_PROVIDER,
      });
    } catch (err) {
      await this.markFailed(auditId, "retrieve", err);
      return;
    }

    const itemsForVerify: ClaimWithPassages[] = [];
    for (const claim of claims) {
      let retrieved: RetrievedPassage[] = [];
      let status: "ok" | "error" = "ok";
      try {
        retrieved = corpusClient.retrieveForClaim(claim.claimText, RETRIEVAL_TOP_K);
      } catch (err) {
        status = "error";
        logger.warn({ module: MODULE, operation: "run", auditId, claimId: claim.claimId, err }, "Retrieval failed for claim");
      }

      try {
        await this.auditStore.updateClaimRetrieval(claim.claimId, { passagesRetrievedCount: retrieved.length, retrievalStatus: status });
        if (retrieved.length > 0) {
          // All retrieved passages are passed to VERIFY in this version — no
          // separate "retrieve more than we verify" narrowing step.
          await this.auditStore.createClaimPassages(
            retrieved.map((p) => ({
              claimId: claim.claimId,
              passageId: p.passageId,
              retrievalRank: p.rank,
              retrievalScore: p.score,
              selectedForVerification: true,
            }))
          );
        }
      } catch (err) {
        await this.markFailed(auditId, "retrieve", err);
        return;
      }

      itemsForVerify.push({
        claim: { ...claim, passagesRetrievedCount: retrieved.length, retrievalStatus: status },
        passages: retrieved,
      });
    }

    try {
      await this.verifyService.run(auditId, itemsForVerify, request.threshold);
    } catch (err) {
      await this.markFailed(auditId, "verify", err);
      return;
    }

    try {
      await this.gateService.run(auditId, request.threshold);
    } catch (err) {
      await this.markFailed(auditId, "gate", err);
      return;
    }

    await this.auditStore.updateAudit(auditId, {
      status: "complete",
      completedAt: new Date(),
      pipelineCodeVersion: this.pipelineCodeVersion,
    });
  }

  private async markFailed(auditId: string, stage: Stage, err: unknown): Promise<void> {
    const message = (err as Error)?.message ?? String(err);
    logger.error({ module: MODULE, operation: "markFailed", auditId, stage, err }, "Audit failed");
    await this.auditStore.updateAudit(auditId, {
      status: "failed",
      failedStage: stage,
      errorSummary: message,
      completedAt: new Date(),
    });
  }
}
