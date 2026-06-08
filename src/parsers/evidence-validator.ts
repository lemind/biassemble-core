/**
 * Evidence Validator — T301
 *
 * Validates that every evidence excerpt in an assessment exists verbatim
 * in the original input story or answers. Rejects hallucinated quotes.
 *
 * ── Design decisions ─────────────────────────────────────────────────────
 *
 * - Matching is case-sensitive, trimmed. Spec (FR-011) requires "verbatim"
 *   matching — exact character-for-character reproduction. Consistent with
 *   computeEvaluationMetrics (T301 review fix — both use case-sensitive).
 * - Empty excerpts are always rejected (hallucination signal).
 * - A bias item with an empty evidence array is flagged as a violation
 *   (FR-001 requires non-empty evidence on each bias item).
 * - White-space differences beyond trimming are considered non-verbatim
 *   (e.g., extra spaces, newlines). This is strict by design.
 * - Pure function — no side effects, no production path imports.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface EvidenceEntry {
  source: "story" | "answer";
  excerpt: string;
  relevance: string;
}

export interface BiasItem {
  name: string;
  /** May be undefined (FR-001 violation), empty array, or populated. */
  evidence?: EvidenceEntry[];
}

export interface AssessmentInput {
  story: string;
  answers?: string[];
}

/** Discriminator for the three violation categories. */
export type ViolationType =
  | "no_evidence_entries"
  | "empty_excerpt"
  | "excerpt_not_in_input";

export interface Violation {
  biasName: string;
  excerpt: string;
  /** Discriminates violation category for programmatic consumers. */
  violationType: ViolationType;
  /** Human-readable description, for logs. */
  message: string;
}

export interface EvidenceValidationResult {
  valid: boolean;
  violations: Violation[];
}

// ─── Helper ─────────────────────────────────────────────────────────────

/**
 * Check whether `excerpt` appears verbatim (case-sensitive, trimmed) in
 * the story or any answer. Empty excerpts are always rejected.
 */
function excerptExistsInInput(
  excerpt: string,
  story: string,
  answers: string[],
): boolean {
  const trimmed = excerpt.trim();
  if (trimmed.length === 0) return false;
  if (story.includes(trimmed)) return true;
  return answers.some((answer) => answer.includes(trimmed));
}

// ─── Main function ──────────────────────────────────────────────────────

/**
 * Validate evidence in an assessment against the original input.
 *
 * @param assessment - The assessment output with bias items containing evidence.
 * @param input - The original story and optional answers.
 * @returns `{ valid, violations }` — `valid` is true iff there are zero violations.
 */
export function validateEvidence(
  assessment: { biases: BiasItem[] },
  input: AssessmentInput,
): EvidenceValidationResult {
  const violations: Violation[] = [];
  const answers = input.answers ?? [];

  for (const bias of assessment.biases) {
    const biasName = bias.name;
    const evidenceList = bias.evidence ?? [];

    // FR-001: Bias item without evidence is invalid
    if (evidenceList.length === 0) {
      violations.push({
        biasName,
        excerpt: "",
        violationType: "no_evidence_entries",
        message: `Bias "${biasName}" has no evidence entries (FR-001 requires non-empty evidence)`,
      });
      continue;
    }

    for (const evidence of evidenceList) {
      // Reject empty excerpts
      if (evidence.excerpt.trim().length === 0) {
        violations.push({
          biasName,
          excerpt: evidence.excerpt,
          violationType: "empty_excerpt",
          message: `Empty excerpt in evidence for bias "${biasName}"`,
        });
        continue;
      }

      // Reject excerpts not found verbatim in input
      if (!excerptExistsInInput(evidence.excerpt, input.story, answers)) {
        violations.push({
          biasName,
          excerpt: evidence.excerpt,
          violationType: "excerpt_not_in_input",
          message: `Excerpt "${evidence.excerpt}" not found verbatim in input (story or answers)`,
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}