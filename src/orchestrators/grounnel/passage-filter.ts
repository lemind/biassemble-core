/**
 * Gate #4 — passage relevance pre-filter, lexical-presence plus instance-selector matching (D019
 * §2, tasks.md T006; extended D030 §3f). Known gap, not fixed here: a passage that refers to the
 * claim's subject only by pronoun (coreference, never repeating the name) is wrongly dropped. D019
 * §2 names this explicitly rather than papering over it with a hedged rule.
 */

import { extractKeyTerms } from "../../lib/claim-terms.js";
import { extractInstanceSelector, passageMatchesSelector } from "../../lib/instance-selector.js";

/**
 * True when the passage contains at least one of the claim's own key entities/numbers, OR (D030
 * §3f) discusses the specific instance the claim's selector names ("the first flight") even without
 * sharing a key term — a claim like "the first flight covered 852 feet" has "852" as its only key
 * term, which admits pages about a DIFFERENT flight that also covered 852 feet while structurally
 * excluding the page that would actually confirm or refute "the first flight" specifically. Additive
 * only: never used to reject a passage that has no selector at all.
 */
export function isPassageRelevant(claimText: string, passageText: string): boolean {
  const terms = extractKeyTerms(claimText);
  if (terms.length === 0) return true;
  const lowerPassage = passageText.toLowerCase();
  if (terms.some((term) => lowerPassage.includes(term))) return true;
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
  return isPassageRelevant(subjectEntity, passageText);
}
