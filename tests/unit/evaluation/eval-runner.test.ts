import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDataset } from "../../../src/evaluation/eval-runner.js";
import type { DatasetRunConfig, DatasetRunDeps } from "../../../src/evaluation/eval-runner.js";
import type { AssessmentOutput } from "../../../src/contracts/reflection.schemas.js";
import type { StoryBase } from "../../../src/evaluation/run-eval.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_ASSESSMENT: AssessmentOutput = {
  biases: [
    {
      name: "confirmation_bias",
      explanation: "Test explanation for confirmation bias detection",
      storyConnection: "Connected to the user story in a meaningful way",
      alternativePerspective: "An alternative perspective on the situation",
      evidence: [{ source: "story", excerpt: "test excerpt from the story", relevance: "relevant to bias" }],
    },
  ],
  reflectionPrompt: "Test reflection prompt for the user",
  prompt_version: "assessment-v1.0.0",
  schema_version: "1.0.0",
  noBiasDetected: false,
  modelName: "mock-model",
};

const STORY_A: StoryBase = { id: "story-a", title: "Story A", story: "Story A text about a person making a decision.", tags: [] };
const STORY_B: StoryBase = { id: "story-b", title: "Story B", story: "Story B text about someone facing a challenge.", tags: [] };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("runDataset", () => {
  const mockAssessmentService = { generate: vi.fn() };
  const mockEvalResultStore = { persistResult: vi.fn() };
  const mockPromptRegistry = { getVersion: vi.fn() };

  const deps: DatasetRunDeps = {
    assessmentService: mockAssessmentService,
    evalResultStore: mockEvalResultStore,
    promptRegistry: mockPromptRegistry,
  };

  const makeConfig = (overrides?: Partial<DatasetRunConfig>): DatasetRunConfig => ({
    datasetName: "golden",
    stories: [STORY_A, STORY_B],
    provider: "gemini",
    modelName: "gemini-2.5-flash",
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssessmentService.generate.mockResolvedValue(MOCK_ASSESSMENT);
    mockEvalResultStore.persistResult.mockResolvedValue({ id: "result-id", runAt: new Date().toISOString() });
    mockPromptRegistry.getVersion.mockReturnValue("assessment-v1.0.0");
  });

  // ── persistResult contract ─────────────────────────────────────────────────

  describe("persistResult contract", () => {
    it("calls persistResult once per story", async () => {
      await runDataset(makeConfig(), deps);
      expect(mockEvalResultStore.persistResult).toHaveBeenCalledTimes(2);
    });

    it("all calls share the same evalRunId", async () => {
      await runDataset(makeConfig(), deps);
      const calls = mockEvalResultStore.persistResult.mock.calls;
      expect(calls[0][0].evalRunId).toBe(calls[1][0].evalRunId);
      expect(calls[0][0].evalRunId).not.toBeNull();
    });

    it("evalRunId is a valid UUID", async () => {
      await runDataset(makeConfig(), deps);
      const { evalRunId } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(evalRunId).toMatch(UUID_PATTERN);
    });

    it("sets scenarioId from story.id for each story", async () => {
      await runDataset(makeConfig(), deps);
      const scenarioIds = mockEvalResultStore.persistResult.mock.calls.map(
        (call: any[]) => call[0].scenarioId,
      );
      expect(scenarioIds).toContain("story-a");
      expect(scenarioIds).toContain("story-b");
    });

    it("sets rawOutput as JSON.stringify of the assessment output", async () => {
      await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      const { rawOutput } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(rawOutput).toBe(JSON.stringify(MOCK_ASSESSMENT));
    });

    it("rawOutput is parseable JSON and not [object Object]", async () => {
      await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      const { rawOutput } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(rawOutput).not.toContain("[object Object]");
      expect(() => JSON.parse(rawOutput)).not.toThrow();
      expect(JSON.parse(rawOutput).noBiasDetected).toBe(false);
    });

    it("sets provider from config", async () => {
      await runDataset(makeConfig({ stories: [STORY_A], provider: "openai" }), deps);
      const { provider } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(provider).toBe("openai");
    });

    it("sets modelName from config", async () => {
      await runDataset(makeConfig({ stories: [STORY_A], modelName: "gpt-4o" }), deps);
      const { modelName } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(modelName).toBe("gpt-4o");
    });

    it("sets dataset from config", async () => {
      await runDataset(makeConfig({ stories: [STORY_A], datasetName: "no_bias" }), deps);
      const { dataset } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(dataset).toBe("no_bias");
    });

    it("always sets passed to false", async () => {
      await runDataset(makeConfig(), deps);
      for (const call of mockEvalResultStore.persistResult.mock.calls) {
        expect(call[0].passed).toBe(false);
      }
    });

    it("sets evaluationMetrics as an object", async () => {
      await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      const { evaluationMetrics } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(evaluationMetrics).toBeDefined();
      expect(typeof evaluationMetrics).toBe("object");
      expect(evaluationMetrics).not.toBeNull();
    });

    it("sets systemMetrics as an object", async () => {
      await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      const { systemMetrics } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(systemMetrics).toBeDefined();
      expect(typeof systemMetrics).toBe("object");
      expect(systemMetrics).not.toBeNull();
    });

    it("uses promptRegistry version for promptVersion", async () => {
      mockPromptRegistry.getVersion.mockReturnValue("assessment-v2.0.0");
      await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      const { promptVersion } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(promptVersion).toBe("assessment-v2.0.0");
    });
  });

  // ── assessmentService call ─────────────────────────────────────────────────

  describe("assessmentService call", () => {
    it("calls generate with story text, empty questions, empty answers", async () => {
      await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      expect(mockAssessmentService.generate).toHaveBeenCalledWith(
        STORY_A.story,
        [],
        [],
        expect.any(String),
      );
    });

    it("calls generate once per story", async () => {
      await runDataset(makeConfig(), deps);
      expect(mockAssessmentService.generate).toHaveBeenCalledTimes(2);
    });
  });

  // ── return value ───────────────────────────────────────────────────────────

  describe("return value", () => {
    it("returns totalScenarios equal to stories array length", async () => {
      const result = await runDataset(makeConfig(), deps);
      expect(result.totalScenarios).toBe(2);
    });

    it("returns successCount equal to stories that completed", async () => {
      const result = await runDataset(makeConfig(), deps);
      expect(result.successCount).toBe(2);
    });

    it("returns zero errorCount when all stories succeed", async () => {
      const result = await runDataset(makeConfig(), deps);
      expect(result.errorCount).toBe(0);
    });

    it("returns the evalRunId that was used in persistResult calls", async () => {
      const result = await runDataset(makeConfig(), deps);
      const { evalRunId } = mockEvalResultStore.persistResult.mock.calls[0][0];
      expect(result.evalRunId).toBe(evalRunId);
    });

    it("generates a new evalRunId on each invocation", async () => {
      const first = await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      const second = await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      expect(first.evalRunId).not.toBe(second.evalRunId);
    });
  });

  // ── error handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("does not propagate individual story errors", async () => {
      mockAssessmentService.generate.mockRejectedValue(new Error("LLM failed"));
      await expect(runDataset(makeConfig({ stories: [STORY_A] }), deps)).resolves.toBeDefined();
    });

    it("increments errorCount when a story assessment fails", async () => {
      mockAssessmentService.generate
        .mockRejectedValueOnce(new Error("LLM failed"))
        .mockResolvedValueOnce(MOCK_ASSESSMENT);
      const result = await runDataset(makeConfig(), deps);
      expect(result.errorCount).toBe(1);
    });

    it("continues processing remaining stories after one fails", async () => {
      mockAssessmentService.generate
        .mockRejectedValueOnce(new Error("LLM failed"))
        .mockResolvedValueOnce(MOCK_ASSESSMENT);
      const result = await runDataset(makeConfig(), deps);
      expect(result.successCount).toBe(1);
      expect(result.totalScenarios).toBe(2);
    });

    it("does not call persistResult for failed stories", async () => {
      mockAssessmentService.generate
        .mockRejectedValueOnce(new Error("LLM failed"))
        .mockResolvedValueOnce(MOCK_ASSESSMENT);
      await runDataset(makeConfig(), deps);
      expect(mockEvalResultStore.persistResult).toHaveBeenCalledTimes(1);
    });

    it("handles all stories failing gracefully", async () => {
      mockAssessmentService.generate.mockRejectedValue(new Error("all failed"));
      const result = await runDataset(makeConfig(), deps);
      expect(result.successCount).toBe(0);
      expect(result.errorCount).toBe(2);
      expect(mockEvalResultStore.persistResult).not.toHaveBeenCalled();
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty stories array", async () => {
      const result = await runDataset(makeConfig({ stories: [] }), deps);
      expect(result.totalScenarios).toBe(0);
      expect(result.successCount).toBe(0);
      expect(result.errorCount).toBe(0);
      expect(mockEvalResultStore.persistResult).not.toHaveBeenCalled();
    });

    it("handles single story", async () => {
      const result = await runDataset(makeConfig({ stories: [STORY_A] }), deps);
      expect(result.totalScenarios).toBe(1);
      expect(result.successCount).toBe(1);
      expect(result.errorCount).toBe(0);
      expect(mockEvalResultStore.persistResult).toHaveBeenCalledTimes(1);
    });
  });
});
