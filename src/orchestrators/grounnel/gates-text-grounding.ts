// Text-grounding gates — read VERIFY's evidence/reason directly, no numeric/date logic (D031 split, pure move). See gates.ts for the public barrel.

import { CONTRADICTION_LANGUAGE_RE, NEGATED_CONTRADICTION_RE } from "../audit/verify-reconcilers.js";
import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import { containsNegationCue, type Verdict } from "./gates-shared.js";

export interface ReasonConsistencyInput {
  verdict: Verdict;
  reason: string | null;
  claimText: string;
}

export interface ReasonConsistencyResult {
  verdict: Verdict;
  overridden: boolean;
  // Machine-readable code for why this gate acted — null when overridden is false (D023 §5).
  reason: "contradiction_language_in_model_reason" | null;
}

/** Forces `contradicted` when the model's own reason asserts a contradiction but the verdict doesn't. `unverifiable` excluded (D026 §22) — it's a CONFIDENCE downgrade. */
export function applyReasonConsistencyGate(input: ReasonConsistencyInput): ReasonConsistencyResult {
  if (input.verdict === "contradicted" || input.verdict === "unverifiable" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  // D032 §9/§3k — abstain on a negated claim; presence-only, a known coarser check than the
  // position-scoped gates (accepted tradeoff, see ADR §9c and containsNegationCue's own comment).
  if (containsNegationCue(input.claimText)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  if (!CONTRADICTION_LANGUAGE_RE.test(input.reason) || NEGATED_CONTRADICTION_RE.test(input.reason)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "contradicted", overridden: true, reason: "contradiction_language_in_model_reason" };
}

export interface ImplicitNegationInput {
  verdict: Verdict;
  reason: string | null;
  claimText: string;
  passageText: string;
}

export interface ImplicitNegationResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "bare_negation_matched" | null;
}

// Bare "X, not Y" correction with no contradiction verb (D022 §2, g05). Y must be capitalized so the match stops at the entity, not trailing lowercase words.
const IMPLICIT_NEGATION_RE = /,\s*not\s+(?:the\s+)?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,2})/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case A gate (D022 §4) — bare "X, not Y" negation applyReasonConsistencyGate misses. Condition 3 trades recall for precision by design. */
export function applyImplicitNegationGate(input: ImplicitNegationInput): ImplicitNegationResult {
  // Only "unsupported" is in scope — the other verdicts either already cover this or shouldn't be overridden (D022 §4).
  if (input.verdict !== "unsupported" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const match = IMPLICIT_NEGATION_RE.exec(input.reason);
  if (!match) return { verdict: input.verdict, overridden: false, reason: null };

  const y = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
  const yInClaim = new RegExp(`\\b${escapeRegExp(y)}\\b`, "i").test(input.claimText);
  if (!yInClaim) return { verdict: input.verdict, overridden: false, reason: null };

  // Y's own words are excluded individually, not as one string — a multi-word Y must not double as the second entity condition 3 requires.
  const yWords = new Set(y.split(/\s+/));
  const passageLower = input.passageText.toLowerCase();
  const hasSecondEntity = extractKeyTerms(input.claimText)
    .filter((term) => !yWords.has(term))
    .some((term) => passageLower.includes(term));
  if (!hasSecondEntity) return { verdict: input.verdict, overridden: false, reason: null };

  return { verdict: "contradicted", overridden: true, reason: "bare_negation_matched" };
}

// Also strips smart quotes/dashes (’‘“”–—) — LLM JSON output commonly straightens these even
// when quoting "verbatim" from web prose that renders them typographically.
const PUNCTUATION_RE = /[.,!?;:"'()‘’“”–—]/g;

/** Exact substring after whitespace/punctuation normalization only — never fuzzy/semantic (D019 §2). */
function normalizeForSubstringCheck(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION_RE, "").replace(/\s+/g, " ").trim();
}

// Model sometimes joins two real, non-adjacent excerpts with "..." (g04) — split on it, not just strip it, so each fragment can be checked independently.
const EVIDENCE_ELLIPSIS_RE = /\.{3,}|…/g;

/** Every fragment (split on an ellipsis) must independently be a real, contiguous substring — still rejects a fabricated fragment, just allows a non-contiguous multi-excerpt span (D019 §2). */
export function evidenceMatchesPassage(evidence: string, passageText: string): boolean {
  const normalizedPassage = normalizeForSubstringCheck(passageText);
  const fragments = evidence
    .split(EVIDENCE_ELLIPSIS_RE)
    .map((f) => normalizeForSubstringCheck(f))
    .filter((f) => f.length > 0);
  return fragments.length > 0 && fragments.every((f) => normalizedPassage.includes(f));
}

export interface CounterfactIgnoredInput {
  verdict: Verdict;
  /** Batched LLM classifier result — see D025 §2 for what feeds this and why it can be null. */
  reasonSupportsVerdict: boolean | null;
}

export interface CounterfactIgnoredResult {
  flagged: boolean;
  reason: "counterfact_ignored" | null;
}

/** Gate #5 (D025 §2) — flags only, never changes verdict itself, unlike gates #1-4. */
export function applyCounterfactIgnoredGate(input: CounterfactIgnoredInput): CounterfactIgnoredResult {
  // Reviewed finding: stated positively — flag only on an explicit "no", not on null/true.
  if (input.verdict !== "contradicted" && input.reasonSupportsVerdict === false) {
    return { flagged: true, reason: "counterfact_ignored" };
  }
  return { flagged: false, reason: null };
}

export type InstanceAttribution = "same" | "different" | "absent" | "conflict";

export interface InstanceAttributionInput {
  verdict: Verdict;
  claimText: string;
  /** Batched passage-grounded checker result; null when it did not run or failed (fail-open, D025 §2 convention). */
  attribution: InstanceAttribution | null;
}

export interface InstanceAttributionResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "instance_attribution_mismatch" | "instance_attribution_conflict" | null;
}

