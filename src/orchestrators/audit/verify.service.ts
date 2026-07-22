import { logger } from "../../observability/logger.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { executeAndRecordLlmCall } from "../../observability/llm-call-recorder.js";
import { isSuspectedInjection, InjectionSuspectedError } from "./injection-guard.js";
import { VERIFY_RESPONSE_KEYS, VerifyResponseSchema, type VerifyResponse } from "../../contracts/audit-internal.schemas.js";
import { compare } from "../../numbers/compare.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { LlmCallStore } from "../../persistence/ports.js";
import type { AuditStore } from "../../persistence/audit-store.js";
import type { Claim } from "../../db/schema.js";
import type { RetrievedPassage } from "../../rag/corpus-client.js";

const MODULE = "verify-service";
const BATCH_MIN = 5;
const BATCH_MAX = 10;

export interface ClaimWithPassages {
  claim: Claim;
  passages: RetrievedPassage[];
}

/**
 * Extracts the first number-like token from text (commas stripped). Used
 * only by the narrow compare.ts safety net below — not a general-purpose
 * claim/evidence parser.
 */
function firstNumber(text: string): number | null {
  const match = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Narrow, honest compare.ts integration (T018) — NOT a general free-text
 * comparability parser. What it does: when the LLM verdict is "contradicted"
 * for a claim with an evidence quote, extract the first number from the
 * claim and from the evidence, and — assuming the same unit/scale/period
 * (there is no reliable way to detect period/scope/unit from free text
 * without a real NLP pass, which no design doc specifies how to do; this is
 * a known, documented limitation, not silently ignored) — run them through
 * compare()'s rounding-tolerance logic. If the numbers are actually within
 * tolerance despite the LLM calling it a contradiction, downgrade to
 * "supported" — this directly enforces D018 §2.3's rounding rule
 * ("arithmetic happens in code, never in the LLM") as a code-level backstop
 * on the one sub-case that's cleanly checkable without deeper text parsing:
 * did the LLM overreact to a rounding difference. It intentionally does NOT
 * attempt to catch period/scope mismatches from free text — VERIFY's own
 * prompt instructions (T016) are the only defense against those right now.
 *
 * **Actual coverage is narrower than "numeric claims" — found on review**:
 * the unit inferred below is `"percent"` when the claim text contains `%`,
 * `null` otherwise — and `compare()` refuses to compare anything with a
 * `null` (unresolved) unit. So this backstop only ever engages for
 * percent-type claims; a dollar-amount rounding case (e.g. verify-004's
 * "$2.05" vs "$2.01" EPS claim) never reaches the tolerance check at all —
 * it's `unit: null` both sides, `compare()` returns `comparable: false`
 * immediately, and the LLM's own verdict passes through unchanged. That's
 * harmless for verify-004 specifically (it's *supposed* to stay
 * "contradicted"), but it means this function is not the general
 * dollar-amount safety net its own name implies — only a percent one.
 */
function reconcileContradictionWithTolerance(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null }
): { verdict: string; note: string | null } {
  const firstEvidence = result.evidence?.[0];
  if (result.verdict !== "contradicted" || !firstEvidence) {
    return { verdict: result.verdict, note: result.note };
  }
  const claimValue = firstNumber(claim.claimText);
  const evidenceValue = firstNumber(firstEvidence);
  if (claimValue === null || evidenceValue === null) {
    return { verdict: result.verdict, note: result.note }; // can't check — trust the LLM
  }
  const unit = /%/.test(claim.claimText) ? "percent" : null;
  const comparison = compare(
    { value: claimValue, unit, period: claim.period },
    { value: evidenceValue, unit, period: claim.period }
  );
  if (comparison.comparable && comparison.equal) {
    return {
      verdict: "supported",
      note: `${result.note ?? ""} [downgraded from contradicted on review: ${claimValue} and ${evidenceValue} are within rounding tolerance — compare.ts, D018 §2.3]`.trim(),
    };
  }
  return { verdict: result.verdict, note: result.note };
}

/** Groups claims into 5–10-sized batches, grouping by the doc_id their passages share (research.md §6). */
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
    let stamped = false;

    for (const batch of batches) {
      await this.runBatch(auditId, batch, threshold, promptVersion, providerId);
      if (!stamped) {
        await this.auditStore.updateAudit(auditId, {
          promptRevisionVerify: promptVersion,
          modelRevisionVerify: this.modelName,
        });
        stamped = true;
      }
    }
    // batchClaims may produce fewer than BATCH_MIN in the last group for a
    // small audit — intentional; BATCH_MIN/BATCH_MAX bound the *target* size,
    // not a hard floor no audit could ever fall under.
    void BATCH_MIN;
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

    const { result: raw, llmCallId } = await executeAndRecordLlmCall(
      () => this.provider.completeJson<unknown>({ system, user }),
      { sessionId: null, stage: "verify", callType: "primary", provider: providerId, model: this.modelName, promptVersion },
      this.llmCallStore
    );

    if (isSuspectedInjection(JSON.stringify(raw), VERIFY_RESPONSE_KEYS)) {
      logger.error({ module: MODULE, operation: "runBatch", auditId, raw }, "VERIFY response flagged as injection-suspected — hard stop, not repaired");
      if (llmCallId) {
        await this.llmCallStore.updateFailure(llmCallId, "schema_validation", "injection-suspected response").catch(() => {});
      }
      throw new InjectionSuspectedError("verify");
    }

    let parsed: VerifyResponse;
    try {
      const { result } = await repairWithFallback(JSON.stringify(raw), VerifyResponseSchema, null);
      parsed = result;
      if (llmCallId) await this.llmCallStore.updateParsedOutput(llmCallId, parsed).catch(() => {});
    } catch (err) {
      if (llmCallId) {
        await this.llmCallStore.updateFailure(llmCallId, "schema_validation", (err as Error).message).catch(() => {});
      }
      throw err;
    }

    const byClaimId = new Map(batch.map((b) => [b.claim.claimId, b.claim]));
    for (const result of parsed.results) {
      const claim = byClaimId.get(result.claim_id);
      if (!claim) continue; // model echoed an id we didn't send — ignore, don't persist

      // Retrieval-failure gate rule (data-model.md): a claim whose retrieval
      // itself errored must never resolve to "unsupported" — that would
      // present an infrastructure failure as "sources checked, found silent."
      let verdict = result.verdict;
      let note = result.note;
      if (claim.retrievalStatus === "error" && verdict === "unsupported") {
        verdict = "unverifiable";
        note = `${note ?? ""} [forced to unverifiable: retrieval_status=error, not a genuine absence-of-evidence signal]`.trim();
      } else {
        const reconciled = reconcileContradictionWithTolerance(claim, { verdict, evidence: result.evidence, note });
        verdict = reconciled.verdict as typeof verdict;
        note = reconciled.note;
      }

      // FR-020 / A6: confidence comes exclusively from VERIFY's own output —
      // never computed from or blended with retrieval_score. result.confidence
      // is used as-is; retrieval_score is never read here at all.
      await this.auditStore.updateClaimVerdict(claim.claimId, {
        verdict: verdict as "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable",
        evidence: result.evidence,
        sourceRefs: result.source_refs,
        synthesized: result.synthesized,
        confidence: result.confidence,
        note,
      });
    }
  }
}
