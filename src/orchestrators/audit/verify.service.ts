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
 * If a third numeric-claim-shape bug shows up after this one (percentage-
 * point claims, date-arithmetic claims, ...), stop writing a fourth bespoke
 * comparator here — that's the signal to build a generic "does VERIFY's own
 * stated reasoning in `note` match the verdict it emitted" check instead of
 * per-type patches. Not built now (T041b/tasks.md's own note) — this file
 * would just be guessing at how to parse arbitrary reasoning prose, which is
 * exactly the kind of free-text parsing this module has always refused to
 * do without a real design for it.
 */

type CurrencyOrPercentUnit = "USD" | "percent";

interface ExtractedNumericFact {
  value: number;
  unit: CurrencyOrPercentUnit;
  /** Only meaningful for unit === "USD". null = no scale word found in this text. */
  scale: string | null;
}

// Optional parens around the digits capture accounting-negative notation
// (e.g. "$(0.62)" = -0.62 per-share loss) — same "(1)" -> -1 convention
// normalize.ts already parses (num-015), but that module only ever sees an
// already-isolated value token; this regex is what extracts a number out of
// free claim/evidence text in the first place, and previously couldn't match
// the parenthesized form at all, so it silently returned null instead of the
// negative value. Found in production 2026-07-29: an EPS claim "$(0.62)" vs
// cited evidence "$(0.87)" both failed to parse, so this check never ran and
// the LLM's raw, wrong "supported" verdict passed through unreconciled.
// Group order matches real usage: the close-paren lands right after the
// digits ("$(190.9) million"), not after the scale word ("$(190.9 million)").
const CURRENCY_RE = /\$\s?(\()?\s*([\d,]+(?:\.\d+)?)\s*(\))?\s*(billion|million|thousand)?/i;
const PERCENT_RE = /(-?[\d,]+(?:\.\d+)?)\s*%/;

/**
 * Extracts a comparable currency-or-percent fact from free text. Tries
 * currency first (so "$2.05" isn't misread as a bare unitless number), falls
 * back to percent, else unresolved (null) — same "not comparable != wrong"
 * discipline as compare.ts itself.
 */
export function extractNumericFact(text: string): ExtractedNumericFact | null {
  const currencyMatch = text.match(CURRENCY_RE);
  if (currencyMatch?.[2]) {
    let value = parseFloat(currencyMatch[2].replace(/,/g, ""));
    if (Number.isNaN(value)) return null;
    if (currencyMatch[1] === "(" || currencyMatch[3] === ")") {
      value = -Math.abs(value);
    }
    return { value, unit: "USD", scale: currencyMatch[4]?.toLowerCase() ?? null };
  }
  const percentMatch = text.match(PERCENT_RE);
  if (percentMatch?.[1]) {
    const value = parseFloat(percentMatch[1].replace(/,/g, ""));
    if (Number.isNaN(value)) return null;
    return { value, unit: "percent", scale: null };
  }
  return null;
}

/**
 * Fix 1 (found on review, real production incident 2026-07-22): a
 * bidirectional compare.ts integration for direct number-vs-number
 * disagreements — e.g. a claim states "$640 million" R&D spend, the cited
 * evidence says "$64 million," and VERIFY nonetheless returned
 * verdict="supported" with a `note` that correctly computed the mismatch
 * itself. `compare.ts`'s own equality/tolerance logic decides the outcome;
 * this function only decides *whether* to trust VERIFY's verdict or the
 * numbers.
 *
 * Two deliberate widenings from the original (T018) version, plus one new
 * safety rule:
 * 1. Currency (`$` + optional scale word), not just `%` — a bare `%` was
 *    the only unit this used to recognize.
 * 2. Bidirectional — arbitrates both `contradicted -> supported` (numbers
 *    actually agree, downgrade the false alarm) AND `supported ->
 *    contradicted` (numbers actually disagree beyond tolerance, upgrade the
 *    miss). Only ever touches these two verdicts; `partially_supported`,
 *    `unsupported`, and `unverifiable` reflect judgments (retrieval,
 *    attribution, hedged confidence) this narrow numeric check isn't
 *    equipped to override.
 * 3. **Scale-ambiguity guard**: currency scale is only trusted when BOTH
 *    texts state an explicit scale word ("million"/"billion"/"thousand") —
 *    or neither does. A bare `"$56,994"` in a compact evidence table
 *    typically means "already in millions" by a filing-wide convention this
 *    function cannot see from the snippet alone; guessing that would create
 *    false contradictions across nearly every dollar claim in the golden
 *    set (verified against it directly — this is not a hypothetical
 *    concern). When only one side has an explicit scale word, this returns
 *    the verdict unchanged rather than guess.
 *
 * Still does NOT attempt period/scope mismatches from free text — same
 * pre-existing, documented limitation as before (`period: claim.period` is
 * passed identically to both sides, so a period difference can never be
 * what `compare()` reports).
 */
/**
 * Reverted 2026-07-29 (was: a keyword-proximity fallback that searched
 * retrieved passages directly when VERIFY quoted no evidence for an
 * "unsupported" verdict). Real production run against a denser, real
 * filing text than the one this was unit-tested against: "liabilities"
 * occurred twice in the actual source ("Total liabilities" / "lease
 * liabilities" — the test fixture only had one occurrence), which
 * disqualified it from the "prefer unique keywords" safety pass and fell
 * through to the looser, unsafe pass. Result: a total-liabilities claim
 * was upgraded to "contradicted" citing "$210 million" (GAAP operating
 * expense guidance, a completely different measure) as evidence — a
 * confident, wrong accusation backed by fabricated-looking justification,
 * strictly worse than the original miss it was meant to fix. Same failure
 * hit an ALLO-647 cost claim (matched against unrelated R&D expense).
 *
 * Proximity/keyword matching cannot establish "same measure" — it can only
 * ever establish "these words are near each other," which is a different
 * and weaker claim. There is no version of this heuristic that's safe on
 * real, dense filing text without also being able to recognize which
 * specific labeled figure a claim refers to — that requires actual
 * structured/entity-aware retrieval (the real fix is finer-grained
 * retrieval, not a better proximity heuristic on top of coarse retrieval —
 * see the ADR-002 embedding-retrieval gap already flagged elsewhere).
 * Per D018 §2.3, "contradicted" requires established same-measure
 * comparability; this can't establish that, so it must never emit
 * "contradicted". Prefer the false negative (stays "unsupported") over a
 * false accusation. Not rebuilding this without a real design for the
 * comparability problem specifically, not just a smarter proximity search.
 */
export function reconcileNumericVerdict(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null }
): { verdict: string; note: string | null } {
  const firstEvidence = result.evidence?.[0];
  if (!firstEvidence) {
    return { verdict: result.verdict, note: result.note };
  }
  if (result.verdict !== "supported" && result.verdict !== "contradicted") {
    return { verdict: result.verdict, note: result.note };
  }

  const claimFact = extractNumericFact(claim.claimText);
  const evidenceFact = extractNumericFact(firstEvidence);
  if (!claimFact || !evidenceFact || claimFact.unit !== evidenceFact.unit) {
    return { verdict: result.verdict, note: result.note }; // can't check — trust the LLM
  }
  if (claimFact.unit === "USD" && (claimFact.scale === null) !== (evidenceFact.scale === null)) {
    return { verdict: result.verdict, note: result.note }; // ambiguous scale — don't guess
  }

  const comparison = compare(
    { value: claimFact.value, unit: claimFact.unit, scale: claimFact.scale, period: claim.period },
    { value: evidenceFact.value, unit: evidenceFact.unit, scale: evidenceFact.scale, period: claim.period }
  );
  if (!comparison.comparable) {
    return { verdict: result.verdict, note: result.note };
  }

  if (comparison.equal && result.verdict === "contradicted") {
    return {
      verdict: "supported",
      note: `${result.note ?? ""} [downgraded from contradicted on review: ${claimFact.value} and ${evidenceFact.value} are within tolerance — compare.ts, D018 §2.3]`.trim(),
    };
  }
  if (!comparison.equal && result.verdict === "supported") {
    return {
      verdict: "contradicted",
      note: `${result.note ?? ""} [upgraded from supported on review: ${claimFact.value} and ${evidenceFact.value} disagree beyond tolerance — compare.ts, D018 §2.3]`.trim(),
    };
  }
  return { verdict: result.verdict, note: result.note };
}

