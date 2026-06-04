/**
 * Compute evaluation metrics for bias assessment quality.
 *
 * - `evidenceGroundedRate`: proportion of bias items whose evidence excerpts
 *   appear (case-insensitive) in the input story or answers. Returns `null`
 *   when bias list is empty.
 * - `isFalsePositive`: returns `true` if `isNoBiasStory` is set and biases
 *   were returned, `false` otherwise. Returns `null` if `isNoBiasStory` is
 *   not provided (computed externally across a dataset).
 *
 * Pure function — no side effects, no imports from production path.
 *
 * ── Design decisions ─────────────────────────────────────────────────────
 *
 * - Excerpt matching is case-insensitive. LLM output may normalize casing
 *   ("He was angry" vs "he was angry"), and case-insensitive matching
 *   prevents false negatives while preserving semantic verbatim checking.
 * - Empty excerpts are rejected (hallucination signal).
 * - A bias item with an empty evidence array is treated as ungrounded
 *   (FR-001 requires non-empty evidence).
 * - `isFalsePositive` is a per-assessment boolean, not a rate. The actual
 *   false-positive rate is computed at the dataset level in T303/T304.
 */

// ─── Local types (inline until T001 reasoning.schemas.ts exists) ─────────

export interface EvidenceEntry {
  source: "story" | "answer";
  excerpt: string;
  relevance: string;
}

export interface BiasItem {
  name: string;
  evidence: EvidenceEntry[];
}

export interface AssessmentInput {
  story: string;
  answers?: string[];
}

export interface EvaluationMetrics {
  evidenceGroundedRate: number | null;
  isFalsePositive: boolean | null;
}

export interface ComputeEvaluationMetricsOptions {
  /** Set to true when the assessment was run against a no_bias story. */
  isNoBiasStory?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Check whether `excerpt` appears (case-insensitive, trimmed) in the story
 * or any answer. Empty excerpts are rejected.
 */
function excerptExistsInInput(
  excerpt: string,
  story: string,
  answers: string[],
): boolean {
  const normalized = excerpt.toLowerCase().trim();
  if (normalized.length === 0) return false;
  if (story.toLowerCase().includes(normalized)) return true;
  return answers.some((answer) => answer.toLowerCase().includes(normalized));
}

// ─── Main function ──────────────────────────────────────────────────────

export function computeEvaluationMetrics(
  assessment: { biases: BiasItem[] },
  input: AssessmentInput,
  options?: ComputeEvaluationMetricsOptions,
): EvaluationMetrics {
  const { biases } = assessment;
  const answers = input.answers ?? [];

  // ── evidenceGroundedRate ─────────────────────────────────────────
  let evidenceGroundedRate: number | null;

  if (biases.length === 0) {
    evidenceGroundedRate = null;
  } else {
    const groundedCount = biases.filter((bias) => {
      if (bias.evidence.length === 0) return false;
      return bias.evidence.every((e) =>
        excerptExistsInInput(e.excerpt, input.story, answers),
      );
    }).length;
    evidenceGroundedRate = groundedCount / biases.length;
  }

  // ── isFalsePositive ──────────────────────────────────────────────
  let isFalsePositive: boolean | null;

  if (options?.isNoBiasStory === undefined) {
    isFalsePositive = null;
  } else if (options.isNoBiasStory && biases.length > 0) {
    isFalsePositive = true;
  } else {
    isFalsePositive = false;
  }

  return { evidenceGroundedRate, isFalsePositive };
}