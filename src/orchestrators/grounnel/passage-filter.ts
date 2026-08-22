/**
 * Gate #4 — passage relevance pre-filter, lexical-presence plus instance-selector matching (D019
 * §2, tasks.md T006; extended D030 §3f). Known gap, not fixed here: a passage that refers to the
 * claim's subject only by pronoun (coreference, never repeating the name) is wrongly dropped. D019
 * §2 names this explicitly rather than papering over it with a hedged rule.
 */

import { extractKeyTerms } from "../../lib/claim-terms.js";
import { extractInstanceSelector, passageMatchesSelector } from "../../lib/instance-selector.js";

/** True when the passage shares at least one of the claim's own key entities/numbers. */
function hasKeyTermMatch(text: string, passageText: string): boolean {
  const terms = extractKeyTerms(text);
  if (terms.length === 0) return true;
  const lowerPassage = passageText.toLowerCase();
  return terms.some((term) => lowerPassage.includes(term));
}

/** True on a key-term match, OR (D030 §3f) a shared instance-selector — additive only, never rejects a passage with no selector. */
export function isPassageRelevant(claimText: string, passageText: string): boolean {
  if (hasKeyTermMatch(claimText, passageText)) return true;
  const selector = extractInstanceSelector(claimText);
  return selector !== null && passageMatchesSelector(selector, passageText);
}

/**
 * Same check as isPassageRelevant, keyed on EXTRACT's own subject_entity instead of claim text
 * (g17, review round 2 — delegates rather than reimplementing, was a near-duplicate). Used only in
 * rerankPassages' lexical-only fallback branches, not as a standalone gate ahead of the LLM rerank
 * call (see pipeline.service.ts's rerank prompt for the primary, semantic entity check).
 */
export function hasSubjectEntity(subjectEntity: string, passageText: string): boolean {
  // Guards undefined too: tests aren't typechecked (tsconfig excludes tests/), so pre-existing
  // fixtures predating this field hit this at runtime, not just a real "" from EXTRACT.
  if (!subjectEntity) return true;
  // Review finding (D030 §3f) — deliberately NOT isPassageRelevant's selector rescue: this is g17's
  // dedicated, stricter entity-anchor safeguard, and any shared generic anchor word (e.g. "brothers")
  // is enough to satisfy the selector check, which would silently reopen the wrong-entity bleed-
  // through g17 exists to block.
  return hasKeyTermMatch(subjectEntity, passageText);
}
