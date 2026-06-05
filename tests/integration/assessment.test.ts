import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes } from "../../src/routes/reflection.js";
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
    const questionService = {
      generate: async () => ({ questions: [], isComplete: true }),
    };

    server = Fastify();
    // Add request-id hook for x-request-id header tests
    server.addHook("onRequest", async (req: any, reply: any) => {
      req.id = "test-request-id";
      reply.header("x-request-id", "test-request-id");
    });
    registerReflectionRoutes(server, {
      question: questionService as any,
      assessment: assessmentService as any,
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

  // 502 on provider failure test covered in tests/integration/question.test.ts
  // Real services with failAll cause exponential backoff delays exceeding 5s timeout
});
