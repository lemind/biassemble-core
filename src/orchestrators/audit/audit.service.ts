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

/** Orchestrates EXTRACT->RETRIEVE->VERIFY->GATE (T020). `audits` row must already exist (status=running) before run() is called. */
export class AuditService {
  constructor(
    private extractService: ExtractService,
    private verifyService: VerifyService,
    private gateService: GateService,
    private auditStore: AuditStore,
    private pipelineCodeVersion: string,
    // Optional (T040) — per-audit cost telemetry; existing callers/tests don't need to wire it up.
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
          // All retrieved passages go to VERIFY — no separate narrowing step.
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

    await this.commitTerminalUpdate(auditId, {
      status: "complete",
      completedAt: new Date(),
      pipelineCodeVersion: this.pipelineCodeVersion,
    });

    await this.logCostSummary(auditId);
  }

  /** Terminal transition, shared by success + markFailed (T035 immutability guard). AuditImmutableError = benign race, swallowed; anything else rethrows. */
  private async commitTerminalUpdate(auditId: string, data: Parameters<AuditStore["updateAudit"]>[1]): Promise<void> {
    try {
      await this.auditStore.updateAudit(auditId, data);
    } catch (err) {
      if (err instanceof AuditImmutableError) {
        logger.info(
          { module: MODULE, operation: "commitTerminalUpdate", auditId, err },
          "Audit already terminal — a concurrent or redelivered run already completed/failed it first"
        );
        return;
      }
      logger.error({ module: MODULE, operation: "commitTerminalUpdate", auditId, err }, "Failed to persist terminal audit state");
      throw err;
    }
  }

  /** T040 — per-audit cost telemetry, logged only. Best effort: a failure here must never affect the already-committed audit outcome. */
  private async logCostSummary(auditId: string): Promise<void> {
    if (!this.llmCallStore) return;
    try {
      // Prefer the projected aggregate (no full rawResponse/parsedOutput
      // rows fetched just to sum 3 integers) when the store provides it;
      // fall back to summing full rows for any LlmCallStore implementation
      // that doesn't (found on review — the original version always did
      // the wasteful full-row fetch).
      const { count: callCount, inputTokens, outputTokens, totalTokens } = this.llmCallStore.getCallCostsBySession
        ? await this.llmCallStore.getCallCostsBySession(auditId)
        : await this.llmCallStore.getCallsBySession(auditId).then((calls) => ({
            count: calls.length,
            inputTokens: calls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
            outputTokens: calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
            totalTokens: calls.reduce((sum, c) => sum + (c.totalTokens ?? 0), 0),
          }));
      logger.info(
        { module: MODULE, operation: "logCostSummary", auditId, callCount, inputTokens, outputTokens, totalTokens },
        "Audit cost summary"
      );
    } catch (err) {
      logger.warn({ module: MODULE, operation: "logCostSummary", auditId, err }, "Failed to compute audit cost summary — non-fatal");
    }
  }

  private async markFailed(auditId: string, stage: Stage, err: unknown): Promise<void> {
    const message = (err as Error)?.message ?? String(err);
    logger.error({ module: MODULE, operation: "markFailed", auditId, stage, err }, "Audit failed");
    // commitTerminalUpdate rethrows on any failure other than the benign
    // already-terminal case — intentionally left uncaught here so a genuine
    // failure to persist this audit's failure state surfaces to run()'s
    // caller instead of leaving the row stuck at "running" with no trace.
    await this.commitTerminalUpdate(auditId, {
      status: "failed",
      failedStage: stage,
      errorSummary: message,
      completedAt: new Date(),
    });
  }
}
