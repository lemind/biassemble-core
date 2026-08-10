/**
 * Shared "meaningful claim term" extraction/scoring — lives here (not orchestrators/grounnel)
 * so both the providers layer (candidate ranking) and orchestrators layer (gate #4, Case A gate)
 * can import it without providers depending on orchestrators. See D026 §6.
 */

// Common sentence-starters that are only capitalized because of position, not identity — the
// only case the old "i > 0" guard needs, since excluding every first word also dropped real
// subjects ("Shakespeare wrote sonnets." -> zero terms, gate #4 silently disabled).
const COMMON_FIRST_WORDS = new Set(["the", "a", "an", "this", "that", "these", "those", "it", "he", "she", "they", "there", "here"]);

/** Exported for reuse by gate #4 (`passage-filter.ts`) and gates.ts's Case A gate (D022 §4) — one definition, no drift risk. */
export function extractKeyTerms(claimText: string): string[] {
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

/** Count of distinct claim key-terms present in `text` — the ranking signal for candidate selection (D026 §6, T039). */
export function scoreKeyTermMatches(terms: string[], text: string): number {
  const lower = text.toLowerCase();
  return terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
}
