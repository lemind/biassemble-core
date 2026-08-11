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
