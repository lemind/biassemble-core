/** Gate #3 — pre-search opinion/non-factual filter, rule-based first (D019 §2, tasks.md T005). */

const VALUE_JUDGMENT_RE =
  /\b(best|worst|beautiful|ugly|amazing|terrible|awful|favorite|favourite|greatest|finest|superior|inferior|should|ought to|must be|overrated|underrated)\b/i;

const VAGUE_INTENSIFIER_RE = /\b(very|extremely|quite|remarkably|incredibly|surprisingly|somewhat)\s+\w+/i;

// Hedged/uncertain future claims ("will probably", "is expected to") — a scheduled, dated event
// ("will report earnings on October 15") is still checkable and must not match this. D019 §2.
const PREDICTION_RE = /\b(will (?:probably|likely)|is expected to|might well|may well|could potentially|is likely to)\b/i;

/** True when the claim has no checkable referent — a value judgment, prediction, or vague intensifier. */
export function isOpinionClaim(claimText: string): boolean {
  return VALUE_JUDGMENT_RE.test(claimText) || VAGUE_INTENSIFIER_RE.test(claimText) || PREDICTION_RE.test(claimText);
}
