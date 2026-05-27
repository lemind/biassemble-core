import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes } from "../../src/routes/reflection.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";

describe("POST /v1/reflection/question — integration", () => {
  let server: any;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const prompts = new PromptRegistry();
    const questionService = {
      generate: async (story: string, requestId: string) => {
        const system = prompts.render("question-batch", {});
        const user = `STORY: ${story}`;
        return await mockProvider.completeJson<any>({ system, user });
      },
    };
    const assessmentService = {
      generate: async () => ({ biases: [], reflectionPrompt: "" }),
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

  it("should return 200 with valid questions", async () => {
    mockProvider.reset();
    mockProvider.setDefault({
      questions: ["What makes you feel that your contributions don't matter?", "How has your relationship with your manager changed since the incident?"],
      isComplete: true,
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.questions.length).toBeGreaterThanOrEqual(2);
    expect(body.questions.length).toBeLessThanOrEqual(5);
    expect(typeof body.isComplete).toBe("boolean");
  });

  it("should return 400 for invalid payload", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        // missing sessionId, story too short
        story: "too short",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toHaveProperty("error");
  });

  it("should return 401 without authorization", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return 502 on provider failure", async () => {
    mockProvider.failAll("Provider unavailable");

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
      },
    });

    // The error propagates through withRetry which catches and rethrows
    expect(response.statusCode).toBe(502);
  });

  it("should return x-request-id header", async () => {
    mockProvider.setDefault({
      questions: ["Q1?", "Q2?"],
      isComplete: true,
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer dev-secret-change-me",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
      },
    });

    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("should return 401 for wrong authorization token", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer wrong-secret",
      },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100),
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
