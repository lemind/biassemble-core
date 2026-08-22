/** Numbers a claim-relevant subset of a passage's sentences so VERIFY cites a NUMBER, not generated text. See D026 §7, §11. */

import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import { extractInstanceSelector, passageMatchesSelector } from "../../lib/instance-selector.js";

const MAX_SENTENCES = 20;

// Naive splitter — grounding safety doesn't depend on split quality, only citation readability does. D026 §7.
// The "\n" alternative is a hard split regardless of next-char case — hybrid-provider.ts's
// extractTextFromHtml inserts one at every HTML block-tag boundary (T050), since a punctuation-less
// nav/menu block otherwise fuses onto the next real sentence with no boundary to split on at all.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'“])|\n+/;

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
  // D030 §3f — a claim naming "the first flight" needs the sentence that actually discusses the
  // first flight to survive this cut even when it shares none of extractKeyTerms's own key terms
  // (a different flight's page can dominate scoring by number/entity alone — the g17 root cause).
  const selector = extractInstanceSelector(claimText);

  let selected: string[];
  if ((terms.length === 0 && !selector) || sentences.length <= maxSentences) {
    // Fail-open, same convention as isPassageRelevant (passage-filter.ts): nothing to score against.
    selected = sentences.slice(0, maxSentences);
  } else {
    const scored = sentences.map((text, i) => ({
      text,
      i,
      // Selector match counts as one matched term — additive, never a replacement for key-term
      // scoring, so it only rescues an otherwise-dropped sentence, never demotes a well-scoring one.
      score: scoreKeyTermMatches(terms, text) + (selector && passageMatchesSelector(selector, text) ? 1 : 0),
    }));
    const matching = scored.filter((s) => s.score > 0);
    const ranked = (matching.length > 0 ? matching : scored).sort((a, b) => b.score - a.score).slice(0, maxSentences);
    // Re-sort back into original passage order — numbering should read like the page; score only
    // decided which sentences made the cut, not the order they're presented in.
    selected = ranked.sort((a, b) => a.i - b.i).map((s) => s.text);
  }

  return selected.map((text, i) => ({ n: i + 1, text }));
}

/** Numbers each of up to MAX_VERIFY_PASSAGES ranked passages independently, grouped by source label ("A" = highest-ranked). D026 §11. */
export function buildPassageSentencesMulti(
  claimText: string,
  passages: Array<{ label: string; text: string }>,
  maxSentencesPerPassage = MAX_SENTENCES
): Record<string, PassageSentence[]> {
  const bySource: Record<string, PassageSentence[]> = {};
  for (const { label, text } of passages) {
    bySource[label] = buildPassageSentences(claimText, text, maxSentencesPerPassage);
  }
  return bySource;
}

/** D027 §2 — keyed by label/number, not URL yet; this module only knows sentence pools. */
export interface ResolvedCitation {
  source: string;
  sentence: number;
  text: string;
}

export interface ResolvedEvidenceFromCitations {
  evidence: string | null;
  citations: ResolvedCitation[];
}

/** Resolves citations to real text; unresolvable nulls both `evidence` and `citations` (D026 §11,
 * D027 §2). Preserves citation order, never merges same-source citations (D027 §3). */
export function resolveEvidenceFromCitations(
  citations: Array<{ source: string; n: number }> | null | undefined,
  sentencesBySource: Record<string, PassageSentence[]>
): ResolvedEvidenceFromCitations {
  if (!citations || citations.length === 0) return { evidence: null, citations: [] };
  const resolvedText: string[] = [];
  const resolvedCitations: ResolvedCitation[] = [];
  for (const { source, n } of citations) {
    // Reviewed finding — `source` is model output, so a plain-property lookup ("constructor",
    // "toString", "__proto__", ...) would resolve to an inherited value instead of undefined.
    if (!Object.prototype.hasOwnProperty.call(sentencesBySource, source)) return { evidence: null, citations: [] };
    const sentence = sentencesBySource[source]!.find((s) => s.n === n);
    if (!sentence) return { evidence: null, citations: [] };
    resolvedText.push(sentence.text);
    resolvedCitations.push({ source, sentence: n, text: sentence.text });
  }
  return { evidence: resolvedText.join(" ... "), citations: resolvedCitations };
}
