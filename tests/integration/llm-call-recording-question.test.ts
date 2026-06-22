import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes, type AssessmentServiceLike } from "../../src/routes/reflection.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { QuestionService } from "../../src/orchestrators/reflection/question.service.js";
import * as queries from "../../src/db/queries.js";
import { repairWithFallback } from "../../src/parsers/repair.js";

vi.mock("../../src/orchestrators/retry.js", () => ({
  withRetry: vi.fn().mockImplementation(async (fn: () => Promise<any>) => fn()),
}));

let repairBehavior: ((...args: any[]) => Promise<any>) | null = null;
vi.mock("../../src/parsers/repair.js", async () => {
  const actual = await vi.importActual("../../src/parsers/repair.js");
  const realRepair = (actual as any).repairWithFallback;
  return {
    ...actual,
    repairWithFallback: vi.fn().mockImplementation((...args: any[]) => {
      if (repairBehavior) return repairBehavior(...args);
      return realRepair(...args);
    }),
  };
});

vi.mock("../../src/db/queries.js", async () => {
  const actual = await vi.importActual("../../src/db/queries.js");
  return {
    ...actual,
    recordLlmCall: vi.fn().mockResolvedValue({ id: "test-llm-call-id" }),
    updateLlmCallParsedOutput: vi.fn().mockResolvedValue(undefined),
    updateLlmCallFailure: vi.fn().mockResolvedValue(undefined),
  };
});

describe("T203 — LLM call recording in question flow", () => {
  let server: any;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const prompts = new PromptRegistry();

    const questionService = new QuestionService(mockProvider, prompts, "mock-model");
    const assessmentService: AssessmentServiceLike = {
      runStoryOnlyAssessment: async () => ({ biases: [], reflectionPrompt: "", noBiasDetected: false }),
      runFullAssessment: async () => ({ biases: [], reflectionPrompt: "", noBiasDetected: false }),
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create llm_calls record with raw response on successful question generation", async () => {
    mockProvider.setDefault({
      questions: [
        "What makes you feel that your contributions don't matter?",
        "How has your relationship with your manager changed since the incident?",
      ],
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

    // Verify recordLlmCall was called for primary call
    expect(queries.recordLlmCall).toHaveBeenCalled();
    const recordedData = vi.mocked(queries.recordLlmCall).mock.calls[0][0];
    
    expect(recordedData.rawResponse).toBeDefined();
    expect(recordedData.rawResponse).not.toBeNull();
    expect(typeof recordedData.rawResponse).toBe("string");
    
    expect(recordedData.promptVersion).toBe("1.1.0");
    expect(recordedData.stage).toBe("question");
    expect(recordedData.provider).toBe("mock");
    expect(recordedData.model).toBe("mock-model");
    expect(recordedData.callType).toBe("primary");
    expect(recordedData.status).toBe("success");
    expect(recordedData.failureType).toBeNull();
  });

  it("should update parsed_output after successful parse", async () => {
    mockProvider.setDefault({
      questions: ["Q1?", "Q2?"],
      isComplete: true,
    });

    await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000002",
        story: "b".repeat(100),
      },
    });

    // Verify updateLlmCallParsedOutput was called
    expect(queries.updateLlmCallParsedOutput).toHaveBeenCalled();
    const [callId, parsedOutput] = vi.mocked(queries.updateLlmCallParsedOutput).mock.calls[0];
    expect(callId).toBe("test-llm-call-id");
    expect(parsedOutput).toBeDefined();
    expect(parsedOutput).toHaveProperty("questions");
    expect(parsedOutput).toHaveProperty("isComplete");
  });

  it("should record fallback call when primary repair fails", async () => {
    let callCount = 0;
    const originalCompleteJson = mockProvider.completeJson.bind(mockProvider);
    mockProvider.completeJson = async (request) => {
      callCount++;
      if (callCount === 1) {
        return { result: "not valid json at all {{{" as any };
      }
      return originalCompleteJson(request);
    };

    mockProvider.setDefault({
      questions: ["Fallback Q1?", "Fallback Q2?"],
      isComplete: true,
    });

    await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000003",
        story: "c".repeat(100),
      },
    });

    // Verify both primary and fallback calls were recorded
    expect(queries.recordLlmCall).toHaveBeenCalledTimes(2);
    
    const primaryCall = vi.mocked(queries.recordLlmCall).mock.calls[0][0];
    expect(primaryCall.callType).toBe("primary");
    expect(primaryCall.stage).toBe("question");
    
    const fallbackCall = vi.mocked(queries.recordLlmCall).mock.calls[1][0];
    expect(fallbackCall.callType).toBe("fallback");
    expect(fallbackCall.stage).toBe("question");
  });

  it("should call updateLlmCallFailure when both primary and fallback fail", async () => {
    repairBehavior = () => Promise.reject(new Error("Failed to produce valid output after repair and fallback"));

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000004",
        story: "d".repeat(100),
      },
    });

    expect(response.statusCode).toBe(502);
    expect(queries.updateLlmCallFailure).toHaveBeenCalled();

    repairBehavior = null;
  });

  it("should succeed even when updateLlmCallParsedOutput fails", async () => {
    vi.mocked(queries.updateLlmCallParsedOutput).mockRejectedValueOnce(new Error("DB down"));
    repairBehavior = () => Promise.resolve({
      questions: ["Q1?", "Q2?"],
      isComplete: true,
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/question",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000005",
        story: "e".repeat(100),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.questions).toBeDefined();

    repairBehavior = null;
  });
});
