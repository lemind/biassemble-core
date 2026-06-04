import { describe, it, expect } from "vitest";
import {
  computeSystemMetrics,
  type SystemMetrics,
} from "../../../src/evaluation/compute-system-metrics";
import type { ReasoningTrace } from "../../../src/contracts/reasoning.schemas";

// ─── Helpers ─────────────────────────────────────────────────

function makeTrace(overrides?: Partial<ReasoningTrace>): ReasoningTrace {
  return {
    story_analysis: {
      themes: [],
      emotional_tone: "neutral",
      key_events: [],
    },
    interpretations: [],
    bias_hypotheses: [],
    evidence_mapping: [],
    prompt_version: "test:abc:1.0.0" as ReasoningTrace["prompt_version"],
    ...overrides,
  };
}

function makeHypothesis(overrides?: {
  bias_name?: string;
  confidence?: number;
  supporting_excerpts?: string[];
  uncertainty_reasons?: string[];
}) {
  return {
    bias_name: "Confirmation Bias",
    confidence: 0.85,
    supporting_excerpts: ["excerpt 1"],
    uncertainty_reasons: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("computeSystemMetrics", () => {
  it("returns zero metrics for empty traces array", () => {
    const result = computeSystemMetrics([]);
    expect(result).toEqual<SystemMetrics>({
      totalTraces: 0,
      tracesWithBias: 0,
      avgHypothesesPerTrace: 0,
      avgConfidence: 0,
      uniqueBiasNames: 0,
      biasNameDistribution: {},
      avgExcerptsPerHypothesis: 0,
      excerptCoverageRate: 0,
    });
  });

  it("counts total traces and traces with bias", () => {
    const traces = [
      makeTrace({ bias_hypotheses: [makeHypothesis()] }),
      makeTrace({ bias_hypotheses: [] }),
      makeTrace({ bias_hypotheses: [makeHypothesis()] }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.totalTraces).toBe(3);
    expect(result.tracesWithBias).toBe(2);
  });

  it("computes average hypotheses per trace", () => {
    const traces = [
      makeTrace({
        bias_hypotheses: [
          makeHypothesis(),
          makeHypothesis({ bias_name: "Anchoring" }),
        ],
      }),
      makeTrace({
        bias_hypotheses: [makeHypothesis()],
      }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.avgHypothesesPerTrace).toBe(1.5);
  });

  it("computes average confidence across all hypotheses", () => {
    const traces = [
      makeTrace({
        bias_hypotheses: [
          makeHypothesis({ confidence: 0.9 }),
          makeHypothesis({ confidence: 0.7 }),
        ],
      }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.avgConfidence).toBe(0.8);
  });

  it("counts unique bias names and builds distribution", () => {
    const traces = [
      makeTrace({
        bias_hypotheses: [
          makeHypothesis({ bias_name: "Confirmation Bias" }),
          makeHypothesis({ bias_name: "Anchoring" }),
        ],
      }),
      makeTrace({
        bias_hypotheses: [
          makeHypothesis({ bias_name: "Confirmation Bias" }),
        ],
      }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.uniqueBiasNames).toBe(2);
    expect(result.biasNameDistribution).toEqual({
      "Confirmation Bias": 2,
      Anchoring: 1,
    });
  });

  it("computes average excerpts per hypothesis", () => {
    const traces = [
      makeTrace({
        bias_hypotheses: [
          makeHypothesis({ supporting_excerpts: ["a", "b"] }),
          makeHypothesis({ supporting_excerpts: ["c"] }),
        ],
      }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.avgExcerptsPerHypothesis).toBe(1.5);
  });

  it("computes excerpt coverage rate", () => {
    const traces = [
      makeTrace({
        bias_hypotheses: [
          makeHypothesis({ supporting_excerpts: ["a"] }),
          makeHypothesis({ supporting_excerpts: [] }),
          makeHypothesis({ supporting_excerpts: ["b", "c"] }),
        ],
      }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.excerptCoverageRate).toBeCloseTo(2 / 3);
  });

  it("handles hypotheses with no supporting excerpts gracefully", () => {
    const traces = [
      makeTrace({
        bias_hypotheses: [
          makeHypothesis({ supporting_excerpts: [] }),
        ],
      }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.avgExcerptsPerHypothesis).toBe(0);
    expect(result.excerptCoverageRate).toBe(0);
  });

  it("handles traces with no bias_hypotheses field gracefully", () => {
    const traces = [
      makeTrace({ bias_hypotheses: undefined as unknown as [] }),
    ];

    const result = computeSystemMetrics(traces);
    expect(result.totalTraces).toBe(1);
    expect(result.tracesWithBias).toBe(0);
    expect(result.avgHypothesesPerTrace).toBe(0);
  });
});
