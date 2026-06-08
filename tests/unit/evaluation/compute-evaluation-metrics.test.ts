import { describe, it, expect } from "vitest";
import { computeEvaluationMetrics } from "../../../src/evaluation/compute-evaluation-metrics";
import type { BiasItem, AssessmentInput } from "../../../src/evaluation/compute-evaluation-metrics";

function makeAssessment(biases: BiasItem[]) {
  return { biases };
}

function makeInput(overrides?: Partial<AssessmentInput>): AssessmentInput {
  return {
    story: "I only read news that confirms my political views. My colleague disagreed with me and I felt he was wrong. Later I realized I had dismissed his arguments without consideration.",
    answers: ["Yes, I think I ignored evidence that contradicted my position."],
    ...overrides,
  };
}

const groundedExcerpt = "I only read news that confirms my political views";
const groundedAnswerExcerpt = "ignored evidence that contradicted my position";
const nonGroundedExcerpt = "This is a hallucinated quote not in the input";

describe("computeEvaluationMetrics", () => {
  describe("evidenceGroundedRate", () => {
    it("returns 1.0 when all evidence is grounded", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "Shows selective exposure" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(1.0);
    });

    it("returns 1.0 when evidence comes from answers", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "answer", excerpt: groundedAnswerExcerpt, relevance: "Shows awareness" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(1.0);
    });

    it("returns a fraction when some evidence is grounded", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
        },
        {
          name: "Anchoring",
          evidence: [
            { source: "story", excerpt: nonGroundedExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(0.5);
    });

    it("returns 0.0 when no evidence is grounded", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: nonGroundedExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(0.0);
    });

    it("returns null when bias list is empty", () => {
      const assessment = makeAssessment([]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBeNull();
    });

    it("treats bias with empty evidence array as ungrounded", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(0.0);
    });

    it("treats bias with empty excerpt as ungrounded", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: "", relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(0.0);
    });

    it("rejects case-mismatched excerpts (case-sensitive matching)", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: "I ONLY READ NEWS", relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(0.0);
    });

    it("handles a bias with multiple evidence items (all must be grounded)", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
            { source: "answer", excerpt: groundedAnswerExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(1.0);
    });

    it("returns 0.0 when a bias has mixed grounded and non-grounded evidence", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
            { source: "story", excerpt: nonGroundedExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.evidenceGroundedRate).toBe(0.0);
    });
  });

  describe("isFalsePositive", () => {
    it("returns null when isNoBiasStory is not provided", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput());
      expect(result.isFalsePositive).toBeNull();
    });

    it("returns true for no_bias story when confidence exceeds default threshold (0.5)", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
          confidence: 0.7,
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput(), {
        isNoBiasStory: true,
      });
      expect(result.isFalsePositive).toBe(true);
    });

    it("returns false for no_bias story when confidence is below threshold", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
          confidence: 0.3,
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput(), {
        isNoBiasStory: true,
      });
      expect(result.isFalsePositive).toBe(false);
    });

    it("returns false for no_bias story when confidence exactly equals threshold", () => {
      const assessment = makeAssessment([
        {
          name: "Anchoring",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
          confidence: 0.4,
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput(), {
        isNoBiasStory: true,
        confidenceThreshold: 0.4,
      });
      expect(result.isFalsePositive).toBe(false);
    });

    it("treats missing confidence as above threshold (defaults to 1.0)", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput(), {
        isNoBiasStory: true,
      });
      expect(result.isFalsePositive).toBe(true);
    });

    it("returns false for no_bias story that returned no biases", () => {
      const assessment = makeAssessment([]);
      const result = computeEvaluationMetrics(assessment, makeInput(), {
        isNoBiasStory: true,
      });
      expect(result.isFalsePositive).toBe(false);
    });

    it("returns false for normal (non-no_bias) story with biases", () => {
      const assessment = makeAssessment([
        {
          name: "Confirmation Bias",
          evidence: [
            { source: "story", excerpt: groundedExcerpt, relevance: "" },
          ],
        },
      ]);
      const result = computeEvaluationMetrics(assessment, makeInput(), {
        isNoBiasStory: false,
      });
      expect(result.isFalsePositive).toBe(false);
    });
  });
});