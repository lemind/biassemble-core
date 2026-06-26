import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";
import { runDataset } from "../../src/evaluation/eval-runner.js";
import type { DatasetRunDeps } from "../../src/evaluation/eval-runner.js";
import type { LlmCallStore, RunStore, TraceStore } from "../../src/persistence/ports.js";
import type { GoldenStory, NoBiasStory } from "../../src/evaluation/run-eval.js";

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

// ─── Mock LLM response ────────────────────────────────────────────────────────

// No-bias response avoids evidence grounding validation issues in integration test
const ASSESSMENT_NO_BIAS_MOCK = {
  biases: [],
  reflectionPrompt: "No significant biases detected in your story.",
  noBiasDetected: true,
  reasoningTrace: {
    story_analysis: { themes: [], emotional_tone: "", key_events: [] },
    interpretations: [],
    bias_hypotheses: [],
    evidence_mapping: [],
    prompt_version: "1.0.0",
  },
  inputContext: "story-only" as const,
  modelName: "mock-model",
};

// ─── Data loading ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "..", "..", "evaluations", "golden", "reflection");
const NO_BIAS_DIR = join(__dirname, "..", "..", "evaluations", "no_bias", "reflection");

function loadFirstStory<T>(dir: string): T {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return JSON.parse(readFileSync(join(dir, files[0]), "utf-8")) as T;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("T402 — Eval run integration", () => {
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

  const mockEvalResultStore = { persistResult: vi.fn() };

  const deps: DatasetRunDeps = {
    assessmentService,
    evalResultStore: mockEvalResultStore,
    promptRegistry: prompts,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.reset();
    mockProvider.setDefault(ASSESSMENT_NO_BIAS_MOCK);
    mockLlmCallStore.recordCall = vi.fn().mockResolvedValue({ id: "call-id" });
    mockRunStore.createRun = vi.fn().mockResolvedValue({ id: "run-id" });
    mockTraceStore.persistTrace = vi.fn().mockResolvedValue(undefined);
    mockEvalResultStore.persistResult.mockResolvedValue({ id: "result-id", runAt: new Date().toISOString() });
  });

  it("calls persistResult once per story in the dataset", async () => {
    const golden = loadFirstStory<GoldenStory>(GOLDEN_DIR);
    const noBias = loadFirstStory<NoBiasStory>(NO_BIAS_DIR);

    await runDataset(
      { datasetName: "golden", stories: [golden, noBias], provider: "gemini", modelName },
      deps,
    );

    expect(mockEvalResultStore.persistResult).toHaveBeenCalledTimes(2);
  }, 15000);

  it("all rows share the same evalRunId and it is a valid UUID", async () => {
    const golden = loadFirstStory<GoldenStory>(GOLDEN_DIR);
    const noBias = loadFirstStory<NoBiasStory>(NO_BIAS_DIR);

    await runDataset(
      { datasetName: "golden", stories: [golden, noBias], provider: "gemini", modelName },
      deps,
    );

    const calls = mockEvalResultStore.persistResult.mock.calls;
    const firstId = calls[0][0].evalRunId;
    const secondId = calls[1][0].evalRunId;

    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(UUID_PATTERN);
  }, 15000);

  it("sets scenarioId from story.id for each story", async () => {
    const golden = loadFirstStory<GoldenStory>(GOLDEN_DIR);
    const noBias = loadFirstStory<NoBiasStory>(NO_BIAS_DIR);

    await runDataset(
      { datasetName: "golden", stories: [golden, noBias], provider: "gemini", modelName },
      deps,
    );

    const scenarioIds = mockEvalResultStore.persistResult.mock.calls.map(
      (call: any[]) => call[0].scenarioId,
    );
    expect(scenarioIds).toContain(golden.id);
    expect(scenarioIds).toContain(noBias.id);
  }, 15000);

  it("sets rawOutput as parseable JSON for each story", async () => {
    const golden = loadFirstStory<GoldenStory>(GOLDEN_DIR);

    await runDataset(
      { datasetName: "golden", stories: [golden], provider: "gemini", modelName },
      deps,
    );

    const { rawOutput } = mockEvalResultStore.persistResult.mock.calls[0][0];
    expect(rawOutput).not.toBeNull();
    expect(typeof rawOutput).toBe("string");
    expect(() => JSON.parse(rawOutput)).not.toThrow();
    expect(JSON.parse(rawOutput)).toHaveProperty("noBiasDetected");
  }, 15000);

  it("sets correct provider and modelName from config", async () => {
    const golden = loadFirstStory<GoldenStory>(GOLDEN_DIR);

    await runDataset(
      { datasetName: "no_bias", stories: [golden], provider: "openai", modelName: "gpt-4o" },
      { ...deps, assessmentService: new AssessmentService(mockProvider, prompts, catalog, "gpt-4o", mockLlmCallStore, mockRunStore, mockTraceStore) },
    );

    const { provider, modelName: storedModel, dataset } = mockEvalResultStore.persistResult.mock.calls[0][0];
    expect(provider).toBe("openai");
    expect(storedModel).toBe("gpt-4o");
    expect(dataset).toBe("no_bias");
  }, 15000);

  it("returns a successful DatasetRunResult", async () => {
    const golden = loadFirstStory<GoldenStory>(GOLDEN_DIR);

    const result = await runDataset(
      { datasetName: "golden", stories: [golden], provider: "gemini", modelName },
      deps,
    );

    expect(result.evalRunId).toMatch(UUID_PATTERN);
    expect(result.totalScenarios).toBe(1);
    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(0);
  }, 15000);
});
