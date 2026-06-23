import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerReflectionRoutes, type QuestionServiceLike } from "../../src/routes/reflection.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { AssessmentService } from "../../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../../src/catalog/bias-catalog.js";
import * as queries from "../../src/db/queries.js";
import { repairWithFallback } from "../../src/parsers/repair.js";
import type { LlmCallStore } from "../../src/persistence/ports.js";

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
    createRun: vi.fn().mockResolvedValue({ id: "test-run-id" }),
    persistTrace: vi.fn().mockResolvedValue(undefined),
  };
});

// Create a mock LlmCallStore that delegates to the mocked queries
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

describe("T202 — LLM call recording in assessment flow", () => {
  let server: any;
  let mockProvider: MockProvider;

  beforeAll(async () => {
    mockProvider = new MockProvider();
    const prompts = new PromptRegistry();
    const catalog = new BiasCatalogService();

    const assessmentService = new AssessmentService(mockProvider, prompts, catalog, "mock-model", mockLlmCallStore);
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create llm_calls record with raw response on successful assessment", async () => {
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

    // Verify recordLlmCall was called for primary call
    expect(mockLlmCallStore.recordCall).toHaveBeenCalled();
    const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
    
    expect(recordedData.rawResponse).toBeDefined();
    expect(recordedData.rawResponse).not.toBeNull();
    expect(typeof recordedData.rawResponse).toBe("string");
    
    expect(recordedData.promptVersion).toBe("1.1.0");
    expect(recordedData.stage).toBe("assessment");
    expect(recordedData.provider).toBe("mock");
    expect(recordedData.model).toBe("mock-model");
    expect(recordedData.callType).toBe("primary");
    expect(recordedData.status).toBe("success");
    expect(recordedData.failureType).toBeNull();
  });

  it("should update parsed_output after successful parse", async () => {
    mockProvider.setDefault({
      biases: [
        {
          name: "anchoring bias",
          explanation: "You tend to rely heavily on the first piece of information.",
          storyConnection: "Your story shows anchoring on initial assumptions.",
          alternativePerspective: "Consider revisiting your initial assumptions.",
        },
      ],
      reflectionPrompt: "Think about whether your first impression is still valid.",
    });

    await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000002",
        story: "b".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    // Verify updateLlmCallParsedOutput was called
    expect(mockLlmCallStore.updateParsedOutput).toHaveBeenCalled();
    const [callId, parsedOutput] = vi.mocked(mockLlmCallStore.updateParsedOutput).mock.calls[0];
    expect(callId).toBe("test-llm-call-id");
    expect(parsedOutput).toBeDefined();
    expect(parsedOutput).toHaveProperty("biases");
    expect(parsedOutput).toHaveProperty("prompt_version");
  });

  it("should record fallback call when primary repair fails", async () => {
    // First call returns invalid JSON, second call (fallback) returns valid
    let callCount = 0;
    const originalCompleteJson = mockProvider.completeJson.bind(mockProvider);
    mockProvider.completeJson = async (request) => {
      callCount++;
      if (callCount === 1) {
        // Return invalid JSON that will fail repair
        return { result: "not valid json at all {{{" as any };
      }
      // Fallback returns valid response
      return originalCompleteJson(request);
    };

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

    await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000003",
        story: "c".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    // Verify both primary and fallback calls were recorded
    expect(mockLlmCallStore.recordCall).toHaveBeenCalledTimes(2);

    const primaryCall = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
    expect(primaryCall.callType).toBe("primary");

    const fallbackCall = vi.mocked(mockLlmCallStore.recordCall).mock.calls[1][0];
    expect(fallbackCall.callType).toBe("fallback");
    expect(fallbackCall.stage).toBe("assessment");
  });

  it("should call updateLlmCallFailure when both primary and fallback fail", async () => {
    repairBehavior = () => Promise.reject(new Error("Failed to produce valid output after repair and fallback"));

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000004",
        story: "d".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(502);
    expect(mockLlmCallStore.updateFailure).toHaveBeenCalled();

    repairBehavior = null;
  });

  it("should succeed even when updateLlmCallParsedOutput fails", async () => {
    vi.mocked(mockLlmCallStore.updateParsedOutput).mockRejectedValueOnce(new Error("DB down"));
    repairBehavior = () => Promise.resolve({
      result: {
        biases: [],
        reflectionPrompt: "a".repeat(50),
        noBiasDetected: true,
      },
      metadata: null,
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/reflection/assessment",
      headers: { authorization: "Bearer dev-secret-change-me" },
      payload: {
        sessionId: "00000000-0000-4000-8000-000000000005",
        story: "e".repeat(100),
        questions: ["Q1?"],
        answers: ["A1 with enough detail to pass validation."],
        mode: "full",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.noBiasDetected).toBe(true);

    repairBehavior = null;
  });
});
