import { logger } from "../../observability/logger.js";
import { env } from "../../lib/env.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { executeAndRecordLlmCall } from "../../observability/llm-call-recorder.js";
import { isSuspectedInjection, InjectionSuspectedError } from "./injection-guard.js";
import { RateLimitError } from "../../providers/gemini.js";
import { VERIFY_RESPONSE_KEYS, VerifyResponseSchema, type VerifyResponse } from "../../contracts/audit-internal.schemas.js";
import {
  reconcileNumericVerdict,
  reconcileTemporalVerdict,
  reconcileVerdictNoteConsistency,
  reconcileDefinedTermVerdict,
  reconcileMagnitudeClaim,
} from "./verify-reconcilers.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { LlmCallStore } from "../../persistence/ports.js";
import type { AuditStore } from "../../persistence/audit-store.js";
import type { Claim } from "../../db/schema.js";
import type { RetrievedPassage } from "../../rag/corpus-client.js";

const MODULE = "verify-service";
/** Upper bound only — a small audit's last batch may be smaller. Lowered 10->8: batch size, not verdict logic, was why VERDICT/NOTE CONSISTENCY got ignored at ~10 claims/call. D018 §2.3. */
const BATCH_MAX = 8;
/** VERIFY responses are intermittently unparseable (~1 live run in 5); retry before degrading. D018 §5.10. */
const VERIFY_SCHEMA_ATTEMPTS = 3;

export interface ClaimWithPassages {
  claim: Claim;
  passages: RetrievedPassage[];
}

/** Groups claims into batches of at most BATCH_MAX, grouping by the doc_id their passages share (research.md §6). */
export function batchClaims(items: ClaimWithPassages[]): ClaimWithPassages[][] {
  const byDoc = new Map<string, ClaimWithPassages[]>();
  const noPassages: ClaimWithPassages[] = [];
  for (const item of items) {
    const primaryDoc = item.passages[0]?.docId;
    if (!primaryDoc) {
      noPassages.push(item);
      continue;
    }
    const list = byDoc.get(primaryDoc) ?? [];
    list.push(item);
    byDoc.set(primaryDoc, list);
  }
  const batches: ClaimWithPassages[][] = [];
  for (const group of [...byDoc.values(), noPassages]) {
    for (let i = 0; i < group.length; i += BATCH_MAX) {
      batches.push(group.slice(i, i + BATCH_MAX));
    }
  }
  return batches.filter((b) => b.length > 0);
}

