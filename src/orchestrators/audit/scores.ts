import type { Claim } from "../../db/schema.js";

/** Business metrics, computed on read (not yet persisted to score_summaries — interim, not final design). Formulas: D018 §4.1/§4.2. */

export interface ScoreSummaryResult {
  grounded_rate: number | null;
  groundedness_score: number | null;
  strict_supported_rate: number | null;
  contradiction_rate: number | null;
  unsupported_rate: number | null;
  retrieval_success_rate: number;
  retrieval_coverage: number;
  avg_evidence_quality: number | null;
  synthesized_count: number;
  counts: { S: number; P: number; U: number; C: number; X: number };
  eligible: number;
  low_decisiveness: boolean;
  insufficient_eligible_claims: boolean;
}

const LOW_DECISIVENESS_THRESHOLD = 0.2;

export function computeScores(
  claims: Claim[],
  claimPassages: Array<{ claimId: string; retrievalScore: number }>
): ScoreSummaryResult {
  const S = claims.filter((c) => c.verdict === "supported").length;
  const P = claims.filter((c) => c.verdict === "partially_supported").length;
  const U = claims.filter((c) => c.verdict === "unsupported").length;
  const C = claims.filter((c) => c.verdict === "contradicted").length;
  const X = claims.filter((c) => c.verdict === "unverifiable").length;
  const eligible = S + P + U + C;
  const total = claims.length;

  const rate = (n: number): number | null => (eligible === 0 ? null : n / eligible);
  const groundedRate = eligible === 0 ? null : (S + 0.5 * P) / eligible;

  const okClaims = claims.filter((c) => c.retrievalStatus === "ok");
  const coveredClaims = okClaims.filter((c) => c.passagesRetrievedCount > 0);
  const retrievalSuccessRate = total === 0 ? 0 : okClaims.length / total;
  const retrievalCoverage = total === 0 ? 0 : coveredClaims.length / total;

  const coveredClaimIds = new Set(coveredClaims.map((c) => c.claimId));
  const scoresForCovered = claimPassages.filter((cp) => coveredClaimIds.has(cp.claimId)).map((cp) => cp.retrievalScore);
  const avgEvidenceQuality =
    scoresForCovered.length === 0 ? null : scoresForCovered.reduce((a, b) => a + b, 0) / scoresForCovered.length;

  const synthesizedCount = claims.filter((c) => c.synthesized === true).length;
  const lowDecisiveness = total > 0 && X / total > LOW_DECISIVENESS_THRESHOLD;

  return {
    grounded_rate: groundedRate,
    groundedness_score: groundedRate === null ? null : Math.round(100 * groundedRate),
    strict_supported_rate: rate(S),
    contradiction_rate: rate(C),
    unsupported_rate: rate(U),
    retrieval_success_rate: retrievalSuccessRate,
    retrieval_coverage: retrievalCoverage,
    avg_evidence_quality: avgEvidenceQuality,
    synthesized_count: synthesizedCount,
    counts: { S, P, U, C, X },
    eligible,
    low_decisiveness: lowDecisiveness,
    insufficient_eligible_claims: eligible === 0,
  };
}
