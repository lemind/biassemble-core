// Recognises a retrieved page that is a REPUBLICATION of the document under test (spec 015 T002).
// Pure, deterministic, zero-LLM. See specs/015 tasks.md for the simulation that set the threshold.
// Wired into resolveEvidence and escalateUnresolved; routes/grounnel.ts threads the input text.

/** Word-shingle width. Below 5 a shared quotation is indistinguishable from a shared document. */
const SHINGLE_K = 5;

/**
 * Fraction of the retrieved page that also appears in the input. Deliberately this direction and
 * not the reverse: stored page text is capped, so "fraction of the input reproduced" is bounded by
 * the cap and understates every score (spec 015 T002).
 *
 * Simulated separation on 221 real pages: republications 0.81-1.00, independent sources <=0.36.
 */
export const INPUT_DUPLICATE_THRESHOLD = 0.5;

/** Too short to identify a document — a few shared sentences are ordinary quotation. */
const MIN_SHINGLES = 8;

// Every punctuation mark is a separator: "U.S." splits into two tokens (never matching "US"),
// and "market's" becomes "market s". Accepted — too few shingles to move a document-scale score.
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function shingles(text: string, k = SHINGLE_K): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

// The input is re-checked once per source, per claim, per escalation tier — re-shingling it each
// time dominated retrieval. One slot: concurrent runs thrash it back to today's cost, never wrong.
let inputCache: { text: string; set: Set<string> } | null = null;

/** Drop the retained set — the run that populated it is over. Callers must run this on every path. */
export function clearInputShingleCache(): void {
  inputCache = null;
}
function inputShingles(text: string): Set<string> {
  if (inputCache?.text === text) return inputCache.set;
  inputCache = { text, set: shingles(text) };
  return inputCache.set;
}

/** Fraction of `pageText`'s shingles that also occur in `inputText`. 0 when either is too short. */
export function inputDuplicateScore(pageText: string, inputText: string): number {
  const page = shingles(pageText);
  if (page.size < MIN_SHINGLES) return 0;
  const input = inputShingles(inputText);
  if (input.size < MIN_SHINGLES) return 0;
  let hits = 0;
  for (const s of page) if (input.has(s)) hits++;
  return hits / page.size;
}

/**
 * True when the page is substantially a copy of the input — a syndicated wire republication, an
 * essay-mill mirror, or the input's own host. Such a page corroborates nothing: it IS the claim.
 */
export function isInputDuplicate(pageText: string, inputText: string, threshold = INPUT_DUPLICATE_THRESHOLD): boolean {
  return inputDuplicateScore(pageText, inputText) >= threshold;
}
