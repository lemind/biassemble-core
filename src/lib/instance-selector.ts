/**
 * Sequence-instance selector extraction (D030 §3f) — which OCCURRENCE of a repeated entity a claim
 * is about ("the first flight"). Consumed only by retrieval, never folded into claim-terms.ts's
 * extractKeyTerms (would change what gates.ts's already-validated gates admit as collateral damage).
 * Anchor-window machinery moved here from gates.ts's applyReasonOrdinalGate (D030 §3a) — shared, not copied.
 */

// "first".."tenth" only — no "last"/"final"/superlatives, see D030 §3e for why.
export const SEQUENCE_SELECTOR_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
// (?!-to-) rejects "second-to-last" compounds without also rejecting genuine ones like "first-place" (D030 §3a).
// (?<!...-) rejects "12-second"/"one-third": a hyphen is a word boundary, so \b alone matched inside them (D032 §10).
const HYPHEN_COMPOUND_PREFIX = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)-";
export const SELECTOR_RE_G = new RegExp(`(?<!${HYPHEN_COMPOUND_PREFIX})\\b(${SEQUENCE_SELECTOR_WORDS.join("|")})\\b(?!-to-)`, "gi");

// Decimal-safe sentence terminator ("$3.5 million" isn't a clause end) — D030 §3a.
export function isSentenceTerminator(text: string, index: number): boolean {
  if (text[index] !== ".") return true;
  return !(/\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? ""));
}

// Forward clause boundary for the anchor window below — D030 §3a. `fromIndex` (default 0, review
// finding) lets a caller scan from an arbitrary position instead of pre-slicing — reused as-is by
// gates-reason-grounded.ts's clause-scoped value lookup (D030 §3g follow-up) rather than duplicated.
export function firstClauseBoundaryForward(text: string, fromIndex = 0): number {
  for (let i = fromIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === ";" || ch === "," || ch === "!" || ch === "?") return i;
    if (ch === "." && isSentenceTerminator(text, i)) return i;
  }
  return -1;
}

// Generic words that don't count as an anchor on their own — D030 §3a.
const ANCHOR_STOPWORDS = new Set([
  "and", "the", "a", "an", "of", "in", "on", "at", "its", "his", "her", "their", "was", "is", "were",
  "also", "then", "to", "by", "for", "with", "that", "which", "who", "from", "has", "had", "have",
  "about", "as", "or", "but", "so", "this", "these", "those", "it", "not", "did", "does", "will",
  "would", "could", "over", "under", "into", "onto", "than", "there", "here",
]);
const ANCHOR_WINDOW_WORDS = 2;

// Backward scan crosses clause (comma) boundaries, unlike the forward one — catches an anaphoric
// "one" referring to a noun in an earlier appositive, e.g. "the flight, the fourth one" (D030 §3f).
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

/** Up to 2 content words after the selector, unioned with up to 2 before it — D030 §3a/§3f. */
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
  /** Up to 4 content words naming the repeated entity ("flight", "attempt trial", ...). */
  anchor: Set<string>;
}

/** Only when the claim names exactly one selector+anchor — abstains otherwise (D030 §3f). */
export function extractInstanceSelector(claimText: string): InstanceSelector | null {
  const matches = [...claimText.matchAll(SELECTOR_RE_G)];
  if (matches.length !== 1) return null;
  const m = matches[0]!;
  const anchor = anchorWords(claimText, m.index!, m.index! + m[0].length);
  if (anchor.size === 0) return null;
  return { selector: m[1]!.toLowerCase(), anchor };
}

/** Determiners that introduce a member selector, possessives included ("SpaceX's fourth launch"). */
const DETERMINER = "(?:the|its|his|her|their|our|my|your|[\\w\u2019']+['\u2019]s)";
const DETERMINER_BEFORE_RE = new RegExp(`(?:\\b|^)${DETERMINER}\\s+$`, "i");
/** Same determiners after a copula: there the ordinal is the assertion, not a selector. */
const PREDICATE_BEFORE_RE = new RegExp(`\\b(?:was|is|are|were|be|been|became|becomes|remains|ranked|as)\\s+(?:${DETERMINER}\\s+)?$`, "i");
/** Closed list of heads that make the ordinal part of a compound name or period, not a member. */
const COMPOUND_HEAD_RE = /^\s+(?:quarter|half|inning|world|amendment|avenue|street|lady|place|degree|person|edition|estate|reich|republic|crusade)\b/i;

/**
 * The FACT a claim asserts, with its member reference removed (D030 §3m Addendum 12).
 *
 * Refuses to strip unless the word is plainly a standalone member selector — a refusal costs a
 * missed catch; a wrong strip can force an unrecoverable `contradicted`.
 */
export function stripInstanceSelector(claimText: string): string {
  if (!extractInstanceSelector(claimText)) return claimText;
  // Exactly one match, guaranteed by extractInstanceSelector's own matches.length !== 1 abstention.
  const m = [...claimText.matchAll(SELECTOR_RE_G)][0];
  if (!m) return claimText;
  const start = m.index!;
  const end = start + m[0].length;
  const before = claimText.slice(0, start);
  // A member selector is a determiner + ordinal. Without this, "Tesla took first place", "Hamilton
  // finished third" and "First Republic Bank" all stripped into a different assertion (review).
  if (!DETERMINER_BEFORE_RE.test(before)) return claimText;
  const after = claimText.slice(end);
  // "the third of March", "one third of voters" — an of-phrase is a date or a fraction, not a member.
  if (/^\s+of\b/i.test(after)) return claimText;
  // "the first quarter", "the second world war" — a compound name or fiscal period, not a member.
  if (COMPOUND_HEAD_RE.test(after)) return claimText;
  // Hyphen compound: "third-quarter revenue" would strip to "-quarter revenue".
  if (claimText[start - 1] === "-" || claimText[end] === "-") return claimText;
  // Proper noun: "the Second Amendment" is a name, not the second of a set.
  if (/^[A-Z]/.test(m[0]!)) return claimText;
  // Predicate position: in "was the first landing" or "regarded as the second man" the ordinal IS
  // the assertion, not a selector.
  if (PREDICATE_BEFORE_RE.test(before)) return claimText;
  const stripped = (claimText.slice(0, start) + claimText.slice(end)).replace(/\s{2,}/g, " ").trim();
  // A strip that empties the claim or leaves only punctuation is worse than no strip at all.
  return /[a-z0-9]/i.test(stripped) ? stripped : claimText;
}

/** True when passageText names the same selector+anchor — additive admission signal only (D030 §3f). */
export function passageMatchesSelector(sel: InstanceSelector, passageText: string): boolean {
  for (const m of passageText.matchAll(SELECTOR_RE_G)) {
    if (m[1]!.toLowerCase() !== sel.selector) continue;
    const anchor = anchorWords(passageText, m.index!, m.index! + m[0].length);
    if (anchorsOverlap(sel.anchor, anchor)) return true;
  }
  return false;
}
