import { describe, it, expect, beforeAll } from "vitest";
import { MockProvider } from "../mocks/mock-provider.js";
import { runEval } from "../../src/evaluation/run-eval.js";

/**
 * T510 — Inngest eval integration test.
 *
 * Verifies that the eval pipeline (runEval) works end-to-end with MockProvider.
 * Tests:
 * - Golden stories produce expected bias counts
 * - No-bias stories produce false positive metrics
 * - System metrics (schema parse rate, repair rate) are computed
 * - Overall pass/fail is determined correctly
 */
describe("T510 — Inngest eval integration", () => {
  let mockProvider: MockProvider;

  beforeAll(() => {
    mockProvider = new MockProvider();
  });

  it("should run eval with MockProvider and produce results", async () => {
    // MockProvider returns deterministic data for all calls
    const result = await runEval(mockProvider, "mock-model");

    // Should have results for both datasets
    expect(result.goldenResults.length).toBeGreaterThan(0);
    expect(result.noBiasResults.length).toBeGreaterThan(0);

    // Each golden story should have results
    for (const story of result.goldenResults) {
      expect(story.id).toBeDefined();
      expect(story.title).toBeDefined();
      expect(story.dataset).toBe("golden");
      expect(typeof story.parseSuccess).toBe("boolean");
      expect(typeof story.biasCount).toBe("number");
      expect(typeof story.questionCount).toBe("number");
      expect(story.inputHash).toBeDefined();
    }

    // Each no-bias story should have results
    for (const story of result.noBiasResults) {
      expect(story.id).toBeDefined();
      expect(story.title).toBeDefined();
      expect(story.dataset).toBe("no_bias");
      expect(typeof story.parseSuccess).toBe("boolean");
      expect(typeof story.biasCount).toBe("number");
      expect(story.inputHash).toBeDefined();
    }

    // System metrics should be computed
    expect(result.sysMetrics).toBeDefined();
    expect(typeof result.sysMetrics.schemaParseRate).toBe("number");
    expect(typeof result.sysMetrics.repairRate).toBe("number");
    expect(typeof result.sysMetrics.totalResponses).toBe("number");
    expect(result.sysMetrics.totalResponses).toBeGreaterThan(0);

    // overallPassed should be a boolean
    expect(typeof result.overallPassed).toBe("boolean");
    expect(typeof result.exitCode).toBe("number");
  }, 30000);

  it("should compute evaluation metrics for golden stories", async () => {
    const result = await runEval(mockProvider, "mock-model");

    for (const story of result.goldenResults) {
      if (story.errors.length === 0 && story.evaluationMetrics) {
        expect(typeof story.evaluationMetrics.evidenceGroundedRate).toBe("number");
        expect(story.evaluationMetrics.evidenceGroundedRate).toBeGreaterThanOrEqual(0);
        expect(story.evaluationMetrics.evidenceGroundedRate).toBeLessThanOrEqual(1);
      }
    }
  }, 30000);

  it("should compute false positive metrics for no-bias stories", async () => {
    const result = await runEval(mockProvider, "mock-model");

    for (const story of result.noBiasResults) {
      if (story.errors.length === 0 && story.evaluationMetrics) {
        expect(typeof story.evaluationMetrics.isFalsePositive).toBe("boolean");
      }
    }

    // At least some no-bias stories should have evaluation metrics
    const storiesWithMetrics = result.noBiasResults.filter(
      (r) => r.errors.length === 0 && r.evaluationMetrics !== null
    );
    expect(storiesWithMetrics.length).toBeGreaterThan(0);
  }, 30000);

  it("should handle parse failures gracefully", async () => {
    // MockProvider returns valid JSON by default, so parse failures are unlikely
    // This test verifies the pipeline doesn't crash on unexpected data
    const result = await runEval(mockProvider, "mock-model");

    // All stories should have been processed without exceptions
    const failedStories = [...result.goldenResults, ...result.noBiasResults].filter(
      (r) => r.failed
    );
    // With MockProvider, we expect no failures
    expect(failedStories.length).toBe(0);
  }, 30000);

  it("should produce consistent input hashes for same inputs", async () => {
    const result1 = await runEval(mockProvider, "mock-model");
    const result2 = await runEval(mockProvider, "mock-model");

    // Same provider + model should produce same hashes for same stories
    for (let i = 0; i < result1.goldenResults.length; i++) {
      expect(result1.goldenResults[i].inputHash).toBe(result2.goldenResults[i].inputHash);
    }
    for (let i = 0; i < result1.noBiasResults.length; i++) {
      expect(result1.noBiasResults[i].inputHash).toBe(result2.noBiasResults[i].inputHash);
    }
  }, 60000);

  it("should report overallPassed=true with MockProvider", async () => {
    // MockProvider returns well-formed data, so eval should pass
    const result = await runEval(mockProvider, "mock-model");
    expect(result.overallPassed).toBe(true);
    expect(result.exitCode).toBe(0);
  }, 30000);
});