/** Multiple thresholds this checks for — expand only when a real case justifies it (T041b). */
const MAGNITUDE_PHRASES: Array<{ pattern: RegExp; multiple: number }> = [
  { pattern: /more than quadrupl/i, multiple: 4.0 },
  { pattern: /more than tripl/i, multiple: 3.0 },
  { pattern: /more than doubl/i, multiple: 2.0 },
];

export function detectMagnitudeClaim(claimText: string): { multiple: number } | null {
  for (const { pattern, multiple } of MAGNITUDE_PHRASES) {
    if (pattern.test(claimText)) return { multiple };
  }
  return null;
}

/**
 * Extracts [current, prior] from a compact "$current $prior ..." evidence
 * table shape (this golden set's and this project's source filings'
 * consistent convention — narrow by design, not a general table parser).
 */
export function extractCurrentPriorPair(evidenceText: string): [number, number] | null {
  const values = [...evidenceText.matchAll(/\$?([\d,]+(?:\.\d+)?)/g)]
    .map((m) => (m[1] ? parseFloat(m[1].replace(/,/g, "")) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (values.length < 2 || values[0] === undefined || values[1] === undefined) return null;
  return [values[0], values[1]];
}

/**
 * Fix 2 (T041b, real production incident 2026-07-22): a claim using
 * comparative magnitude language ("more than doubled/tripled/quadrupled")
 * has no explicit numbers of its own to compare via reconcileNumericVerdict
 * above — the comparison is against a ratio computed from the cited
 * evidence's own current/prior pair. VERIFY can (and did, in production)
 * compute that ratio correctly in its own `note` while still emitting a
 * verdict that disagrees with its own math.
 *
 * Boundary rule (not just a floor): a ratio at or above the claimed
 * multiple is `supported`; within 90% of it is `partially_supported`
 * (directionally right, magnitude overstated but not wildly); below 90% is
 * `contradicted` (materially wrong — this is where the real incident's
 * 1.166x landed against a claimed 2.0x). Only overrides `supported`,
 * `partially_supported`, and `contradicted` — never touches `unsupported`/
 * `unverifiable`, which reflect a retrieval/attribution judgment this ratio
 * check has no basis to override.
 */
export function reconcileMagnitudeClaim(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null }
): { verdict: string; note: string | null } {
  const firstEvidence = result.evidence?.[0];
  if (!firstEvidence) {
    return { verdict: result.verdict, note: result.note };
  }
  if (result.verdict !== "supported" && result.verdict !== "partially_supported" && result.verdict !== "contradicted") {
    return { verdict: result.verdict, note: result.note };
  }

  const magnitude = detectMagnitudeClaim(claim.claimText);
  if (!magnitude) {
    return { verdict: result.verdict, note: result.note };
  }
  const pair = extractCurrentPriorPair(firstEvidence);
  if (!pair) {
    return { verdict: result.verdict, note: result.note };
  }
  const [current, prior] = pair;
  if (prior === 0) {
    return { verdict: result.verdict, note: result.note };
  }
  const ratio = current / prior;

  let forcedVerdict: string;
  if (ratio >= magnitude.multiple) {
    forcedVerdict = "supported";
  } else if (ratio >= magnitude.multiple * 0.9) {
    forcedVerdict = "partially_supported";
  } else {
    forcedVerdict = "contradicted";
  }

  if (forcedVerdict === result.verdict) {
    return { verdict: result.verdict, note: result.note };
  }
  return {
    verdict: forcedVerdict,
    note: `${result.note ?? ""} [verdict set by code: computed ratio ${current}/${prior} = ${ratio.toFixed(3)}x vs claimed ${magnitude.multiple}x — compare.ts/D018 §2.3]`.trim(),
  };
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

    // Stamped unconditionally, not gated on a batch actually running — an
    // audit with zero extracted claims (batches = []) still reaches
    // status="complete" and must not leave these null (schema.ts's Audit
    // comment: "all non-null once status = complete").
    await this.auditStore.updateAudit(auditId, {
      promptRevisionVerify: promptVersion,
      modelRevisionVerify: this.modelName,
    });

    for (const batch of batches) {
      await this.runBatch(auditId, batch, threshold, promptVersion, providerId);
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
      // temperature: 0 — see extract.service.ts's matching comment. Same
      // production incident (2026-07-26) showed the same audit re-run
      // producing three different claim sets/verdict patterns on identical
      // input_ref; reproducibility is required to trust a fix ever actually
      // landed, not just that a re-run happened not to hit the bug this time.
      () => this.provider.completeJson<unknown>({ system, user, options: { temperature: 0 } }),
      // sessionId is auditId here, not null (T040) — see extract.service.ts's
      // matching comment.
      { sessionId: auditId, stage: "verify", callType: "primary", provider: providerId, model: this.modelName, promptVersion },
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
      // repair.ts's partial-field-recovery step (Stage 004) sets a whole
      // top-level field to null rather than throwing when only that field
      // fails validation — e.g. one VerifyResultSchema item with an
      // out-of-range confidence or invalid verdict fails the whole
      // `results` array as a unit, nulling it out. Mirrors the identical
      // guard extract.service.ts needed for `claims` — must fail VERIFY
      // cleanly, not crash on `for...of null` a few lines below.
      if (parsed.results === null || parsed.results === undefined) {
        throw new Error("VERIFY response failed schema validation: results could not be parsed (see repair warnings)");
      }
      if (llmCallId) await this.llmCallStore.updateParsedOutput(llmCallId, parsed).catch(() => {});
    } catch (err) {
      if (llmCallId) {
        await this.llmCallStore.updateFailure(llmCallId, "schema_validation", (err as Error).message).catch(() => {});
      }
      throw err;
    }

    const byClaimId = new Map(batch.map((b) => [b.claim.claimId, b.claim]));
    const answeredClaimIds = new Set<string>();
    for (const result of parsed.results) {
      const claim = byClaimId.get(result.claim_id);
      if (!claim) continue; // model echoed an id we didn't send — ignore, don't persist
      answeredClaimIds.add(claim.claimId);

      // Retrieval-failure gate rule (data-model.md): a claim whose retrieval
      // itself errored must never resolve to "unsupported" — that would
      // present an infrastructure failure as "sources checked, found silent."
      let verdict = result.verdict;
      let note = result.note;
      if (claim.retrievalStatus === "error" && verdict === "unsupported") {
        verdict = "unverifiable";
        note = `${note ?? ""} [forced to unverifiable: retrieval_status=error, not a genuine absence-of-evidence signal]`.trim();
      } else {
        const numericReconciled = reconcileNumericVerdict(claim, { verdict, evidence: result.evidence, note });
        const magnitudeReconciled = reconcileMagnitudeClaim(claim, {
          verdict: numericReconciled.verdict,
          evidence: result.evidence,
          note: numericReconciled.note,
        });
        verdict = magnitudeReconciled.verdict as typeof verdict;
        note = magnitudeReconciled.note;
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

    // A claim sent to VERIFY but absent from its results (a partial/truncated
    // response that still passed schema validation) must not be left at
    // verdict=null forever — that would silently reach status="complete"
    // with an unverified claim. Force it to "unverifiable" rather than
    // guessing a verdict with no LLM output to back it.
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
