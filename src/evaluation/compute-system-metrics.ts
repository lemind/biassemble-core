/**
 * computeSystemMetrics — standalone pure function.
 *
 * Measures how often the LLM response required repair (schema parse failure).
 *
 * Input:  Array of `{ requiredRepair: boolean }` — one entry per LLM response.
 * Output: `{ schemaParseRate: number | null, repairRate: number | null }`
 *
 * Edge cases:
 * - Empty array → both rates are `null` (no data, distinguishable from 0%).
 *
 * Invariant:
 * - schemaParseRate + repairRate === 1.0 always (they are complements).
 *   Both returned for readability; only one needs to be stored if space is a concern.
 *
 * No side effects, no production imports.
 */

export interface SystemMetricsInput {
  requiredRepair: boolean;
}

export interface SystemMetricsOutput {
  schemaParseRate: number | null;
  repairRate: number | null;
}

export function computeSystemMetrics(
  responses: SystemMetricsInput[],
): SystemMetricsOutput {
  if (responses.length === 0) {
    return { schemaParseRate: null, repairRate: null };
  }

  const repairCount = responses.filter((r) => r.requiredRepair).length;
  const parseCount = responses.length - repairCount;

  // schemaParseRate + repairRate === 1.0 (complements)
  return {
    schemaParseRate: parseCount / responses.length,
    repairRate: repairCount / responses.length,
  };
}