export class VerifyService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private modelName: string,
    private llmCallStore: LlmCallStore,
    private auditStore: AuditStore
  ) {}

  async run(auditId: string, items: ClaimWithPassages[], threshold: number): Promise<void> {
    const batches = batchClaims(items);
    const promptVersion = this.prompts.getAuditVersion("verify");
    const providerId = this.provider.mode;

    // Stamped even with zero claims — schema.ts requires non-null once status="complete".
    await this.auditStore.updateAudit(auditId, {
      promptRevisionVerify: promptVersion,
      modelRevisionVerify: this.modelName,
    });

    for (const batch of batches) {
      await this.runBatch(auditId, batch, threshold, promptVersion, providerId);
    }
  }

  private async runBatch(
    auditId: string,
    batch: ClaimWithPassages[],
    threshold: number,
    promptVersion: string,
    providerId: string
  ): Promise<void> {
    const claimsBatch = batch.map(({ claim, passages }) => ({
      claim_id: claim.claimId,
      type: claim.type,
      claim: claim.claimText,
      period: claim.period,
      derived: claim.derived,
      passages: passages.map((p) => p.passageId),
    }));
    const retrievedPassages = [...new Map(batch.flatMap((b) => b.passages).map((p) => [p.passageId, p])).values()].map((p) => ({
      passage_id: p.passageId,
      doc_id: p.docId,
      location: p.location,
      text: p.text,
      retrieval_score: p.score,
    }));

    const system = this.prompts.render("audit-verify", {
      claims_batch: JSON.stringify(claimsBatch),
      retrieved_passages: JSON.stringify(retrievedPassages),
      threshold: String(threshold),
    });
    const user = "Return the JSON now.";

    // A malformed VERIFY response used to fail the whole audit — observed ~1 run in 5 live, and only a
    // human relaunch recovered it. Retried here, then degraded per claim. D018 §5.10.
    // Found on review (2026-08-02): the provider CALL itself was outside this try/catch, so the actual
    // live failures (a timeout abort, a malformed-JSON throw from the provider) never reached the retry
    // at all — they propagated straight past it and failed the whole audit. The call is now inside.
    let parsed: VerifyResponse | null = null;
    let lastSchemaError: string | null = null;
    for (let attempt = 1; attempt <= VERIFY_SCHEMA_ATTEMPTS; attempt++) {
      let raw: unknown;
      let llmCallId: string | null = null;
      try {
        ({ result: raw, llmCallId } = await executeAndRecordLlmCall(
          // temperature:0 for reproducibility — see extract.service.ts's matching comment.
          () => this.provider.completeJson<unknown>({ system, user, options: { temperature: 0, timeoutMs: env.AUDIT_LLM_TIMEOUT_MS } }),
          // sessionId is auditId, not null (T040) — see extract.service.ts.
          { sessionId: auditId, stage: "verify", callType: "primary", provider: providerId, model: this.modelName, promptVersion },
          this.llmCallStore
        ));
      } catch (err) {
        // Rate limits fail again immediately — retrying wastes the remaining attempts. Everything else
        // (timeout, provider-side malformed JSON, network blips) is exactly what this loop is for.
        if (err instanceof RateLimitError) throw err;
        lastSchemaError = (err as Error).message;
        logger.warn({ module: MODULE, operation: "runBatch", auditId, attempt, err }, "VERIFY provider call failed — retrying batch");
        continue;
      }

      // Injection stays a hard stop and is never retried (D018 §2.3) — this is why the shared
      // withRetry helper, which retries everything but rate limits, is not used here.
      if (isSuspectedInjection(JSON.stringify(raw), VERIFY_RESPONSE_KEYS)) {
        logger.error({ module: MODULE, operation: "runBatch", auditId, raw }, "VERIFY response flagged as injection-suspected — hard stop, not repaired");
        if (llmCallId) {
          await this.llmCallStore.updateFailure(llmCallId, "schema_validation", "injection-suspected response").catch(() => {});
        }
        throw new InjectionSuspectedError("verify");
      }

      try {
        const { result } = await repairWithFallback(JSON.stringify(raw), VerifyResponseSchema, null);
        // repair.ts nulls `results` as a whole unit on partial validation failure — must fail cleanly here, not crash on `for...of null`.
        if (result.results === null || result.results === undefined) {
          throw new Error("VERIFY response failed schema validation: results could not be parsed (see repair warnings)");
        }
        if (llmCallId) await this.llmCallStore.updateParsedOutput(llmCallId, result).catch(() => {});
        parsed = result;
        break;
      } catch (err) {
        lastSchemaError = (err as Error).message;
        if (llmCallId) {
          await this.llmCallStore.updateFailure(llmCallId, "schema_validation", lastSchemaError).catch(() => {});
        }
        logger.warn({ module: MODULE, operation: "runBatch", auditId, attempt, err }, "VERIFY response unparseable — retrying batch");
      }
    }

    // Still unparseable: degrade this batch to unverifiable rather than failing the whole audit, so the
    // customer gets a report naming the gap instead of a hard error. D018 §5.10.
    if (!parsed) {
      logger.error({ module: MODULE, operation: "runBatch", auditId, attempts: VERIFY_SCHEMA_ATTEMPTS, lastSchemaError }, "VERIFY batch failed after retries — degrading to unverifiable");
      for (const { claim } of batch) {
        await this.auditStore.updateClaimVerdict(claim.claimId, {
          verdict: "unverifiable",
          evidence: null,
          sourceRefs: [],
          synthesized: false,
          confidence: 0,
          note: `[forced to unverifiable: VERIFY failed after ${VERIFY_SCHEMA_ATTEMPTS} attempts — ${lastSchemaError ?? "unknown"}]`,
        });
      }
      return;
    }

    const byClaimId = new Map(batch.map((b) => [b.claim.claimId, b.claim]));
    const passagesByClaimId = new Map(batch.map((b) => [b.claim.claimId, b.passages]));
    const answeredClaimIds = new Set<string>();
    for (const result of parsed.results) {
      const claim = byClaimId.get(result.claim_id);
      if (!claim) continue; // model echoed an id we didn't send — ignore, don't persist
      answeredClaimIds.add(claim.claimId);

      // Retrieval error must never read as "unsupported" (data-model.md).
      let verdict = result.verdict;
      let note = result.note;
      let confidence = result.confidence;
      let evidence = result.evidence;
      let sourceRefs = result.source_refs;
      if (claim.retrievalStatus === "error" && verdict === "unsupported") {
        verdict = "unverifiable";
        note = `${note ?? ""} [forced to unverifiable: retrieval_status=error, not a genuine absence-of-evidence signal]`.trim();
      } else {
        // Reconciliation chain order, confidence threading, and evidence-override handling: D018 §5.
        const consistencyReconciled = reconcileVerdictNoteConsistency({ verdict, evidence: result.evidence, note, confidence });
        const numericReconciled = reconcileNumericVerdict(
          claim,
          {
            verdict: consistencyReconciled.verdict,
            evidence: result.evidence,
            note: consistencyReconciled.note,
            confidence: consistencyReconciled.confidence,
          },
          passagesByClaimId.get(claim.claimId) ?? []
        );
        if (numericReconciled.evidence) evidence = numericReconciled.evidence;
        if (numericReconciled.sourceRefs) sourceRefs = numericReconciled.sourceRefs;
        const temporalReconciled = reconcileTemporalVerdict(
          claim,
          {
            verdict: numericReconciled.verdict,
            evidence: result.evidence,
            note: numericReconciled.note,
            confidence: numericReconciled.confidence,
          },
          passagesByClaimId.get(claim.claimId) ?? []
        );
        if (temporalReconciled.evidence) evidence = temporalReconciled.evidence;
        if (temporalReconciled.sourceRefs) sourceRefs = temporalReconciled.sourceRefs;
        const magnitudeReconciled = reconcileMagnitudeClaim(claim, {
          verdict: temporalReconciled.verdict,
          evidence: result.evidence,
          note: temporalReconciled.note,
          confidence: temporalReconciled.confidence,
        });
        const definedTermReconciled = reconcileDefinedTermVerdict(
          claim,
          {
            verdict: magnitudeReconciled.verdict,
            evidence: result.evidence,
            note: magnitudeReconciled.note,
            confidence: magnitudeReconciled.confidence,
          },
          passagesByClaimId.get(claim.claimId) ?? []
        );
        if (definedTermReconciled.evidence) evidence = definedTermReconciled.evidence;
        if (definedTermReconciled.sourceRefs) sourceRefs = definedTermReconciled.sourceRefs;
        verdict = definedTermReconciled.verdict as typeof verdict;
        note = definedTermReconciled.note;
        confidence = definedTermReconciled.confidence;
      }

      // FR-020/A6: confidence never blended with retrieval_score.
      await this.auditStore.updateClaimVerdict(claim.claimId, {
        verdict: verdict as "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable",
        evidence,
        sourceRefs,
        synthesized: result.synthesized,
        confidence,
        note,
      });
    }

    // Claim sent but absent from VERIFY's results (truncated response) — force unverifiable, don't leave verdict=null.
    for (const { claim } of batch) {
      if (answeredClaimIds.has(claim.claimId)) continue;
      logger.warn(
        { module: MODULE, operation: "runBatch", auditId, claimId: claim.claimId },
        "Claim sent to VERIFY but absent from its response — forcing unverifiable"
      );
      await this.auditStore.updateClaimVerdict(claim.claimId, {
        verdict: "unverifiable",
        evidence: null,
        sourceRefs: [],
        synthesized: false,
        confidence: 0,
        note: "[forced to unverifiable: VERIFY's response did not include a result for this claim]",
      });
    }
  }
}
