import { describe, it, expect, beforeEach } from "vitest";
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

/** Mock response for question generation (matches question-batch/system.md substring). */
const QUESTION_MOCK = {
  questions: ["Question 1?", "Question 2?"],
  isComplete: true,
};

/** Mock response for assessment with biases (matches assessment/system.md substring). */
const ASSESSMENT_BIAS_MOCK = {
  biases: [
    {
      name: "confirmation_bias",
      biasCatalogId: "confirmation_bias",
      explanation: "Test explanation for confirmation bias detection",
      storyConnection: "Test connection to the user story",
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

/** Mock response for no-bias assessment. */
const ASSESSMENT_NO_BIAS_MOCK = {
  biases: [],
  reflectionPrompt: "No significant biases detected in your story.",
  prompt_version: "1.0.0",
  schema_version: "1.0.0",
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

/**
 * T510 — Inngest eval integration test (fast-fail subset).
 *
 * Tests the eval pipeline end-to-end using MockProvider on 2 stories:
 * - 1 golden story (first file in evaluations/golden/reflection/)
 * - 1 no-bias story (first file in evaluations/no_bias/reflection/)
 *
 * Does NOT use runEval() — calls services directly to avoid the
 * 14-story × 4-retry storm that caused 5+ minute timeouts.
 *
 * Mock matching: uses substrings that appear in the rendered system prompts:
 * - "asking 2-5" → question-batch/system.md ("asking 2-5 probing, contextual...")
 * - "answered follow-up questions" → assessment/system.md ("The user has provided...and answered follow-up questions")
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

  beforeEach(() => {
    // Reset mock between tests so each test gets fresh provider state
    mockProvider.reset();
    // Configure mock responses using substrings from rendered system prompts
    mockProvider.setResponse("asking 2-5", QUESTION_MOCK);
    mockProvider.setResponse("answered follow-up questions", ASSESSMENT_BIAS_MOCK);
  });

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

    // Mock returns 1 bias; real AI would return >= expectedMinBiases
    expect(assessmentOutput.biases.length).toBeGreaterThanOrEqual(1);
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

    // Override mock to return no-bias response for this test
    mockProvider.reset();
    mockProvider.setResponse("asking 2-5", QUESTION_MOCK);
    mockProvider.setResponse("answered follow-up questions", ASSESSMENT_NO_BIAS_MOCK);

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

  it("should produce consistent input hashes for same inputs", async () => {
    const h1 = computeInputHash("v1", "model", "story", ["a1"]);
    const h2 = computeInputHash("v1", "model", "story", ["a1"]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  }, 5000);
});