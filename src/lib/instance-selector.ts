/**
 * Sequence-instance selector extraction (D030 §3f) — identifies which OCCURRENCE of a repeated
 * entity a claim is about ("the first flight", "the third trial"), as a signal distinct from
 * claim-terms.ts's extractKeyTerms entity/number classification. Consumed only by retrieval
 * (passage-filter.ts's isPassageRelevant admission, pipeline.service.ts's rerank ranking) — never
 * folded into extractKeyTerms itself, which stays unchanged: it's shared by gates.ts's reason_year
 * locality check, claim_reason_overlap, and the Case-A gate, so widening it to score ordinal words
 * would silently change what those three already-validated gates admit as collateral damage.
 *
 * Ranking descriptors ("longest", "largest", "best") are deliberately NOT selectors here — a
 * ranking can coincide with any sequence position (the longest flight isn't structurally
 * guaranteed to be first, fourth, or any other fixed slot), unlike "first"/"fourth" which are
 * positional by definition. See D030 §3e for the same distinction already drawn for why "last"/
 * "final" were tried and reverted from gates.ts's ORDINAL_WORDS, and why superlatives were never
 * added there at all.
 *
 * Anchor-window machinery below is moved here from gates.ts's applyReasonOrdinalGate (D030 §3a) —
 * same mechanism, now shared by two consumers (the reason/verdict gate and this retrieval signal)
 * instead of drifting into two copies. gates.ts imports it back unchanged; applyReasonOrdinalGate's
 * own behavior/tests are untouched by this move.
 */

// Deliberately "first"..."tenth" only — no "last"/"final" (D030 §3e: added then reverted after a
// live false-positive on idiomatic/temporal senses, e.g. "at last", "last year") and no ranking
// words (see module doc above).
export const SEQUENCE_SELECTOR_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
// (?!-to-) rejects "second-to-last"/"second-to-none" style compounds — \b treats "-" as a
// boundary, so the bare regex matched "second" inside "second-to-last" (a penultimate-position
// idiom, not "2nd"). Narrower than a blanket hyphen ban: "first-place"/"third-ranked"/
// "fourth-largest" are genuine sequence usage and must still match.
export const SELECTOR_RE_G = new RegExp(`\\b(${SEQUENCE_SELECTOR_WORDS.join("|")})\\b(?!-to-)`, "gi");

// A "." flanked by digits on both sides is a decimal point ("$3.5 million"), not a sentence/clause
// end — without this, the anchor/negation windows below get truncated to nothing at a dollar figure.
export function isSentenceTerminator(text: string, index: number): boolean {
  if (text[index] !== ".") return true;
  return !(/\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? ""));
}

// Forward-scanning clause boundary, reusing the isSentenceTerminator decimal-point guard — a raw
// `search(/[.!?;,]/)` treats the "." inside a dollar figure as a clause end, truncating the anchor
// window to nothing for any claim with a number/decimal/abbreviation near the selector word.
function firstClauseBoundaryForward(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === ";" || ch === "," || ch === "!" || ch === "?") return i;
    if (ch === "." && isSentenceTerminator(text, i)) return i;
  }
  return -1;
}

// Words too generic to serve as an anchor on their own, filtered out of the content-word window
// below so a shared article/conjunction/preposition/pronoun never counts as "the same noun phrase"
// — only a real content word (the noun the selector modifies, or a modifier next to it) does.
const ANCHOR_STOPWORDS = new Set([
  "and", "the", "a", "an", "of", "in", "on", "at", "its", "his", "her", "their", "was", "is", "were",
  "also", "then", "to", "by", "for", "with", "that", "which", "who", "from", "has", "had", "have",
  "about", "as", "or", "but", "so", "this", "these", "those", "it", "not", "did", "does", "will",
  "would", "could", "over", "under", "into", "onto", "than", "there", "here",
]);
const ANCHOR_WINDOW_WORDS = 2;

