import { compare } from "../../numbers/compare.js";
import { extractNumericFact, CONTRADICTION_LANGUAGE_RE, NEGATED_CONTRADICTION_RE } from "../audit/verify-reconcilers.js";
import { extractKeyTerms } from "./passage-filter.js";
import type { GrounnelVerdictEnum } from "../../contracts/grounnel.schemas.js";
import type { z } from "zod";

type Verdict = z.infer<typeof GrounnelVerdictEnum>;

export interface ReasonConsistencyInput {
  verdict: Verdict;
  reason: string | null;
}

export interface ReasonConsistencyResult {
  verdict: Verdict;
  overridden: boolean;
  // Machine-readable code for why this gate acted — null when overridden is false (D023 §5).
  reason: "contradiction_language_in_model_reason" | null;
}

/**
 * Forces verdict to `contradicted` when the model's own reason asserts a contradiction but the
 * verdict says otherwise — reuses audit's hardened CONTRADICTION_LANGUAGE_RE (D018 §5.5) rather
 * than a fresh regex. Real live-eval failures (2026-08-06): reason explicitly said "contradicts"/
 * "not Canada" while verdict landed on `unsupported`.
 *
 * One direction only, deliberately: the opposite (reason argues support, verdict says
 * contradicted — also observed live) has no equivalent hardened detector in this codebase yet.
 * A fresh "support-language" regex now would repeat the exact under-tested-heuristic mistake
 * this file's own incident history warns against — a named, not silently dropped, gap.
 */
export function applyReasonConsistencyGate(input: ReasonConsistencyInput): ReasonConsistencyResult {
  if (input.verdict === "contradicted" || !input.reason) {
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

// Matches a bare "X, not Y" correction with no contradiction verb — the shape
// applyReasonConsistencyGate deliberately doesn't catch (D022 §2, real gap: g05). Y's words must
// be capitalized (entity-shaped) so the match stops at the entity instead of swallowing trailing
// lowercase words ("not Canada to the United States" would otherwise capture "Canada to the").
const IMPLICIT_NEGATION_RE = /,\s*not\s+(?:the\s+)?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,2})/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case A gate (D022 §4) — bare "X, not Y" negation applyReasonConsistencyGate misses. Condition
 * 3 trades recall for precision by deliberate design — see D022 §4 before weakening it.
 */
