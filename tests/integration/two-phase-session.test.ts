import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes, type QuestionServiceLike } from "../../src/routes/reflection.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";
import type { LlmCallStore, RunStore, TraceStore } from "../../src/persistence/ports.js";

const mockLlmCallStore: LlmCallStore = {
  recordCall: vi.fn().mockResolvedValue({ id: "test-llm-call-id" }),
  getCallsBySession: vi.fn().mockResolvedValue([]),
  getCallsByStage: vi.fn().mockResolvedValue([]),
  getCallsByProvider: vi.fn().mockResolvedValue([]),
  getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
  updateParsedOutput: vi.fn().mockResolvedValue(undefined),
  updateFailure: vi.fn().mockResolvedValue(undefined),
  getCallsForMetrics: vi.fn().mockResolvedValue([]),
};

const mockRunStore: RunStore = {
  createRun: vi.fn().mockResolvedValue({ id: "test-run-id" }),
  getRunsBySession: vi.fn().mockResolvedValue([]),
};

const mockTraceStore: TraceStore = {
  persistTrace: vi.fn().mockResolvedValue(undefined),
  getTrace: vi.fn().mockResolvedValue(null),
};

/**
 * T508 — Two-phase session integration test.
 *
 * Verifies that the two-phase assessment flow works end-to-end:
 * 1. story_only mode — assessment based on story alone (no Q&A)
 * 2. full mode — assessment with story + questions + answers
 *
 * Each phase returns the correct inputContext and modelName.
 */
describe("T508 — Two-phase session integration", () => {
  let server: any;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const prompts = new PromptRegistry();
    const catalog = new BiasCatalogService();

    const assessmentService = new AssessmentService(mockProvider, prompts, catalog, "mock-model", mockLlmCallStore, mockRunStore, mockTraceStore);
    const questionService: QuestionServiceLike = {
      generate: async () => ({ questions: [] as string[], isComplete: true }),
    };

    server = Fastify();
    server.addHook("onRequest", async (req: any, reply: any) => {
      req.id = "test-request-id";
      reply.header("x-request-id", "test-request-id");
    });
    registerReflectionRoutes(server, {
      question: questionService,
      assessment: assessmentService,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  const SESSION_ID = "00000000-0000-4000-8000-000000000001";
  const STORY = "I had a disagreement with my colleague at work about the project direction. I feel strongly that my approach is correct based on past experience.";
  const QUESTIONS = ["What triggered this reaction?", "How did your team respond?"];
  const ANSWERS = ["I felt frustrated because my idea was dismissed.", "They suggested we gather more data first."];

  it("Phase 1 — story_only mode should return assessment without Q&A", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of relying on past experience.",
          alternativePerspective: "Consider whether past experience is always applicable.",
        },
      ],
      reflectionPrompt: "Reflect on whether you might be dismissing valid alternatives.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        mode: "story_only",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.inputContext).toBe("story-only");
    expect(body.modelName).toBe("mock-model");
    expect(body.biases).toBeDefined();
    expect(body.reflectionPrompt).toBeDefined();
    expect(body.prompt_version).toBeDefined();
    expect(body.schema_version).toBe("1.0.0");
    // story_only mode doesn't require questions/answers
    expect(body.noBiasDetected).toBe(false);
  });

  it("Phase 1 — story_only mode should work without questions/answers in payload", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "anchoring bias",
          explanation: "You tend to rely heavily on the first piece of information.",
          storyConnection: "Your story shows anchoring on initial assumptions.",
          alternativePerspective: "Consider revisiting your initial assumptions.",
        },
      ],
      reflectionPrompt: "Think about your first impressions.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        mode: "story_only",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.inputContext).toBe("story-only");
    expect(body.biases).toHaveLength(1);
  });

  it("Phase 1 — story_only mode should return noBiasDetected=true when no biases found", async () => {
    mockProvider.setDefault({
      biases: [],
      reflectionPrompt: "No biases detected in your story.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        mode: "story_only",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.inputContext).toBe("story-only");
    expect(body.noBiasDetected).toBe(true);
    expect(body.biases).toHaveLength(0);
  });

  it("Phase 2 — full mode should return assessment with story + Q&A", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of relying on past experience.",
          alternativePerspective: "Consider whether past experience is always applicable.",
        },
        {
          name: "anchoring bias",
          explanation: "You tend to rely heavily on the first piece of information.",
          storyConnection: "Your answers show anchoring on initial assumptions.",
          alternativePerspective: "Consider revisiting your initial assumptions.",
        },
      ],
      reflectionPrompt: "Reflect on how your beliefs and first impressions might be influencing your judgment.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        questions: QUESTIONS,
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.inputContext).toBe("full");
    expect(body.modelName).toBe("mock-model");
    expect(body.biases).toHaveLength(2);
    expect(body.reflectionPrompt).toBeDefined();
    expect(body.prompt_version).toBeDefined();
    expect(body.schema_version).toBe("1.0.0");
  });

  it("Phase 2 — full mode should return 400 when questions/answers length mismatch", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ["Only one answer"],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("match");
  });

  it("Phase 2 — full mode should return 400 when questions/answers are empty", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        questions: [],
        answers: [],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("Phase 2 — full mode should include reasoningTrace when requested", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of relying on past experience.",
          alternativePerspective: "Consider whether past experience is always applicable.",
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
      reasoningTrace: {
        story_analysis: {
          themes: ["confirmation", "past experience"],
          emotional_tone: "frustrated",
          key_events: ["disagreement", "dismissal"],
        },
        interpretations: [
          {
            interpretation: "User may be over-relying on past experience",
            plausibility: 0.8,
            supporting_evidence: ["strongly feel my approach is correct"],
            rejected: false,
          },
        ],
        bias_hypotheses: [
          {
            bias_name: "confirmation bias",
            confidence: 0.8,
            supporting_excerpts: ["my approach is correct based on past experience"],
            uncertainty_reasons: ["limited context"],
          },
        ],
        evidence_mapping: [
          {
            bias_id: "confirmation bias",
            evidence: [
              { source: "story", excerpt: "my approach is correct based on past experience", relevance: "Shows over-reliance on past experience" },
            ],
          },
        ],
        prompt_version: "1.0.0",
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment?includeReasoningTrace=true",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        questions: QUESTIONS,
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("reasoningTrace");
    expect(body.reasoningTrace.story_analysis.themes).toContain("confirmation");
    expect(body.reasoningTrace.prompt_version).toBe("1.0.0");
  });

  it("Phase 2 — full mode should exclude reasoningTrace by default", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of relying on past experience.",
          alternativePerspective: "Consider whether past experience is always applicable.",
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
      reasoningTrace: {
        story_analysis: { themes: [], emotional_tone: "", key_events: [] },
        interpretations: [],
        bias_hypotheses: [],
        evidence_mapping: [],
        prompt_version: "1.0.0",
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        questions: QUESTIONS,
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).not.toHaveProperty("reasoningTrace");
  });

  it("should return 401 without authorization for both modes", async () => {
    const storyOnlyResponse = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        mode: "story_only",
      },
    });
    expect(storyOnlyResponse.statusCode).toBe(401);

    const fullResponse = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      payload: {
        sessionId: SESSION_ID,
        story: STORY,
        questions: QUESTIONS,
        answers: ANSWERS,
        mode: "full",
      },
    });
    expect(fullResponse.statusCode).toBe(401);
  });
});
