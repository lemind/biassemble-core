/**
 * Compute system-level health metrics for the reasoning pipeline.
 *
 * These metrics measure parser stability, schema stability, and model output
 * stability — NOT reasoning quality or ontology usage.
 *
 * ── Metrics ────────────────────────────────────────────────────────────────
 *
 * - `schemaParseRate`: proportion of raw LLM responses that were successfully
 *   parsed into the expected schema (first-pass, before repair).
 * - `repairRate`: proportion of failed-first-pass responses that were
 *   successfully repaired by the repair pipeline.
 *
 * Pure function — no side effects.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SystemMetrics {
  /** Total number of LLM responses processed */
  totalResponses: number;

  /** Number of responses that passed first-pass schema parsing */
  schemaParsePassCount: number;

  /** Proportion of responses that passed first-pass schema parsing (0–1) */
  schemaParseRate: number;

  /** Number of failed-first-pass responses that were sent to repair */
  repairAttemptCount: number;

  /** Number of repair attempts that succeeded */
  repairSuccessCount: number;

  /** Proportion of repair attempts that succeeded (0–1). Null when no repairs were attempted. */
  repairRate: number | null;
}

export interface LLMResponse {
  /** Whether the raw LLM output required repair (failed first-pass parse) */
  requiredRepair: boolean;

  /** Whether the repair was successful. Only meaningful when requiredRepair is true. */
  repairSucceeded?: boolean;
}

// ─── Compute ───────────────────────────────────────────────────────────────

export function computeSystemMetrics(
  responses: LLMResponse[],
): SystemMetrics {
  const totalResponses = responses.length;

  if (totalResponses === 0) {
    return {
      totalResponses: 0,
      schemaParsePassCount: 0,
      schemaParseRate: 0,
      repairAttemptCount: 0,
      repairSuccessCount: 0,
      repairRate: null,
    };
  }

  const schemaParsePassCount = responses.filter(
    (r) => !r.requiredRepair,
  ).length;

  const repairAttempts = responses.filter((r) => r.requiredRepair);
  const repairAttemptCount = repairAttempts.length;
  const repairSuccessCount = repairAttempts.filter(
    (r) => r.repairSucceeded === true,
  ).length;

  const schemaParseRate = schemaParsePassCount / totalResponses;
  const repairRate =
    repairAttemptCount > 0
      ? repairSuccessCount / repairAttemptCount
      : null;

  return {
    totalResponses,
    schemaParsePassCount,
    schemaParseRate,
    repairAttemptCount,
    repairSuccessCount,
    repairRate,
  };
}
