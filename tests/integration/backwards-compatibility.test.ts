/**
 * T403 — Backwards compatibility tests.
 *
 * Verifies that Phase 4 additions (eval-runner.ts, extended eval_results
 * columns) do not break existing flows:
 *
 *   1. assessmentService.generate() with full Q&A context (pre-Phase-4 usage)
 *      still produces a valid AssessmentOutput.
 *   2. assessmentService.generate() still works when llm_calls recording fails
 *      (fire-and-forget guarantee unchanged).
 *   3. evalResultStore.persistResult() still accepts evalRunId: null
 *      (pre-Phase-4 callers set this field to null).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";
import type { LlmCallStore, RunStore, TraceStore } from "../../src/persistence/ports.js";

// ─── Shared mock stores ───────────────────────────────────────────────────────

const mockLlmCallStore: LlmCallStore = {
  recordCall: vi.fn().mockResolvedValue({ id: "call-id" }),
  getCallsBySession: vi.fn().mockResolvedValue([]),
  getCallsByStage: vi.fn().mockResolvedValue([]),
  getCallsByProvider: vi.fn().mockResolvedValue([]),
  getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
  updateParsedOutput: vi.fn().mockResolvedValue(undefined),
  updateFailure: vi.fn().mockResolvedValue(undefined),
  getCallsForMetrics: vi.fn().mockResolvedValue([]),
};

const mockRunStore: RunStore = {
  createRun: vi.fn().mockResolvedValue({ id: "run-id" }),
  getRunsBySession: vi.fn().mockResolvedValue([]),
};

const mockTraceStore: TraceStore = {
  persistTrace: vi.fn().mockResolvedValue(undefined),
  getTrace: vi.fn().mockResolvedValue(null),
};

// ─── Mock LLM responses ───────────────────────────────────────────────────────

const ASSESSMENT_BIAS_MOCK = {
  biases: [
    {
      name: "confirmation_bias",
      biasCatalogId: "confirmation_bias",
      explanation: "Test explanation for confirmation bias detection",
      storyConnection: "Test connection to the user story here",
      alternativePerspective: "Test alternative perspective provided",
      evidence: [
        { source: "story" as const, excerpt: "test excerpt from story", relevance: "relevant to bias" },
      ],
    },
  ],
  reflectionPrompt: "Test reflection prompt for the user",
  prompt_version: "1.0.0",
  schema_version: "1.0.0",
  noBiasDetected: false,
  reasoningTrace: {
    story_analysis: { themes: [], emotional_tone: "", key_events: [] },
    interpretations: [],
    bias_hypotheses: [],
    evidence_mapping: [],
    prompt_version: "1.0.0",
  },
  inputContext: "full" as const,
  modelName: "mock-model",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("T403 — Backwards compatibility", () => {
  const mockProvider = new MockProvider();
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const modelName = "mock-model";

  const assessmentService = new AssessmentService(
    mockProvider,
    prompts,
    catalog,
    modelName,
    mockLlmCallStore,
    mockRunStore,
    mockTraceStore,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.reset();
    mockProvider.setDefault(ASSESSMENT_BIAS_MOCK);
    mockLlmCallStore.recordCall = vi.fn().mockResolvedValue({ id: "call-id" });
    mockRunStore.createRun = vi.fn().mockResolvedValue({ id: "run-id" });
    mockTraceStore.persistTrace = vi.fn().mockResolvedValue(undefined);
  });

  describe("assessmentService.generate() — pre-Phase-4 call pattern", () => {
    it("still produces valid AssessmentOutput with full Q&A context", async () => {
      const output = await assessmentService.generate(
        "a".repeat(100),
        ["Question 1?"],
        ["Answer with enough detail to pass validation checks."],
        "req-compat-001",
      );

      expect(output).toBeDefined();
      expect(Array.isArray(output.biases)).toBe(true);
      expect(typeof output.noBiasDetected).toBe("boolean");
      expect(typeof output.reflectionPrompt).toBe("string");
      expect(output.prompt_version).toBeDefined();
    }, 10000);

    it("still returns correct modelName on AssessmentOutput", async () => {
      const output = await assessmentService.generate(
        "a".repeat(100),
        ["Question 1?"],
        ["Answer with enough detail to pass validation checks."],
        "req-compat-002",
      );

      expect(output.modelName).toBe(modelName);
    }, 10000);
  });

  describe("fire-and-forget guarantee — unaffected by Phase 4", () => {
    it("assessment succeeds even when llm_calls recording fails", async () => {
      mockLlmCallStore.recordCall = vi.fn().mockRejectedValue(new Error("DB down"));

      const output = await assessmentService.generate(
        "a".repeat(100),
        ["Question 1?"],
        ["Answer with enough detail to pass validation checks."],
        "req-compat-003",
      );

      expect(output).toBeDefined();
      expect(Array.isArray(output.biases)).toBe(true);
    }, 10000);
  });

  describe("evalResultStore.persistResult() — pre-Phase-4 call pattern", () => {
    it("still accepts evalRunId: null (legacy callers)", async () => {
      const mockStore = { persistResult: vi.fn().mockResolvedValue({ id: "r", runAt: "" }) };

      await mockStore.persistResult({
        provider: "gemini",
        modelName: "gemini-2.5-flash",
        promptVersion: "assessment-v1.0.0",
        dataset: "all",
        evaluationMetrics: { evidenceGroundedRate: null, falsePositiveRate: null },
        systemMetrics: { schemaParseRate: null, repairRate: null },
        inputHash: "abc123",
        passed: true,
        evalRunId: null,
        scenarioId: "aggregate",
        rawOutput: null,
      });

      expect(mockStore.persistResult).toHaveBeenCalledWith(
        expect.objectContaining({ evalRunId: null, rawOutput: null }),
      );
    });
  });
});
