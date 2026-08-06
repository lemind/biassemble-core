/**
 * Gate #4 — passage relevance pre-filter, lexical-presence only (D019 §2, tasks.md T006).
 * Known gap, not fixed here: a passage that refers to the claim's subject only by pronoun
 * (coreference, never repeating the name) is wrongly dropped. D019 §2 names this explicitly
 * rather than papering over it with a hedged rule.
 */

// Common sentence-starters that are only capitalized because of position, not identity — the
// only case the old "i > 0" guard needs, since excluding every first word also dropped real
// subjects ("Shakespeare wrote sonnets." -> zero terms, gate #4 silently disabled).
const COMMON_FIRST_WORDS = new Set(["the", "a", "an", "this", "that", "these", "those", "it", "he", "she", "they", "there", "here"]);

function extractKeyTerms(claimText: string): string[] {
  const words = claimText.split(/\s+/);
  const terms: string[] = [];
  words.forEach((word, i) => {
    // Trim only leading/trailing punctuation — a numeric term keeps its internal
    // thousands-separator commas ("$350,000"), or it won't match the passage's own comma-formatted figure.
    const clean = word.replace(/^[.,!?;:"'()]+/, "").replace(/[.,!?;:"'()]+$/, "");
    if (!clean) return;
    if (/\d/.test(clean)) {
      terms.push(clean.toLowerCase());
    } else if (/^[A-Z]/.test(clean) && (i > 0 || !COMMON_FIRST_WORDS.has(clean.toLowerCase()))) {
      terms.push(clean.toLowerCase());
    }
  });
  return [...new Set(terms)];
}

/** True when the passage contains at least one of the claim's own key entities/numbers. */
export function isPassageRelevant(claimText: string, passageText: string): boolean {
  const terms = extractKeyTerms(claimText);
  if (terms.length === 0) return true;
  const lowerPassage = passageText.toLowerCase();
  return terms.some((term) => lowerPassage.includes(term));
}
