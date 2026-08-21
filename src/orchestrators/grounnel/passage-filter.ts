/**
 * Gate #4 — passage relevance pre-filter, lexical-presence only (D019 §2, tasks.md T006).
 * Known gap, not fixed here: a passage that refers to the claim's subject only by pronoun
 * (coreference, never repeating the name) is wrongly dropped. D019 §2 names this explicitly
 * rather than papering over it with a hedged rule.
 */

import { extractKeyTerms } from "../../lib/claim-terms.js";

/** True when the passage contains at least one of the claim's own key entities/numbers. */
export function isPassageRelevant(claimText: string, passageText: string): boolean {
  const terms = extractKeyTerms(claimText);
  if (terms.length === 0) return true;
  const lowerPassage = passageText.toLowerCase();
  return terms.some((term) => lowerPassage.includes(term));
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
  return isPassageRelevant(subjectEntity, passageText);
}
