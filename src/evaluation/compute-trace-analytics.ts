/**
 * Compute reasoning analytics from a set of reasoning traces.
 *
 * These metrics measure reasoning behavior, ontology usage, and model
 * tendencies — NOT system health (parser stability, repair rates).
 *
 * ── Metrics ────────────────────────────────────────────────────────────────
 *
 * - `avgConfidence`: average confidence across all bias hypotheses.
 * - `uniqueBiasNames`: number of distinct bias names detected.
 * - `biasNameDistribution`: map of bias name → count across all traces.
 * - `avgHypothesesPerTrace`: average number of bias hypotheses per trace.
 * - `tracesWithBias`: number of traces containing at least one hypothesis.
 * - `avgExcerptsPerHypothesis`: average number of supporting excerpts.
 * - `excerptCoverageRate`: proportion of hypotheses with ≥1 excerpt.
 *
 * Pure function — no side effects.
 */

import type { ReasoningTrace, BiasHypothesis } from "../contracts/reasoning.schemas";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TraceAnalytics {
  /** Total number of traces processed */
  totalTraces: number;

  /** Number of traces that contain at least one bias hypothesis */
  tracesWithBias: number;

  /** Average number of bias hypotheses per trace */
  avgHypothesesPerTrace: number;

  /** Average confidence across all bias hypotheses */
  avgConfidence: number;

  /** Number of unique bias names detected across all traces */
  uniqueBiasNames: number;

  /** Distribution of bias names across all traces (name → count) */
  biasNameDistribution: Record<string, number>;

  /** Average number of supporting excerpts per hypothesis */
  avgExcerptsPerHypothesis: number;

  /** Percentage of hypotheses that have at least one supporting excerpt */
  excerptCoverageRate: number;
}

// ─── Compute ───────────────────────────────────────────────────────────────

export function computeTraceAnalytics(
  traces: ReasoningTrace[],
): TraceAnalytics {
  if (traces.length === 0) {
    return {
      totalTraces: 0,
      tracesWithBias: 0,
      avgHypothesesPerTrace: 0,
      avgConfidence: 0,
      uniqueBiasNames: 0,
      biasNameDistribution: {},
      avgExcerptsPerHypothesis: 0,
      excerptCoverageRate: 0,
    };
  }

  const allHypotheses: BiasHypothesis[] = [];
  const biasNameCounts: Record<string, number> = {};
  let tracesWithBiasCount = 0;

  for (const trace of traces) {
    // Defensive ?? [] — data comes from JSONB column, Zod parse may not have been applied upstream.
    // ReasoningTrace.bias_hypotheses is non-nullable in the Zod schema, but at runtime
    // the JSONB value could be null or missing if the caller passed raw DB rows.
    const hypotheses = trace.bias_hypotheses ?? [];
    allHypotheses.push(...hypotheses);

    if (hypotheses.length > 0) {
      tracesWithBiasCount++;
    }

    for (const h of hypotheses) {
      const name = h.bias_name;
      biasNameCounts[name] = (biasNameCounts[name] ?? 0) + 1;
    }
  }

  const totalHypotheses = allHypotheses.length;
  const avgHypothesesPerTrace = totalHypotheses / traces.length;

  const totalConfidence = allHypotheses.reduce(
    (sum, h) => sum + h.confidence,
    0,
  );
  const avgConfidence =
    totalHypotheses > 0 ? totalConfidence / totalHypotheses : 0;

  const uniqueBiasNames = Object.keys(biasNameCounts).length;

  let totalExcerpts = 0;
  let hypothesesWithExcerpts = 0;

  for (const h of allHypotheses) {
    const excerpts = h.supporting_excerpts ?? [];
    totalExcerpts += excerpts.length;
    if (excerpts.length > 0) {
      hypothesesWithExcerpts++;
    }
  }

  const avgExcerptsPerHypothesis =
    totalHypotheses > 0 ? totalExcerpts / totalHypotheses : 0;

  const excerptCoverageRate =
    totalHypotheses > 0 ? hypothesesWithExcerpts / totalHypotheses : 0;

  return {
    totalTraces: traces.length,
    tracesWithBias: tracesWithBiasCount,
    avgHypothesesPerTrace,
    avgConfidence,
    uniqueBiasNames,
    biasNameDistribution: biasNameCounts,
    avgExcerptsPerHypothesis,
    excerptCoverageRate,
  };
}
