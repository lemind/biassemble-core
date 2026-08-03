import { generatePassageId } from "../lib/audit-identifiers.js";

/**
 * Naive lexical retrieval stub over a request's own sources[] (research.md §1,
 * corrected design). No fixture-reference field — this works identically for
 * any submitted sources[], golden-set excerpts or genuinely new material.
 *
 * Chunked once per audit (paragraph-level), not per claim — the source set is
 * fixed for the whole audit, only the per-claim scoring differs. This is also
 * what gives SourcePassage deduplication "for free": one passage_id per
 * paragraph, reused across every claim's ClaimPassage rows, never recreated.
 */

export interface AuditSourceInput {
  id: string;
  name: string;
  text: string;
}

export interface CorpusPassage {
  passageId: string;
  docId: string;
  location: string | null;
  text: string;
}

export interface RetrievedPassage extends CorpusPassage {
  rank: number;
  score: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:[.,][0-9]+)*/g) ?? [];
}

/** Word-overlap score, numeric tokens weighted higher — they're the strongest signal in financial claim text. */
function lexicalScore(claimTokens: string[], passage: string): number {
  if (claimTokens.length === 0) return 0;
  const passageTokens = new Set(tokenize(passage));
  let weightedHits = 0;
  let totalWeight = 0;
  for (const token of claimTokens) {
    const weight = /\d/.test(token) ? 3 : 1;
    totalWeight += weight;
    if (passageTokens.has(token)) weightedHits += weight;
  }
  return totalWeight === 0 ? 0 : weightedHits / totalWeight;
}

export class CorpusClient {
  private passages: CorpusPassage[];

  constructor(sources: AuditSourceInput[]) {
    this.passages = sources.flatMap((source) => chunkSource(source));
  }

  getAllPassages(): CorpusPassage[] {
    return this.passages;
  }

  /**
   * Scores all passages against a claim's text, returns the top `topK`
   * ranked by relevance. Can throw (empty/invalid input, or a future real
   * retrieval backend's network failure) — callers must catch and set
   * retrieval_status = "error", never let a throw silently collapse into
   * "found zero" (data-model.md's retrieval-failure gate rule).
   */
  retrieveForClaim(claimText: string, topK: number): RetrievedPassage[] {
    if (!claimText || claimText.trim().length === 0) {
      throw new Error("retrieveForClaim: claimText must be non-empty");
    }
    const claimTokens = tokenize(claimText);
    const scored = this.passages
      .map((p) => ({ ...p, score: lexicalScore(claimTokens, p.text) }))
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored.map((p, i) => ({ ...p, rank: i + 1 }));
  }
}

function chunkSource(source: AuditSourceInput): CorpusPassage[] {
  const paragraphs = source.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // A single-paragraph source (no blank-line breaks — e.g. a one-line table
  // excerpt) is one passage, not zero.
  const chunks = paragraphs.length > 0 ? paragraphs : [source.text.trim()];
  return chunks
    .filter((text) => text.length > 0)
    .map((text, i) => ({
      passageId: generatePassageId(),
      docId: source.id,
      location: `${source.id}:p${i + 1}`,
      text,
    }));
}