// Backward-scanning sentence boundary (deliberately NOT clause-scoped like
// firstClauseBoundaryForward): an anaphoric "one"/pronoun after the selector can refer back to a
// noun stated BEFORE it in a separate, comma-joined appositive ("the flight, the fourth one") —
// crossing that comma is the point, only a full sentence boundary stops the backward scan.
function previousSentenceBoundary(text: string, fromIndex: number): number {
  for (let i = fromIndex - 1; i >= 0; i--) {
    const ch = text[i]!;
    if ((ch === "." || ch === "!" || ch === "?") && isSentenceTerminator(text, i)) return i;
  }
  return -1;
}

function backwardAnchorWords(text: string, matchStart: number): string[] {
  const boundary = previousSentenceBoundary(text, matchStart);
  const rawWords = text.slice(boundary + 1, matchStart).trim().split(/\s+/);
  const words: string[] = [];
  for (let i = rawWords.length - 1; i >= 0 && words.length < ANCHOR_WINDOW_WORDS; i--) {
    const word = rawWords[i]!.toLowerCase().replace(/[^a-z]/g, "");
    if (!word || ANCHOR_STOPWORDS.has(word)) continue;
    words.push(word);
  }
  return words;
}

/**
 * Up to 2 real content words immediately after the selector (never crossing a clause boundary),
 * UNIONED with up to 2 real content words immediately before it (crossing clause boundaries, up to
 * the sentence start — see previousSentenceBoundary). Deliberately NOT a role-noun whitelist —
 * whatever word the text happens to use becomes the anchor. The backward half exists for D030 §3f's
 * real g17-wright-brothers-ordinal case: "the flight, the fourth and final one..." names the entity
 * BEFORE the ordinal, and the forward window alone only ever finds the placeholder "one" standing in
 * for it. Union, not replacement — backward words only add candidates, never remove a forward match.
 */
export function anchorWords(text: string, matchStart: number, matchEnd: number): Set<string> {
  const rest = text.slice(matchEnd);
  const clauseEnd = firstClauseBoundaryForward(rest);
  const window = clauseEnd === -1 ? rest : rest.slice(0, clauseEnd);
  const words: string[] = [];
  for (const raw of window.trim().split(/\s+/)) {
    const word = raw.toLowerCase().replace(/[^a-z]/g, "");
    if (!word || ANCHOR_STOPWORDS.has(word)) continue;
    words.push(word);
    if (words.length >= ANCHOR_WINDOW_WORDS) break;
  }
  return new Set([...words, ...backwardAnchorWords(text, matchStart)]);
}

export function anchorsOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const w of a) if (b.has(w)) return true;
  return false;
}

export interface InstanceSelector {
  /** Lowercase sequence word ("first", "fourth", ...). */
  selector: string;
  /** Up to 2 content words naming the repeated entity ("flight", "attempt trial", ...). */
  anchor: Set<string>;
}

/**
 * Only when the claim names exactly one selector+anchor — same one-shot scope as
 * applyReasonOrdinalGate (a compound claim with 2+ selectors, or a selector with no real content
 * word after it, abstains rather than guessing which one retrieval should care about).
 */
export function extractInstanceSelector(claimText: string): InstanceSelector | null {
  const matches = [...claimText.matchAll(SELECTOR_RE_G)];
  if (matches.length !== 1) return null;
  const m = matches[0]!;
  const anchor = anchorWords(claimText, m.index!, m.index! + m[0].length);
  if (anchor.size === 0) return null;
  return { selector: m[1]!.toLowerCase(), anchor };
}

/**
 * True when passageText names the SAME selector+anchor as the claim's — i.e. this passage is about
 * the specific instance the claim asked about, not just a passage that happens to share the claim's
 * other key terms. Additive signal only: used to ADMIT/rank a passage retrieval would otherwise
 * drop, never to reject a passage that lacks a selector at all (most real sentences don't repeat
 * "first"/"fourth" — dropping those would break ordinary retrieval, not fix it).
 */
export function passageMatchesSelector(sel: InstanceSelector, passageText: string): boolean {
  for (const m of passageText.matchAll(SELECTOR_RE_G)) {
    if (m[1]!.toLowerCase() !== sel.selector) continue;
    const anchor = anchorWords(passageText, m.index!, m.index! + m[0].length);
    if (anchorsOverlap(sel.anchor, anchor)) return true;
  }
  return false;
}