export function applyImplicitNegationGate(input: ImplicitNegationInput): ImplicitNegationResult {
  // Only "unsupported" is in scope: "contradicted" is already there, "unverifiable" is a
  // confidence downgrade this gate shouldn't override, "supported" would mean firing on a
  // narrative correction the model already resolved correctly (D022 §4 review finding).
  if (input.verdict !== "unsupported" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const match = IMPLICIT_NEGATION_RE.exec(input.reason);
  if (!match) return { verdict: input.verdict, overridden: false, reason: null };

  const y = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
  const yInClaim = new RegExp(`\\b${escapeRegExp(y)}\\b`, "i").test(input.claimText);
  if (!yInClaim) return { verdict: input.verdict, overridden: false, reason: null };

  // Y's own words are excluded individually, not as one string — a multi-word Y ("United
  // Kingdom") must not let its own constituent words ("united", "states") count as the second,
  // independent entity condition 3 requires (D022 §4 review finding).
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

// Matches "..." or the single-character "…" the model sometimes uses to join two real, non-adjacent
// excerpts from the same passage into one evidence string (a live-eval finding, 2026-08-07, g04:
// "Germany invades Poland ... Japan formally surrenders", both real, ~1000 words apart in the
// source's dated timeline). Splitting on it, not just stripping it, matters — PUNCTUATION_RE alone
// would collapse the gap and require the two genuinely non-adjacent fragments to be contiguous.
const EVIDENCE_ELLIPSIS_RE = /\.{3,}|…/g;

/**
 * Every fragment (split on an ellipsis) must independently be a real, contiguous substring of the
 * passage — still rejects a single fabricated fragment, doesn't weaken gate #1's hallucination
 * check, just stops requiring multi-excerpt evidence to be one unbroken span (D019 §2, live-eval).
 */
function evidenceMatchesPassage(evidence: string, passageText: string): boolean {
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
  // Trimmed, not just truthy — a whitespace-only string ("  ") is truthy but carries no real
  // content, same as null (reviewed finding: naive `!!input.evidence` misclassified it as grounded).
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

export interface GateTwoInput {
  claimText: string;
  verdict: Verdict;
  evidence: string | null;
}

export interface GateTwoResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "threshold_comparison" | "equality_comparison" | null;
}

// A real live-eval failure (g11, 2026-08-06): "surpassed $3.5 trillion" against evidence stating
// $3.57 trillion got marked contradicted — the equality-only comparison below treated "3.5 ≠ 3.57"
// as confirming a mismatch, with no concept of threshold claims where a HIGHER evidence value means
// the claim holds, not that it's wrong. `compare()`'s own `direction` field already carries what's
// needed to fix this; it just wasn't used here before.
const AT_LEAST_RE = /\b(surpassed|exceeded|topped|crossed|more than|greater than|over|above|at least)\b/i;
const AT_MOST_RE = /\b(less than|fewer than|under|below|at most|no more than)\b/i;

function detectThreshold(claimText: string): "at_least" | "at_most" | null {
  if (AT_LEAST_RE.test(claimText)) return "at_least";
  if (AT_MOST_RE.test(claimText)) return "at_most";
  return null;
}

// D026 §5 — real g11 near-miss: this gate forced "contradicted" comparing a claim's threshold value
// against evidence from a different, narrower period ($3.2T "as of July 2025" vs. a claim about
// 2024), with zero period awareness. Conservative on purpose: abstains if evidence names ANY year
// the claim doesn't, even if a matching year ALSO appears elsewhere in the text — the real case had
// evidence spanning 2022-2025 across different, unrelated figures, so "some overlap exists somewhere"
// isn't a safe enough test. Reads years from free text (same concern verify-reconcilers.ts's
// passagePeriodConflicts already solved via a structured claim.period field Grounnel doesn't have).
const YEAR_RE = /(?<![\d.])(?:19|20)\d{2}(?![\d.])/g;

function yearsConflict(claimText: string, evidenceText: string): boolean {
  const claimYears = claimText.match(YEAR_RE);
  if (!claimYears?.length) return false;
  const evidenceYears = evidenceText.match(YEAR_RE);
  if (!evidenceYears?.length) return false;
  return evidenceYears.some((y) => !claimYears.includes(y));
}

/**
 * Gate #2 — numeric normalization/comparison in code (D019 §2, tasks.md T004). Near-direct port of
 * the equal/inverted/wrong-scale decision logic in verify-reconcilers.ts's reconcileNumericVerdict —
 * the row/table-matching machinery is deliberately not ported (tasks.md T004 scope note: web prose
 * has no rows to match). Full structured wrong-period detection remains out of scope for the same
 * reason (relies on a `claim.period` field D018's B2B claims have and Grounnel's ClaimSchema does
 * not) — `yearsConflict` above is a narrower, free-text-only guard for the specific case D026 §5 found.
 */
export function applyNumericGate(input: GateTwoInput): GateTwoResult {
  if (!input.evidence) return { verdict: input.verdict, overridden: false, reason: null };

  const claimFact = extractNumericFact(input.claimText);
  const evidenceFact = extractNumericFact(input.evidence);
  if (!claimFact || !evidenceFact) return { verdict: input.verdict, overridden: false, reason: null };

  const comparison = compare(claimFact, evidenceFact);
  if (!comparison.comparable) return { verdict: input.verdict, overridden: false, reason: null };

  if (yearsConflict(input.claimText, input.evidence)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const threshold = detectThreshold(input.claimText);
  if (threshold) {
    // direction is sign(claim - source): "at_least" (claim says source >= claim) holds when
    // claim <= source (direction <= 0); "at_most" holds when claim >= source (direction >= 0).
    const holds = threshold === "at_least" ? comparison.direction <= 0 : comparison.direction >= 0;
    if (holds && input.verdict !== "supported") return { verdict: "supported", overridden: true, reason: "threshold_comparison" };
    if (!holds && input.verdict !== "contradicted") return { verdict: "contradicted", overridden: true, reason: "threshold_comparison" };
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  if (comparison.equal === null) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  if (comparison.equal && input.verdict !== "supported") {
    return { verdict: "supported", overridden: true, reason: "equality_comparison" };
  }
  if (!comparison.equal && input.verdict !== "contradicted") {
    return { verdict: "contradicted", overridden: true, reason: "equality_comparison" };
  }
  return { verdict: input.verdict, overridden: false, reason: null };
}
