import { logger } from "../../observability/logger.js";
import { CorpusClient, type AuditSourceInput, type RetrievedPassage } from "../../rag/corpus-client.js";
import { computeCorpusId } from "../../lib/hash.js";
import type { ExtractService } from "./extract.service.js";
import type { VerifyService, ClaimWithPassages } from "./verify.service.js";
import type { GateService } from "./gate.service.js";
import { AuditImmutableError, type AuditStore } from "../../persistence/audit-store.js";
import type { Claim } from "../../db/schema.js";
import type { LlmCallStore } from "../../persistence/ports.js";

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
    private pipelineCodeVersion: string,
    // Optional (T040, nice-to-have): when provided, a per-audit token/call
    // cost summary is logged once the pipeline completes. Optional so
    // existing callers/tests that don't care about cost telemetry aren't
    // forced to wire it up.
    private llmCallStore?: LlmCallStore
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

    await this.logCostSummary(auditId);
  }

  /**
   * T040 (change-plan gap #4, D018 §2 Consequences) — per-audit token/call
   * cost telemetry, logged (not persisted as a new response field — no
   * governing document specifies one) once the pipeline completes. Best
   * effort: a failure here must never affect the audit's own outcome, which
   * has already been committed by the time this runs.
   */
  private async logCostSummary(auditId: string): Promise<void> {
    if (!this.llmCallStore) return;
    try {
      const calls = await this.llmCallStore.getCallsBySession(auditId);
      const totalTokens = calls.reduce((sum, c) => sum + (c.totalTokens ?? 0), 0);
      const inputTokens = calls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0);
      const outputTokens = calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0);
      logger.info(
        { module: MODULE, operation: "logCostSummary", auditId, callCount: calls.length, inputTokens, outputTokens, totalTokens },
        "Audit cost summary"
      );
    } catch (err) {
      logger.warn({ module: MODULE, operation: "logCostSummary", auditId, err }, "Failed to compute audit cost summary — non-fatal");
    }
  }

  private async markFailed(auditId: string, stage: Stage, err: unknown): Promise<void> {
    const message = (err as Error)?.message ?? String(err);
    logger.error({ module: MODULE, operation: "markFailed", auditId, stage, err }, "Audit failed");
    try {
      await this.auditStore.updateAudit(auditId, {
        status: "failed",
        failedStage: stage,
        errorSummary: message,
        completedAt: new Date(),
      });
    } catch (markFailedErr) {
      // T035's immutability guard (db/queries.ts) can itself be what `err`
      // is — e.g. a redelivered pipeline event hit the guard on an audit
      // that's already status="complete". In that case this update is
      // blocked too (nothing to transition — it's already terminal), and
      // that's fine: the original error is already logged above. Any other
      // failure here still needs to be visible, not silently dropped.
      if (!(markFailedErr instanceof AuditImmutableError)) {
        logger.error(
          { module: MODULE, operation: "markFailed", auditId, stage, markFailedErr },
          "Failed to persist audit failure — original error logged above only"
        );
      }
    }
  }
}
