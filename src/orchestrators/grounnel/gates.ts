import { compare } from "../../numbers/compare.js";
import { extractNumericFact, CONTRADICTION_LANGUAGE_RE, NEGATED_CONTRADICTION_RE } from "../audit/verify-reconcilers.js";
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
    return { verdict: input.verdict, overridden: false };
  }
  if (!CONTRADICTION_LANGUAGE_RE.test(input.reason) || NEGATED_CONTRADICTION_RE.test(input.reason)) {
    return { verdict: input.verdict, overridden: false };
  }
  return { verdict: "contradicted", overridden: true };
}

// Also strips smart quotes/dashes (’‘“”–—) — LLM JSON output commonly straightens these even
// when quoting "verbatim" from web prose that renders them typographically.
const PUNCTUATION_RE = /[.,!?;:"'()‘’“”–—]/g;

/** Exact substring after whitespace/punctuation normalization only — never fuzzy/semantic (D019 §2). */
function normalizeForSubstringCheck(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION_RE, "").replace(/\s+/g, " ").trim();
}

export interface GateOneInput {
  verdict: Verdict;
  evidence: string | null;
  passageText: string;
}

export interface GateOneResult {
  verdict: Verdict;
  evidence: string | null;
}

/** Gate #1 — contradiction evidence gate (D019 §2, tasks.md T003). Only fires on `contradicted`. */
export function applyContradictionEvidenceGate(input: GateOneInput): GateOneResult {
  if (input.verdict !== "contradicted") {
    return { verdict: input.verdict, evidence: input.evidence };
  }
  const evidenceOk =
    !!input.evidence &&
    normalizeForSubstringCheck(input.passageText).includes(normalizeForSubstringCheck(input.evidence));
  if (evidenceOk) {
    return { verdict: input.verdict, evidence: input.evidence };
  }
  return { verdict: "unsupported", evidence: null };
}

export interface GateTwoInput {
  claimText: string;
  verdict: Verdict;
  evidence: string | null;
}

export interface GateTwoResult {
  verdict: Verdict;
  overridden: boolean;
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

/**
 * Gate #2 — numeric normalization/comparison in code (D019 §2, tasks.md T004). Near-direct port of
 * the equal/inverted/wrong-scale decision logic in verify-reconcilers.ts's reconcileNumericVerdict —
 * the row/table-matching machinery is deliberately not ported (tasks.md T004 scope note: web prose
 * has no rows to match). Wrong-period detection is also out of scope for the same reason: it relies
 * on a structured `claim.period` field D018's B2B claims have and Grounnel's ClaimSchema does not.
 */
export function applyNumericGate(input: GateTwoInput): GateTwoResult {
  if (!input.evidence) return { verdict: input.verdict, overridden: false };

  const claimFact = extractNumericFact(input.claimText);
  const evidenceFact = extractNumericFact(input.evidence);
  if (!claimFact || !evidenceFact) return { verdict: input.verdict, overridden: false };

  const comparison = compare(claimFact, evidenceFact);
  if (!comparison.comparable) return { verdict: input.verdict, overridden: false };

  const threshold = detectThreshold(input.claimText);
  if (threshold) {
    // direction is sign(claim - source): "at_least" (claim says source >= claim) holds when
    // claim <= source (direction <= 0); "at_most" holds when claim >= source (direction >= 0).
    const holds = threshold === "at_least" ? comparison.direction <= 0 : comparison.direction >= 0;
    if (holds && input.verdict !== "supported") return { verdict: "supported", overridden: true };
    if (!holds && input.verdict !== "contradicted") return { verdict: "contradicted", overridden: true };
    return { verdict: input.verdict, overridden: false };
  }

  if (comparison.equal === null) {
    return { verdict: input.verdict, overridden: false };
  }

  if (comparison.equal && input.verdict !== "supported") {
    return { verdict: "supported", overridden: true };
  }
  if (!comparison.equal && input.verdict !== "contradicted") {
    return { verdict: "contradicted", overridden: true };
  }
  return { verdict: input.verdict, overridden: false };
}
