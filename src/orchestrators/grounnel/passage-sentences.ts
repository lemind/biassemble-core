/** Numbers a claim-relevant subset of a passage's sentences so VERIFY cites a NUMBER, not generated text. See D026 §7, §11. */

import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import { extractInstanceSelector, passageMatchesSelector, SELECTOR_RE_G } from "../../lib/instance-selector.js";

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
  // Deterministic fact about the text (a sequence-position word it contains), not a relevance/correctness judgment — see D030 §3g follow-up.
  selector?: string;
}

// Sequence-selector word this sentence contains, if exactly one DISTINCT word appears — same source
// of truth extractInstanceSelector/passageMatchesSelector already use for retrieval (D030 §3f).
// Abstains (review finding) on 2+ distinct words rather than guess which one a value belongs to,
// e.g. "Not the first attempt, but the fourth flight covered 852 feet." — no negation/proximity
// analysis here (that lives in gates-reason-grounded.ts), so silence beats a possibly-wrong tag.
function detectSelectorWord(text: string): string | null {
  const words = new Set([...text.matchAll(SELECTOR_RE_G)].map((m) => m[1]!.toLowerCase()));
  return words.size === 1 ? [...words][0]! : null;
}

/** Selects and numbers up to `maxSentences` claim-relevant sentences, in original passage order.
 * Known gap, not fixed (same spirit as passage-filter.ts's D019 §2): coreference to a dropped sentence. */
export function buildPassageSentences(claimText: string, passageText: string, maxSentences = MAX_SENTENCES): PassageSentence[] {
  const sentences = splitIntoSentences(passageText);
  const terms = extractKeyTerms(claimText);

  let selected: string[];
  // extractKeyTerms's own D026 §21 stopword fallback already means terms.length === 0 implies no
  // instance-selector either (no SEQUENCE_SELECTOR_WORDS entry is a stopword, so one would always
  // survive that fallback) — selector only needs computing in the scored branch below.
  if (terms.length === 0 || sentences.length <= maxSentences) {
    // Fail-open, same convention as isPassageRelevant (passage-filter.ts): nothing to score against.
    selected = sentences.slice(0, maxSentences);
  } else {
    // D030 §3f — rescues the sentence matching the claim's instance-selector even at zero key-term
    // score (g17: a different instance's number/entity can otherwise dominate scoring entirely).
    const selector = extractInstanceSelector(claimText);
    const scored = sentences.map((text, i) => ({ text, i, score: scoreKeyTermMatches(terms, text) }));
    const matching = scored.filter((s) => s.score > 0);
    let ranked = (matching.length > 0 ? matching : scored).sort((a, b) => b.score - a.score).slice(0, maxSentences);

    // Review finding: an earlier additive-score version could tie a selector-only sentence with a
    // real key-term match and evict the real match by stable-sort position — the opposite of
    // "rescue." Instead: append when there's room; otherwise replace only the WEAKEST already-
    // selected sentence, so nothing with a higher real key-term score is ever bumped.
    if (selector && !ranked.some((r) => passageMatchesSelector(selector, r.text))) {
      const selectorMatch = scored.find((s) => passageMatchesSelector(selector, s.text));
      if (selectorMatch) {
        if (ranked.length < maxSentences) {
          ranked = [...ranked, selectorMatch];
        } else {
          const weakestIndex = ranked.reduce((worst, r, i) => (r.score < ranked[worst]!.score ? i : worst), 0);
          ranked = ranked.map((r, i) => (i === weakestIndex ? selectorMatch : r));
        }
      }
    }

    // Re-sort back into original passage order — numbering should read like the page; score only
    // decided which sentences made the cut, not the order they're presented in.
    selected = ranked.sort((a, b) => a.i - b.i).map((s) => s.text);
  }

  return selected.map((text, i) => {
    const selector = detectSelectorWord(text);
    return selector ? { n: i + 1, text, selector } : { n: i + 1, text };
  });
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
