import { describe, it, expect } from "vitest";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { QuestionService } from "../../src/orchestrators/reflection/question.service.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";
import { computeEvaluationMetrics } from "../../src/evaluation/compute-evaluation-metrics.js";
import { computeInputHash } from "../../src/lib/hash.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface GoldenStory {
  id: string;
  title: string;
  story: string;
  tags: string[];
  expectedMinBiases: number;
  expectedQuestionsCountRange: [number, number];
}

interface NoBiasStory {
  id: string;
  title: string;
  story: string;
  tags: string[];
  isNoBias: true;
  confidenceThreshold: number;
  notes: string;
}

function loadFirstStory<T>(dir: string): T {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const raw = readFileSync(join(dir, files[0]), "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * T510 — Inngest eval integration test (fast-fail subset).
 *
 * Tests the eval pipeline end-to-end using MockProvider on 2 stories:
 * - 1 golden story (first file in evaluations/golden/reflection/)
 * - 1 no-bias story (first file in evaluations/no_bias/reflection/)
 *
 * Does NOT use runEval() — calls services directly to avoid the
 * 14-story × 4-retry storm that caused 5+ minute timeouts.
 */
describe("T510 — Inngest eval integration", () => {
  const mockProvider = new MockProvider();
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const modelName = "mock-model";

  const questionService = new QuestionService(mockProvider, prompts, modelName);
  const assessmentService = new AssessmentService(mockProvider, prompts, catalog, modelName);

  const GOLDEN_DIR = join(__dirname, "..", "..", "evaluations", "golden", "reflection");
  const NO_BIAS_DIR = join(__dirname, "..", "..", "evaluations", "no_bias", "reflection");

  it("should run a golden story through the full pipeline", async () => {
    const story = loadFirstStory<GoldenStory>(GOLDEN_DIR);
    const requestId = `eval-${story.id}`;

    // Step 1: Generate questions
    const questionsOutput = await questionService.generate(story.story, requestId);
    expect(questionsOutput.questions.length).toBeGreaterThan(0);

    // Step 2: Generate answers (mock)
    const answers = questionsOutput.questions.map((_, i) => `Answer ${i + 1}`);

    // Step 3: Run assessment
    const assessmentOutput = await assessmentService.generate(
      story.story,
      questionsOutput.questions,
      answers,
      requestId,
    );

    expect(assessmentOutput.biases.length).toBeGreaterThanOrEqual(story.expectedMinBiases);
    expect(assessmentOutput.noBiasDetected).toBe(false);
    expect(assessmentOutput.prompt_version).toBeDefined();
    expect(assessmentOutput.schema_version).toBeDefined();
    expect(assessmentOutput.modelName).toBe(modelName);
    expect(assessmentOutput.inputContext).toBe("full");

    // Step 4: Compute evaluation metrics
    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [] })) },
      { story: story.story, answers },
      { isNoBiasStory: false },
    );
    expect(metrics).toBeDefined();
  }, 30000);

  it("should run a no-bias story through the assessment pipeline", async () => {
    const story = loadFirstStory<NoBiasStory>(NO_BIAS_DIR);
    const requestId = `eval-${story.id}`;

    const assessmentOutput = await assessmentService.generate(
      story.story,
      [],
      [],
      requestId,
    );

    expect(assessmentOutput.noBiasDetected).toBe(true);
    expect(assessmentOutput.biases).toHaveLength(0);
    expect(assessmentOutput.prompt_version).toBeDefined();

    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [] })) },
      { story: story.story, answers: [] },
      { isNoBiasStory: true, confidenceThreshold: story.confidenceThreshold },
    );
    expect(metrics.isFalsePositive).toBe(false);
  }, 30000);

  it("should run a no-bias story through the assessment pipeline", async () => {
    const story = loadFirstStory<NoBiasStory>(NO_BIAS_DIR);
    const requestId = `eval-${story.id}`;

    const assessmentOutput = await assessmentService.generate(
      story.story,
      [],
      [],
      requestId,
    );

    expect(assessmentOutput.noBiasDetected).toBe(true);
    expect(assessmentOutput.biases).toHaveLength(0);
    expect(assessmentOutput.prompt_version).toBeDefined();

    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [] })) },
      { story: story.story, answers: [] },
      { isNoBiasStory: true, confidenceThreshold: story.confidenceThreshold },
    );
    expect(metrics.isFalsePositive).toBe(false);
  }, 10000);

  it("should produce consistent input hashes for same inputs", async () => {
    const h1 = computeInputHash("v1", "model", "story", ["a1"]);
    const h2 = computeInputHash("v1", "model", "story", ["a1"]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  }, 5000);
});