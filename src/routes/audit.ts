import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AuditRequestSchema, ClaimSchema, type Claim as ApiClaim } from "../contracts/audit.schemas.js";
import { authHook } from "../lib/auth.js";
import { logger } from "../observability/logger.js";
import { computeAuditInputRef } from "../lib/hash.js";
import { generateAuditId } from "../lib/audit-identifiers.js";
import { computeScores } from "../orchestrators/audit/scores.js";
import type { AuditStore } from "../persistence/audit-store.js";
import type { Claim as DbClaim } from "../db/schema.js";

const MODULE = "routes-audit";
const RETRY_AFTER_SECONDS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuditEnqueuer {
  enqueue(data: {
    auditId: string;
    outputText: string;
    sources: Array<{ id: string; name: string; text: string }>;
    task: string | undefined;
    threshold: number;
    maxClaims: number;
  }): Promise<void>;
}

function toApiClaim(c: DbClaim): ApiClaim {
  return ClaimSchema.parse({
    claim_id: c.claimId,
    type: c.type,
    claim: c.claimText,
    excerpt: c.excerpt,
    locations: c.locations,
    period: c.period,
    derived: c.derived,
    retrieval_status: c.retrievalStatus,
    passages_retrieved_count: c.passagesRetrievedCount,
    verdict: c.verdict,
    evidence: c.evidence,
    source_refs: c.sourceRefs,
    synthesized: c.synthesized,
    confidence: c.confidence,
    note: c.note,
  });
}

export function registerAuditRoutes(
  server: FastifyInstance,
  services: {
    auditStore: AuditStore;
    enqueuer: AuditEnqueuer;
    modelName: string;
    extractPromptVersion: string;
    verifyPromptVersion: string;
    pipelineCodeVersion: string;
  }
) {
  server.post("/audit", { preHandler: [authHook] }, async (request, reply) => {
    try {
      // No client-supplied `mode` — the route is the mode boundary
      // (contracts/audit-endpoint.md, D018 §1, resolved on review).
      const body = AuditRequestSchema.parse(request.body);
      const auditId = generateAuditId();
      const inputRef = computeAuditInputRef(body.output_text, body.sources, body.task);

      await services.auditStore.createAudit({
        auditId,
        inputRef,
        domain: body.domain,
        threshold: body.options.threshold,
      });

      try {
        await services.enqueuer.enqueue({
          auditId,
          outputText: body.output_text,
          sources: body.sources,
          task: body.task,
          threshold: body.options.threshold,
          maxClaims: body.options.maxClaims,
        });
      } catch (enqueueError) {
        // The audits row already exists (status="running") — if enqueue
        // fails, it must not be left stuck at "running" forever with no way
        // to ever discover or resolve it. Mark it failed the same way a
        // pipeline-stage failure would.
        await services.auditStore.updateAudit(auditId, {
          status: "failed",
          failedStage: "extract",
          errorSummary: `Failed to enqueue audit run: ${(enqueueError as Error).message ?? String(enqueueError)}`,
          completedAt: new Date(),
        });
        throw enqueueError;
      }

      return reply.status(202).send({ audit_id: auditId, status: "running" });
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "Invalid request body", details: error.issues });
      }
      logger.error({ module: MODULE, operation: "POST /audit", error, requestId: request.id }, "Audit submission failed");
      return reply.status(502).send({ error: "Audit submission failed" });
    }
  });

  server.get("/audit/:auditId", { preHandler: [authHook] }, async (request, reply) => {
    const { auditId } = request.params as { auditId: string };
    if (!UUID_RE.test(auditId)) {
      return reply.status(400).send({ error: "invalid audit_id" });
    }

    const audit = await services.auditStore.getAudit(auditId);
    if (!audit) {
      return reply.status(404).send({ error: "not_found" });
    }

    if (audit.status === "running") {
      reply.header("Retry-After", String(RETRY_AFTER_SECONDS));
      return reply.status(202).send({ audit_id: auditId, status: "running" });
    }

    if (audit.status === "failed") {
      // 200, not 4xx/5xx — the GET request itself succeeded (contracts/audit-endpoint.md).
      return reply.status(200).send({
        audit_id: auditId,
        status: "failed",
        failed_stage: audit.failedStage,
        error_summary: audit.errorSummary,
      });
    }

    // complete — read persisted records only, never recompute (append-only rule).
    const [dbClaims, claimPassages] = await Promise.all([
      services.auditStore.getClaimsByAudit(auditId),
      services.auditStore.getClaimPassagesByAudit(auditId),
    ]);
    const scores = computeScores(dbClaims, claimPassages);

    return reply.status(200).send({
      audit_id: auditId,
      status: "complete",
      input_ref: audit.inputRef,
      domain: audit.domain,
      claims: dbClaims.map(toApiClaim),
      truncated: audit.truncated,
      rates: { findings_count: 0, gated_out_count: 0 }, // bias-module findings, D018 §3, out of scope — always 0 here
      scores,
      gated_candidates: [],
      bias_flags: [],
      meta: {
        prompt_revision: { extract: audit.promptRevisionExtract ?? "", verify: audit.promptRevisionVerify ?? "" },
        model_revision: { extract: audit.modelRevisionExtract ?? "", verify: audit.modelRevisionVerify ?? "" },
        corpus_id: audit.corpusId ?? "",
        retrieval_provider: audit.retrievalProvider ?? "",
        threshold: audit.threshold ?? 0,
        pipeline_code_version: audit.pipelineCodeVersion ?? services.pipelineCodeVersion,
      },
    });
  });
}
