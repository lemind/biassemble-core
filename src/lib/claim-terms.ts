/**
 * Shared "meaningful claim term" extraction/scoring — lives here (not orchestrators/grounnel)
 * so both the providers layer (candidate ranking) and orchestrators layer (gate #4, Case A gate)
 * can import it without providers depending on orchestrators. See D026 §6.
 */

// Common sentence-starters that are only capitalized because of position, not identity — the
// only case the old "i > 0" guard needs, since excluding every first word also dropped real
// subjects ("Shakespeare wrote sonnets." -> zero terms, gate #4 silently disabled).
const COMMON_FIRST_WORDS = new Set(["the", "a", "an", "this", "that", "these", "those", "it", "he", "she", "they", "there", "here"]);

interface CleanWord {
  clean: string;
  isKey: boolean;
}

// Shared tokenizer: trims punctuation and classifies each word as a "key" one (digit-bearing, or
// a capitalized word that isn't just a common sentence-starter) or not. extractKeyTerms and
// buildSearchQuery both build on this single classification so they can't drift apart.
function tokenize(text: string): CleanWord[] {
  const out: CleanWord[] = [];
  text.split(/\s+/).forEach((word, i) => {
    // Trim only leading/trailing punctuation — a numeric term keeps its internal
    // thousands-separator commas ("$350,000"), or it won't match the passage's own comma-formatted figure.
    const clean = word.replace(/^[.,!?;:"'()]+/, "").replace(/[.,!?;:"'()]+$/, "");
    if (!clean) return;
    const isKey = /\d/.test(clean) || (/^[A-Z]/.test(clean) && (i > 0 || !COMMON_FIRST_WORDS.has(clean.toLowerCase())));
    out.push({ clean, isKey });
  });
  return out;
}

/** Exported for reuse by gate #4 (`passage-filter.ts`) and gates.ts's Case A gate (D022 §4) — one definition, no drift risk. */
export function extractKeyTerms(claimText: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { clean, isKey } of tokenize(claimText)) {
    if (!isKey) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(lower);
  }
  return terms;
}

/** Count of distinct claim key-terms present in `text` — the ranking signal for candidate selection (D026 §6, T039). */
export function scoreKeyTermMatches(terms: string[], text: string): number {
  const lower = text.toLowerCase();
  return terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
}

/**
 * D026 §8 (T046) — a deterministic, no-LLM search query: entities + numbers, in original case and
 * order, instead of the claim's full declarative sentence. Search engines are keyword-optimized,
 * not sentence-optimized; a raw claim sentence carries filler words ("was", "in", "the") a search
 * index gets no signal from. Falls back to the raw claim text when nothing key-worthy is found —
 * same fail-open convention as extractKeyTerms/isPassageRelevant.
 */
export function buildSearchQuery(claimText: string): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const { clean, isKey } of tokenize(claimText)) {
    if (!isKey) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    words.push(clean);
  }
  return words.length > 0 ? words.join(" ") : claimText;
}
