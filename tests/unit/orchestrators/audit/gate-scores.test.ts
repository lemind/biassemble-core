import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { computeScores } from "../../../../src/orchestrators/audit/scores.js";
import type { Claim } from "../../../../src/db/schema.js";

type Verdict = "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable";

function makeClaim(verdict: Verdict, overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: randomUUID(),
    auditId: randomUUID(),
    type: "numeric",
    claimText: "claim text",
    excerpt: "claim text",
    locations: [],
    period: null,
    derived: false,
    passagesRetrievedCount: 1,
    retrievalStatus: "ok",
    verdict,
    evidence: null,
    sourceRefs: null,
    synthesized: false,
    confidence: 0.9,
    note: null,
    ...overrides,
  } as Claim;
}

function makeClaims(counts: Partial<Record<Verdict, number>>): Claim[] {
  const claims: Claim[] = [];
  for (const [verdict, n] of Object.entries(counts) as [Verdict, number][]) {
    for (let i = 0; i < n; i++) claims.push(makeClaim(verdict));
  }
  return claims;
}

describe("computeScores — D018 §4.1 worked example (20 S / 10 P / 0 U / 0 C)", () => {
  const claims = makeClaims({ supported: 20, partially_supported: 10 });
  const result = computeScores(claims, []);

  it("groundedness_score is 83 ((20 + 0.5*10)/30 = 83.33%, rounded)", () => {
    expect(result.groundedness_score).toBe(83);
  });

  it("strict_supported_rate is 20/30 (~67%)", () => {
    expect(result.strict_supported_rate).toBeCloseTo(20 / 30, 6);
  });

  it("eligible excludes unverifiable claims and counts is exact", () => {
    expect(result.eligible).toBe(30);
    expect(result.counts).toEqual({ S: 20, P: 10, U: 0, C: 0, X: 0 });
  });

  it("is not flagged low_decisiveness or insufficient_eligible_claims", () => {
    expect(result.low_decisiveness).toBe(false);
    expect(result.insufficient_eligible_claims).toBe(false);
  });
});

describe("computeScores — zero-denominator case (Eligible = 0)", () => {
  // Every claim unverifiable — S+P+U+C = 0.
  const claims = makeClaims({ unverifiable: 5 });
  const result = computeScores(claims, []);

  it("does not throw and marks insufficient_eligible_claims", () => {
    expect(result.insufficient_eligible_claims).toBe(true);
    expect(result.eligible).toBe(0);
  });

  it("all five rate fields are null, never NaN", () => {
    expect(result.grounded_rate).toBeNull();
    expect(result.groundedness_score).toBeNull();
    expect(result.strict_supported_rate).toBeNull();
    expect(result.contradiction_rate).toBeNull();
    expect(result.unsupported_rate).toBeNull();
  });

  it("low_decisiveness is true (100% unverifiable > 20% threshold)", () => {
    expect(result.low_decisiveness).toBe(true);
  });
});

describe("computeScores — avg_evidence_quality zero-vs-null distinction", () => {
  it("is null when zero claims have retrieval_coverage (mean of an empty set), not 0", () => {
    const claims = makeClaims({ supported: 1 }).map((c) => ({ ...c, passagesRetrievedCount: 0 }));
    const result = computeScores(claims, []);
    expect(result.retrieval_coverage).toBe(0);
    expect(result.avg_evidence_quality).toBeNull();
  });
});
