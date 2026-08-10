/** Numbers a claim-relevant subset of a passage's sentences so VERIFY cites a NUMBER, not generated text. See D026 §7. */

import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";

const MAX_SENTENCES = 20;

// Naive splitter — grounding safety doesn't depend on split quality, only citation readability does. D026 §7.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'“])/;

export function splitIntoSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface PassageSentence {
  n: number;
  text: string;
}

/** Selects and numbers up to `maxSentences` claim-relevant sentences, in original passage order.
 * Known gap, not fixed (same spirit as passage-filter.ts's D019 §2): coreference to a dropped sentence. */
export function buildPassageSentences(claimText: string, passageText: string, maxSentences = MAX_SENTENCES): PassageSentence[] {
  const sentences = splitIntoSentences(passageText);
  const terms = extractKeyTerms(claimText);

  let selected: string[];
  if (terms.length === 0 || sentences.length <= maxSentences) {
    // Fail-open, same convention as isPassageRelevant (passage-filter.ts): nothing to score against.
    selected = sentences.slice(0, maxSentences);
  } else {
    const scored = sentences.map((text, i) => ({ text, i, score: scoreKeyTermMatches(terms, text) }));
    const matching = scored.filter((s) => s.score > 0);
    const ranked = (matching.length > 0 ? matching : scored).sort((a, b) => b.score - a.score).slice(0, maxSentences);
    // Re-sort back into original passage order — numbering should read like the page; score only
    // decided which sentences made the cut, not the order they're presented in.
    selected = ranked.sort((a, b) => a.i - b.i).map((s) => s.text);
  }

  return selected.map((text, i) => ({ n: i + 1, text }));
}

/** Resolves chosen sentence number(s) to real text. Any unresolvable id nulls the WHOLE answer — an invalid index isn't trustworthy. D026 §7. */
export function resolveEvidenceFromSentenceIds(sentenceIds: number[] | null | undefined, sentences: PassageSentence[]): string | null {
  if (!sentenceIds || sentenceIds.length === 0) return null;
  const byNumber = new Map(sentences.map((s) => [s.n, s.text]));
  const resolved: string[] = [];
  for (const id of sentenceIds) {
    const text = byNumber.get(id);
    if (text === undefined) return null;
    resolved.push(text);
  }
  return resolved.join(" ... ");
}