/** Spec 013 T21 — the passages named a different member than the claim selects. `conflict` only downgrades: disagreeing sources are not a falsehood finding (Cardinal Rule). */
export function applyInstanceAttributionGate(input: InstanceAttributionInput): InstanceAttributionResult {
  const noop = { verdict: input.verdict, overridden: false, reason: null } as const;
  // `unverifiable` excluded as a CONFIDENCE downgrade, same as the sibling reason gates (D026 §22).
  if (input.attribution === null || input.verdict === "contradicted" || input.verdict === "unverifiable" || input.verdict === "excluded") return noop;
  // Abstain on a negated claim, same guard reason_consistency/reason_ordinal carry (D032 §9): the
  // checker is asked about the fact, not its polarity, so "did NOT cover 852 feet" inverts the answer.
  if (containsNegationCue(input.claimText)) return noop;
  if (input.attribution === "different") {
    return { verdict: "contradicted", overridden: true, reason: "instance_attribution_mismatch" };
  }
  if (input.attribution === "conflict" && (input.verdict === "supported" || input.verdict === "partially_supported")) {
    return { verdict: "unverifiable", overridden: true, reason: "instance_attribution_conflict" };
  }
  return noop;
}

export interface ClaimReasonOverlapInput {
  verdict: Verdict;
  reason: string | null;
  claimText: string;
}

export interface ClaimReasonOverlapResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "claim_reason_no_overlap" | null;
}

/** Gate #1b — cross-claim contamination backstop: a batched VERIFY call answering one claim with another's reasoning still passes gate #1's grounding check. Reuses extractKeyTerms (D026 §6). */
export function applyClaimReasonOverlapGate(input: ClaimReasonOverlapInput): ClaimReasonOverlapResult {
  if (input.verdict !== "contradicted" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const terms = extractKeyTerms(input.claimText);
  if (terms.length === 0) return { verdict: input.verdict, overridden: false, reason: null };
  if (scoreKeyTermMatches(terms, input.reason) > 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "unsupported", overridden: true, reason: "claim_reason_no_overlap" };
}

export interface GateOneInput {
  verdict: Verdict;
  evidence: string | null;
  passageText: string;
}

export interface GateOneResult {
  verdict: Verdict;
  evidence: string | null;
  overridden: boolean;
  // Downgrade-only: "evidence_null" (no evidence given) vs "evidence_not_grounded" (D023 §5).
  reason: "evidence_null" | "evidence_not_grounded" | null;
}

/** Gate #1 — contradiction evidence gate (D019 §2, tasks.md T003). Only fires on `contradicted`. */
export function applyContradictionEvidenceGate(input: GateOneInput): GateOneResult {
  if (input.verdict !== "contradicted") {
    return { verdict: input.verdict, evidence: input.evidence, overridden: false, reason: null };
  }
  // Trimmed, not just truthy — a whitespace-only string is truthy but carries no real content.
  const hasContent = !!input.evidence?.trim();
  const evidenceOk = hasContent && evidenceMatchesPassage(input.evidence!, input.passageText);
  if (evidenceOk) {
    return { verdict: input.verdict, evidence: input.evidence, overridden: false, reason: null };
  }
  return {
    verdict: "unsupported",
    evidence: null,
    overridden: true,
    reason: hasContent ? "evidence_not_grounded" : "evidence_null",
  };
}

/** Affirmation evidence floor (spec 015 G2) — mirror of the contradiction gate above. VERIFY's own
 * EVIDENCE rule requires citations for affirmative verdicts; 330 of 5,979 shipped without any. */
export function applyAffirmationEvidenceGate(input: GateOneInput): GateOneResult {
  if (input.verdict !== "supported" && input.verdict !== "partially_supported") {
    return { verdict: input.verdict, evidence: input.evidence, overridden: false, reason: null };
  }
  const hasContent = !!input.evidence?.trim();
  const evidenceOk = hasContent && evidenceMatchesPassage(input.evidence!, input.passageText);
  if (evidenceOk) {
    return { verdict: input.verdict, evidence: input.evidence, overridden: false, reason: null };
  }
  return {
    verdict: "unsupported",
    evidence: null,
    overridden: true,
    reason: hasContent ? "evidence_not_grounded" : "evidence_null",
  };
}
