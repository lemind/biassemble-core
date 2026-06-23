import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes, type QuestionServiceLike, type AssessmentServiceLike } from "../../src/routes/reflection.js";
import { authHook } from "../../src/lib/auth.js";

const mockQuestionService: QuestionServiceLike = { generate: async () => ({ questions: [] as string[], isComplete: false }) };
const mockAssessmentService: AssessmentServiceLike = {
  runStoryOnlyAssessment: async () => ({ biases: [], reflectionPrompt: "", noBiasDetected: false }),
  runFullAssessment: async () => ({ biases: [], reflectionPrompt: "", noBiasDetected: false }),
};

describe("Auth Middleware Integration", () => {
  let server: any;

  beforeAll(async () => {
    // Note: env.js might have already run and cached the original AI_CORE_API_KEY.
    // If the service is reading from env.js, we need to match what's in there 
    // OR ensure env.js is reloadable. For now, let's use the actual env file value.
    const validSecret = "dev-secret-change-me"; 
    server = Fastify();
    
    // Wire up routes with auth hook
    registerReflectionRoutes(server, {
      question: mockQuestionService,
      assessment: mockAssessmentService
    });
    
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("should return 401 if Authorization header is missing", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      payload: { story: "I am a story" }
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: "Missing or invalid authorization header"
    });
  });

  it("should return 401 if token is invalid", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer wrong-secret"
      },
      payload: { story: "I am a story" }
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: "Invalid API key"
    });
  });

  it("should return 200 if token is valid", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: {
        authorization: "Bearer dev-secret-change-me"
      },
      payload: { 
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(100) 
      }
    });

    // 200 means it passed Auth and Zod and hit the mock service
    expect(response.statusCode).toBe(200);
  });
});
