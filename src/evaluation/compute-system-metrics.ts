import type {
  ReasoningTrace,
  BiasHypothesis,
} from "../contracts/reasoning.schemas";

// ─── System-level metrics ────────────────────────────────────
// These metrics assess the overall health of the reasoning
// pipeline, not the quality of individual assessments.

export interface SystemMetrics {
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

// ─── Compute ─────────────────────────────────────────────────

export function computeSystemMetrics(
  traces: ReasoningTrace[],
): SystemMetrics {
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
