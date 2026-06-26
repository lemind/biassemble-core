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
 * T506 — Evidence pipeline integration test.
 *
 * Verifies that evidence validation runs end-to-end through the real
 * AssessmentService + MockProvider. The unit-level evidence validation
 * logic is covered in tests/unit/parsers/evidence-validator.test.ts.
 *
 * Here we test:
 * - Evidence excerpts that match verbatim in story pass validation
 * - Evidence excerpts that don't match are logged (not rejected at API level)
 * - Empty evidence arrays are handled gracefully
 * - Mixed valid/invalid evidence across multiple bias items
 */
describe("T506 — Evidence pipeline integration", () => {
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

  const STORY = "I went to the grocery store yesterday and bought some milk. The cashier was friendly and helped me find the right aisle.";
  const ANSWERS = ["I felt happy about the interaction because it was efficient.", "The store was crowded but well-organized."];

  it("should pass evidence that matches verbatim in story", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of seeking confirming evidence.",
          alternativePerspective: "Consider actively seeking disconfirming evidence.",
          evidence: [
            { source: "story", excerpt: "I went to the grocery store yesterday", relevance: "Shows the event" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(1);
    expect(body.biases[0].evidence).toBeDefined();
    expect(body.biases[0].evidence[0].excerpt).toBe("I went to the grocery store yesterday");
  });

  it("should pass evidence that matches verbatim in answers", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "optimism bias",
          explanation: "You tend to be overly optimistic about outcomes.",
          storyConnection: "Your story shows a positive outlook.",
          alternativePerspective: "Consider potential challenges more carefully.",
          evidence: [
            { source: "answer", excerpt: "I felt happy about the interaction", relevance: "Shows positive outlook" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on whether your optimism is fully justified.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(1);
    expect(body.biases[0].evidence[0].source).toBe("answer");
  });

  it("should handle hallucinated evidence gracefully (not reject at API level)", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of seeking confirming evidence.",
          alternativePerspective: "Consider actively seeking disconfirming evidence.",
          evidence: [
            { source: "story", excerpt: "I bought a car yesterday", relevance: "Hallucinated" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on your information-seeking habits.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    // Evidence validation is non-blocking — it logs warnings but doesn't reject
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(1);
    // The evidence is still returned as-is from the provider
    expect(body.biases[0].evidence[0].excerpt).toBe("I bought a car yesterday");
  });

  it("should handle empty evidence array gracefully", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "anchoring bias",
          explanation: "You tend to rely heavily on the first piece of information.",
          storyConnection: "Your story shows anchoring on initial assumptions.",
          alternativePerspective: "Consider revisiting your initial assumptions.",
          evidence: [],
        },
      ],
      reflectionPrompt: "Think about your first impressions.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(1);
    expect(body.biases[0].evidence).toEqual([]);
  });

  it("should handle mixed valid and invalid evidence across multiple bias items", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to favor information that confirms your existing beliefs.",
          storyConnection: "Your story shows a pattern of seeking confirming evidence.",
          alternativePerspective: "Consider actively seeking disconfirming evidence.",
          evidence: [
            { source: "story", excerpt: "I went to the grocery store yesterday", relevance: "Valid" },
            { source: "story", excerpt: "This is completely made up", relevance: "Invalid" },
          ],
        },
        {
          name: "optimism bias",
          explanation: "You tend to be overly optimistic about outcomes.",
          storyConnection: "Your story shows a positive outlook.",
          alternativePerspective: "Consider potential challenges more carefully.",
          evidence: [
            { source: "answer", excerpt: "I felt happy about the interaction", relevance: "Valid" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on your biases.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(2);
    // Both bias items are returned regardless of evidence validity
    expect(body.biases[0].evidence).toHaveLength(2);
    expect(body.biases[1].evidence).toHaveLength(1);
  });

  it("should handle missing evidence field gracefully", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "sunk cost bias",
          explanation: "You tend to continue investing in something because of past investment.",
          storyConnection: "Your story shows continued investment despite diminishing returns.",
          alternativePerspective: "Consider whether past investment justifies future commitment.",
        },
      ],
      reflectionPrompt: "Reflect on past investments.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(1);
    // When evidence is missing from provider output, it may be undefined
    // The service should handle this gracefully
  });

  it("should include evidence in response when provider returns it", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "availability bias",
          explanation: "You tend to overestimate the likelihood of events that come easily to mind.",
          storyConnection: "Your story references recent vivid events.",
          alternativePerspective: "Consider statistical base rates rather than vivid examples.",
          evidence: [
            { source: "story", excerpt: "The cashier was friendly", relevance: "Shows recent positive experience" },
          ],
        },
      ],
      reflectionPrompt: "Reflect on whether recent events are skewing your perception.",
      noBiasDetected: false,
      prompt_version: "1.0.0",
      schema_version: "1.0.0",
      modelName: "mock-model",
      inputContext: "full",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: STORY,
        questions: ["Q1?", "Q2?"],
        answers: ANSWERS,
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases[0].evidence).toBeDefined();
    expect(body.biases[0].evidence.length).toBeGreaterThan(0);
    expect(body.biases[0].evidence[0].source).toBe("story");
    expect(body.biases[0].evidence[0].relevance).toBeDefined();
  });
});
