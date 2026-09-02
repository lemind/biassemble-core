// Helpers shared by 2+ gate files (D031 file-size split, pure move). See gates.ts for the public barrel.

import type { GrounnelVerdictEnum } from "../../contracts/grounnel.schemas.js";
import type { z } from "zod";

export type Verdict = z.infer<typeof GrounnelVerdictEnum>;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Coarse entity guard — abstains when claim and evidence name disjoint proper nouns. Known,
// accepted gap: two people sharing a surname (father/son) still overlap and won't be caught.
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z'-]+\b/g;
// Month names are capitalized proper-noun-shaped tokens too, and these date-heavy pairs would otherwise defeat this guard on a shared month alone.
const SENTENCE_START_STOPWORDS = new Set(
  ["the", "he", "she", "they", "his", "her", "their", "a", "an", "in", "on", "at", "this", "that", "its", ...MONTH_NAMES].map((w) => w.toLowerCase())
);

export function properNounWords(text: string): Set<string> {
  const words = text.match(PROPER_NOUN_RE) ?? [];
  // Strips a trailing singular possessive ('s) so "Nauru's" set-matches bare "Nauru" (g17). Plural
  // possessives ("Wrights'") are a known, accepted gap — "Kansas'" vs "Wrights'" are indistinguishable text-only.
  return new Set(
    words
      .map((w) => w.toLowerCase().replace(/'s?$/, ""))
      .filter((w) => !SENTENCE_START_STOPWORDS.has(w))
  );
}

// D032 §9/§3k — a reason-family gate must not read a claim's own negation as confirming the negated
// fact. Narrower than gates-reason-grounded.ts's UNGROUNDED_REASON_NEGATION_WORD_RE (D031, a
// different check on reason text) by design, not oversight — see ADR for both mechanisms.
export const NEGATION_CUE_RE = /\bnot\b|n't|\bno\b|\bnone\b|\bnever\b/i;

// Presence-only (no clause scoping) — accepted precision tradeoff, see D032 §9c: reason_consistency
// has no single extracted token to scope a check around, unlike reason_year/reason_ordinal's
// position-scoped isNegatedAtPosition/isClaimTokenNegated in gates-reason-grounded.ts.
export function containsNegationCue(claimText: string): boolean {
  return NEGATION_CUE_RE.test(claimText);
}

// NAME OVERCLAIMS: this is literal proper-noun overlap, NOT entity resolution — "Wilbur" vs "Wright
// brothers" reads as different entities. Measured cost and four refuted fixes: D030 §3l/§3m/§3n.
// Shared by applyYearGate and applySubjectEntityGate. Abstains only when BOTH sides name at least
// one proper noun and share none — pronoun-only text is left to the date comparison alone.
export function sameEntity(claimText: string, evidenceText: string): boolean {
  const claimNames = properNounWords(claimText);
  const evidenceNames = properNounWords(evidenceText);
  if (claimNames.size === 0 || evidenceNames.size === 0) return true;
  return [...claimNames].some((n) => evidenceNames.has(n));
}
