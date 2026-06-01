/**
 * Fuzzy bias name → catalog ID normalization.
 *
 * Takes a raw bias name from LLM output (e.g. "confirmation bias",
 * "Confirmation Bias", "confirmation-bias") and attempts to match it
 * against the canonical catalog entries.
 *
 * Uses a simple token-overlap + Levenshtein heuristic — no external deps.
 */

import type { BiasEntry } from "./bias-catalog.js";

export interface NormalizationResult {
  /** Canonical catalog ID if a match was found, otherwise null. */
  id: string | null;
  /** Canonical display name from the catalog (or the original name if no match). */
  name: string;
  /** Confidence score 0–1. 1 = exact match, lower = fuzzy. */
  confidence: number;
}

/**
 * Normalize a raw bias name against the catalog.
 *
 * Matching strategy (in order of precedence):
 * 1. Exact match against catalog `id` (kebab-case)
 * 2. Exact match against catalog `name` (case-insensitive)
 * 3. Token-overlap match: if ≥ 50% of significant tokens overlap
 * 4. Levenshtein distance ≤ 3 on lowercased, stripped name
 */
export function normalizeBiasName(
  rawName: string,
  catalog: BiasEntry[]
): NormalizationResult {
  const cleaned = rawName.trim();

  // 1. Exact match against catalog id
  const byId = catalog.find((b) => b.id === cleaned);
  if (byId) {
    return { id: byId.id, name: byId.name, confidence: 1.0 };
  }

  // 2. Case-insensitive exact match against catalog name
  const lower = cleaned.toLowerCase();
  const byName = catalog.find((b) => b.name.toLowerCase() === lower);
  if (byName) {
    return { id: byName.id, name: byName.name, confidence: 1.0 };
  }

  // 3. Token-overlap match
  const inputTokens = tokenize(cleaned);
  let bestTokenOverlap: { entry: BiasEntry; overlap: number } | null = null;

  for (const bias of catalog) {
    const catalogTokens = tokenize(bias.name);
    const overlap = countOverlap(inputTokens, catalogTokens);
    const maxLen = Math.max(inputTokens.length, catalogTokens.length);
    const ratio = maxLen > 0 ? overlap / maxLen : 0;

    if (ratio >= 0.5 && (!bestTokenOverlap || overlap > bestTokenOverlap.overlap)) {
      bestTokenOverlap = { entry: bias, overlap };
    }
  }

  if (bestTokenOverlap !== null) {
    return {
      id: bestTokenOverlap.entry.id,
      name: bestTokenOverlap.entry.name,
      confidence: 0.8,
    };
  }

  // 4. Levenshtein distance ≤ 3 on lowercased, stripped name
  const stripped = lower.replace(/[^a-z0-9\s]/g, "").trim();
  let bestLevenshtein: { entry: BiasEntry; dist: number } | null = null;

  for (const bias of catalog) {
    const target = bias.name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const dist = levenshtein(stripped, target);
    if (dist <= 3 && (bestLevenshtein === null || dist < bestLevenshtein.dist)) {
      bestLevenshtein = { entry: bias, dist };
    }
  }

  if (bestLevenshtein !== null) {
    const confidence = Math.max(0, 1 - bestLevenshtein.dist * 0.15);
    return {
      id: bestLevenshtein.entry.id,
      name: bestLevenshtein.entry.name,
      confidence,
    };
  }

  // No match found
  return { id: null, name: cleaned, confidence: 0 };
}

// ─── Helpers ───────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2); // skip very short tokens
}

function countOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter((t) => setB.has(t)).length;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}
