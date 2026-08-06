import { compare } from "../../numbers/compare.js";
import { extractNumericFact } from "../audit/verify-reconcilers.js";
import type { GrounnelVerdictEnum } from "../../contracts/grounnel.schemas.js";
import type { z } from "zod";

type Verdict = z.infer<typeof GrounnelVerdictEnum>;

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
  if (!comparison.comparable || comparison.equal === null) {
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
