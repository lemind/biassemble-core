import { BiasEntry } from "./bias-catalog";

// ─── Normalization helpers ──────────────────────────────────

/**
 * Normalize a bias label by lowercasing, stripping punctuation,
 * and collapsing whitespace.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute token overlap ratio between two strings.
 * Useful for fuzzy matching of bias labels.
 */
export function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = b.toLowerCase().split(/\s+/);
  const intersection = tokensB.filter((t) => tokensA.has(t));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.length / union.size;
}

/**
 * Compute Jaccard similarity between two sets of strings.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = a.filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Compute Levenshtein (edit) distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[m]![n]!;
}

/**
 * Normalized edit distance (0 = identical, 1 = completely different).
 */
export function normalizedEditDistance(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshtein(a, b) / maxLen;
}

/**
 * Find the best matching bias entry for a given label using
 * a combination of token overlap and normalized edit distance.
 * Returns the best match and its confidence score (0-1).
 */
export function findBestMatch(
  label: string,
  entries: BiasEntry[],
): { entry: BiasEntry; confidence: number } | null {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;

  let best: { entry: BiasEntry; confidence: number } | null = null;

  for (const entry of entries) {
    const entryNorm = normalizeLabel(entry.name);
    const overlap = tokenOverlap(normalized, entryNorm);
    const editDist = normalizedEditDistance(normalized, entryNorm);
    const confidence = overlap * 0.6 + (1 - editDist) * 0.4;

    if (!best || confidence > best.confidence) {
      best = { entry, confidence };
    }
  }

  return best;
}

/**
 * Normalize a bias name against the catalog.
 * Uses fuzzy matching to find the closest catalog entry.
 * Returns the matched catalog name and id if found, otherwise the original name.
 */
export function normalizeBiasName(
  name: string,
  catalog: BiasEntry[],
): { name: string; id?: string } {
  const match = findBestMatch(name, catalog);
  if (match && match.confidence > 0.5) {
    return { name: match.entry.name, id: match.entry.id };
  }
  return { name };
}

/**
 * Group bias entries by their category.
 */
export function groupByCategory(entries: BiasEntry[]): Map<string, BiasEntry[]> {
  const groups = new Map<string, BiasEntry[]>();
  for (const entry of entries) {
    const existing = groups.get(entry.category) ?? [];
    existing.push(entry);
    groups.set(entry.category, existing);
  }
  return groups;
}
