import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes } from "../../src/routes/reflection.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { QuestionService } from "../../src/orchestrators/reflection/question.service.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";

/**
 * Integration test for the full repair pipeline (real services + mocked provider).
 * The unit-level malformed-output recovery is covered in tests/unit/parsers/repair.test.ts.
 * Here we verify that real services + repair pipeline work together end-to-end.
 */
describe("Repair pipeline — real QuestionService/AssessmentService with MockProvider", () => {
  let server: any;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const prompts = new PromptRegistry();
    const catalog = new BiasCatalogService();

    const questionService = new QuestionService(mockProvider, prompts);
    const assessmentService = new AssessmentService(mockProvider, prompts, catalog);

    server = Fastify();
    registerReflectionRoutes(server, {
      question: questionService as any,
      assessment: assessmentService as any,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("real QuestionService returns valid questions from clean provider output", async () => {
    mockProvider.setDefault({
      questions: ["What triggered this reaction?", "How did your team respond?"],
      isComplete: true,
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.questions).toHaveLength(2);
    expect(body.isComplete).toBe(true);
  });

  it("real AssessmentService returns valid assessment from clean provider output", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "confirmation bias",
          explanation: "You tend to seek information confirming your beliefs, ignoring contradictory evidence.",
          storyConnection: "Your story mentions focusing on articles that support your view.",
          alternativePerspective: "Consider actively seeking out perspectives that challenge your position.",
        },
      ],
      reflectionPrompt: "Reflect on whether you might be giving more weight to supporting information.",
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
        questions: ["Q1?", "Q2?"],
        answers: ["A1 with enough detail for validation.", "A2 with enough detail as well."],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.biases).toHaveLength(1);
    expect(body.reflectionPrompt).toBeDefined();
  });

  // failAll + retry timeout tests are covered in tests/integration/question.test.ts
  // using inline mocks to avoid exponential backoff delays
});
