import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes, type QuestionServiceLike } from "../../src/routes/reflection.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";

describe("POST /v1/reflection/assessment — integration with MockProvider", () => {
  let server: any;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const prompts = new PromptRegistry();
    const catalog = new BiasCatalogService();

    const assessmentService = new AssessmentService(mockProvider, prompts, catalog, "mock-model");
    const questionService: QuestionServiceLike = {
      generate: async () => ({ questions: [] as string[], isComplete: true }),
    };

    server = Fastify();
    // Add request-id hook for x-request-id header tests
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

  it("should return 200 with valid assessment", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs about your situation.",
          storyConnection: "In your story, you mention reading articles that confirm your current leaning.",
          alternativePerspective: "Consider seeking out perspectives that challenge your current view.",
        },
      ],
      reflectionPrompt: "Reflect on how your beliefs might be influencing your interpretation of events.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["What makes you feel that way?", "How does this affect you?"],
        answers: ["I feel frustrated because of the situation.", "It affects my daily life significantly."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.reflectionPrompt).toBe("string");
    expect(typeof body.prompt_version).toBe("string");
    expect(body.schema_version).toBe("1.0.0");
  });

  it("should return 400 for mismatched questions/answers length", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?", "Q2?"],
        answers: ["Only one answer"],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("match");
  });

  it("should return 400 for invalid payload", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        story: "a".repeat(100),
        questions: [],
        answers: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 401 without authorization", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1"],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return x-request-id header", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "test bias",
          explanation: "This is a sufficiently long explanation for testing x-request-id.",
          storyConnection: "The story connection needs enough chars to pass validation.",
          alternativePerspective: "Alternative perspective with enough chars for the validation.",
        },
      ],
      reflectionPrompt: "A reflection prompt with enough characters to pass minimum length validation rules.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.headers["x-request-id"]).toBeDefined();
  });

  // ── T505: Reasoning trace, evidence binding, noBiasDetected, modelName ──

  it("T505 — should include reasoningTrace when includeReasoningTrace=true", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of seeking confirming evidence.",
          alternativePerspective: "Consider actively seeking disconfirming evidence.",
          evidence: [
            { source: "story", excerpt: "a".repeat(50), relevance: "Shows pattern" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
      reasoningTrace: {
        story_analysis: {
          themes: ["information seeking", "confirmation"],
          emotional_tone: "reflective",
          key_events: ["reading articles"],
        },
        interpretations: [
          {
            interpretation: "User may be selectively seeking information",
            plausibility: 0.85,
            supporting_evidence: ["reading articles that confirm leaning"],
            rejected: false,
          },
        ],
        bias_hypotheses: [
          {
            bias_name: "confirmation bias",
            confidence: 0.85,
            supporting_excerpts: ["reading articles that confirm"],
            uncertainty_reasons: ["limited context"],
          },
        ],
        evidence_mapping: [
          {
            bias_id: "confirmation bias",
            evidence: [
              { source: "story", excerpt: "a".repeat(50), relevance: "Direct evidence" },
            ],
          },
        ],
        prompt_version: "1.0.0",
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment?includeReasoningTrace=true",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("reasoningTrace");
    expect(body.reasoningTrace).toHaveProperty("story_analysis");
    expect(body.reasoningTrace).toHaveProperty("interpretations");
    expect(body.reasoningTrace).toHaveProperty("bias_hypotheses");
    expect(body.reasoningTrace).toHaveProperty("evidence_mapping");
    expect(body.reasoningTrace).toHaveProperty("prompt_version");
    expect(body.reasoningTrace.prompt_version).toBe("1.0.0");
  });

  it("T505 — should exclude reasoningTrace by default (includeReasoningTrace not set)", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "anchoring bias",
          explanation: "You tend to rely heavily on the first piece of information you encounter.",
          storyConnection: "Your story shows anchoring on initial assumptions.",
          alternativePerspective: "Consider revisiting your initial assumptions with fresh eyes.",
        },
      ],
      reflectionPrompt: "Think about whether your first impression is still valid.",
      reasoningTrace: {
        story_analysis: {
          themes: ["first impressions"],
          emotional_tone: "analytical",
          key_events: ["initial encounter"],
        },
        interpretations: [],
        bias_hypotheses: [],
        evidence_mapping: [],
        prompt_version: "1.0.0",
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).not.toHaveProperty("reasoningTrace");
  });

  it("T505 — should return modelName in response", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "availability bias",
          explanation: "You tend to overestimate the likelihood of events that come easily to mind.",
          storyConnection: "Your story references recent vivid events.",
          alternativePerspective: "Consider statistical base rates rather than vivid examples.",
        },
      ],
      reflectionPrompt: "Reflect on whether recent events are skewing your perception.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("modelName");
    expect(typeof body.modelName).toBe("string");
    expect(body.modelName.length).toBeGreaterThan(0);
  });

  it("T505 — should return inputContext in response", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "sunk cost bias",
          explanation: "You tend to continue investing in something because of past investment.",
          storyConnection: "Your story shows continued investment despite diminishing returns.",
          alternativePerspective: "Consider whether past investment justifies future commitment.",
        },
      ],
      reflectionPrompt: "Reflect on whether past investments are driving current decisions.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("inputContext");
    expect(body.inputContext).toBe("full");
  });

  it("T505 — should set noBiasDetected=true when biases array is empty", async () => {
    mockProvider.setDefault({
      biases: [],
      reflectionPrompt: "No biases detected in your story.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.noBiasDetected).toBe(true);
    expect(body.biases).toHaveLength(0);
  });

  it("T505 — should set noBiasDetected=false when biases are present", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "overconfidence bias",
          explanation: "You tend to be more confident in your judgments than is warranted.",
          storyConnection: "Your story shows high certainty about uncertain outcomes.",
          alternativePerspective: "Consider calibrating your confidence with actual probabilities.",
        },
      ],
      reflectionPrompt: "Reflect on the gap between your confidence and actual outcomes.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.noBiasDetected).toBe(false);
    expect(body.biases.length).toBeGreaterThan(0);
  });

  it("T505 — should return biasCatalogId when bias name matches catalog", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of seeking confirming evidence.",
          alternativePerspective: "Consider actively seeking disconfirming evidence.",
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases[0]).toHaveProperty("biasCatalogId");
    expect(typeof body.biases[0].biasCatalogId).toBe("string");
  });

  it("T505 — story_only mode should return inputContext=story-only", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of seeking confirming evidence.",
          alternativePerspective: "Consider actively seeking disconfirming evidence.",
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "story_only",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.inputContext).toBe("story-only");
  });

  // 502 on provider failure test covered in tests/integration/question.test.ts
  // Real services with failAll cause exponential backoff delays exceeding 5s timeout

  it("T505 — should return evidence entries with source/excerpt/relevance on bias items", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs about your situation.",
          storyConnection: "In your story, you mention reading articles that confirm your current leaning.",
          alternativePerspective: "Consider seeking out perspectives that challenge your current view.",
          evidence: [
            { source: "story", excerpt: "I kept reading articles that confirmed what I already believed.", relevance: "Confirms selective information seeking" },
            { source: "answer", excerpt: "I felt validated by the response from the first source.", relevance: "Shows the bias in action" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on how your beliefs might be influencing your interpretation of events.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases[0].evidence).toBeDefined();
    expect(body.biases[0].evidence).toHaveLength(2);
    // Each evidence entry has source, excerpt, relevance
    for (const entry of body.biases[0].evidence) {
      expect(entry).toHaveProperty("source");
      expect(["story", "answer"]).toContain(entry.source);
      expect(typeof entry.excerpt).toBe("string");
      expect(entry.excerpt.length).toBeGreaterThan(0);
      expect(typeof entry.relevance).toBe("string");
      expect(entry.relevance.length).toBeGreaterThan(0);
    }
  });

  it("T505 — stage and scope are persistence-only, not in API response (per T402)", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs about your situation.",
          storyConnection: "In your story, you mention reading articles that confirm your current leaning.",
          alternativePerspective: "Consider seeking out perspectives that challenge your current view.",
        },
      ],
      reflectionPrompt: "Reflect on how your beliefs might be influencing your interpretation of events.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // T402: stage and scope are NOT exposed in the public API response —
    // they live on the `runs` DB row. Verify they are absent.
    expect(body).not.toHaveProperty("stage");
    expect(body).not.toHaveProperty("scope");
    // The response also exposes a phase-2 context label that DOES include scope info.
    expect(body.inputContext).toBe("full");
  });
});
