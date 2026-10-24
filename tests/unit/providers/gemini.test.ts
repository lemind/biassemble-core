import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../src/lib/env.js";
import { logger } from "../../../src/observability/logger.js";
import { classifyGeminiError, GeminiProvider } from "../../../src/providers/gemini.js";
import { ProviderError, RateLimitError, TimeoutError, type CompletionRequest } from "../../../src/providers/types.js";

const STANDARD_KEY = "AIzaSyStandardKey123456";
const AUTH_KEY = "AQ.AuthKeyValue123456789";

const generateContent = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted(() => [] as { apiKey: string; model: string; timeout?: number }[]);

vi.mock("@google/generative-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/generative-ai")>();
  class GoogleGenerativeAI {
    constructor(public apiKey: string) {}
    getGenerativeModel(params: { model: string }, requestOptions?: { timeout?: number }) {
      constructed.push({ apiKey: this.apiKey, model: params.model, timeout: requestOptions?.timeout });
      return { generateContent };
    }
  }
  return { ...actual, GoogleGenerativeAI };
});

const request: CompletionRequest = { system: "Classify.", user: "The claim." };

function okResponse(text: string) {
  return {
    response: {
      text: () => text,
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    },
  };
}

function fail(status: number | undefined, message: string, details?: unknown) {
  const error = new Error(message) as Error & { status?: number; errorDetails?: unknown };
  if (status !== undefined) error.status = status;
  if (details !== undefined) error.errorDetails = details;
  generateContent.mockRejectedValueOnce(error);
}

describe("classifyGeminiError", () => {
  it("classifies a rejected key, including a standard key, as invalid_key", () => {
    expect(classifyGeminiError(401, "UNAUTHENTICATED ACCESS_TOKEN_TYPE_UNSUPPORTED")).toBe("invalid_key");
    expect(classifyGeminiError(400, "API key not valid. Please pass a valid API key. API_KEY_INVALID")).toBe("invalid_key");
    expect(classifyGeminiError(403, "Requests are blocked. reason: API_KEY_SERVICE_BLOCKED")).toBe("invalid_key");
    expect(classifyGeminiError(403, "Your API key was reported as leaked.")).toBe("invalid_key");
  });

  it("classifies a disabled Generative Language API as model_access_denied, not a rejected key", () => {
    expect(classifyGeminiError(403, "PERMISSION_DENIED Generative Language API has not been used in project 123 or it is disabled")).toBe("model_access_denied");
  });

  it("classifies a per-minute or daily quota as rate_limited, even when the text says quota", () => {
    expect(classifyGeminiError(
      429,
      "Quota exceeded for quota metric generate_content_requests and limit GenerateContentRequestsPerMinutePerProjectPerModel",
    )).toBe("rate_limited");
    expect(classifyGeminiError(429, "You exceeded your current quota, please check your plan and billing details.", [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }],
      },
    ])).toBe("rate_limited");
    expect(classifyGeminiError(429, "Quota exceeded for quota metric generate_content_free_tier_requests PerDay")).toBe("rate_limited");
    expect(classifyGeminiError(429, "Too many requests.")).toBe("rate_limited");
  });

  it("classifies a depleted balance or a spend cap as no_balance", () => {
    expect(classifyGeminiError(429, "RESOURCE_EXHAUSTED credits are depleted")).toBe("no_balance");
    expect(classifyGeminiError(429, "spend cap reached")).toBe("no_balance");
    expect(classifyGeminiError(403, "billing account quota exhausted")).toBe("no_balance");
  });

  it("leaves an outage and a bad request out of the key and balance categories", () => {
    expect(classifyGeminiError(500, "internal")).toBe("unavailable");
    expect(classifyGeminiError(503, "unavailable")).toBe("unavailable");
    expect(classifyGeminiError(400, "invalid argument: response schema")).toBeNull();
  });
});

describe("GeminiProvider", () => {
  afterEach(() => {
    generateContent.mockReset();
    constructed.length = 0;
    vi.restoreAllMocks();
  });

  it("uses the deployment model and authorization key when none are passed", async () => {
    generateContent.mockResolvedValueOnce(okResponse('{"result":"ok"}'));
    const provider = new GeminiProvider();
    const result = await provider.completeJson<{ result: string }>(request);
    expect(provider.model).toBe(env.GEMINI_MODEL);
    expect(constructed[0]).toMatchObject({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, timeout: env.AI_TIMEOUT_MS });
    expect(result).toEqual({ result: { result: "ok" }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  });

  it("calls the per-run model and sends a standard key through unchanged", async () => {
    generateContent.mockResolvedValueOnce(okResponse('{"result":"ok"}'));
    const provider = new GeminiProvider({ model: "gemini-2.5-flash-lite", apiKey: STANDARD_KEY });
    await provider.completeJson({ ...request, options: { timeoutMs: 1500 } });
    expect(provider.model).toBe("gemini-2.5-flash-lite");
    expect(constructed[0]).toEqual({ apiKey: STANDARD_KEY, model: "gemini-2.5-flash-lite", timeout: 1500 });
  });

  it("does not replace a blank visitor key with the deployment key", async () => {
    generateContent.mockResolvedValueOnce(okResponse('{"result":"ok"}'));
    await new GeminiProvider({ apiKey: "  " }).completeJson(request);
    expect(constructed[0]?.apiKey).toBe("");
    expect(constructed[0]?.apiKey).not.toBe(env.GEMINI_API_KEY);
  });

  it("sends an authorization-shaped visitor key through unchanged", async () => {
    generateContent.mockResolvedValueOnce(okResponse('{"result":"ok"}'));
    await new GeminiProvider({ apiKey: AUTH_KEY }).completeJson(request);
    expect(constructed[0]?.apiKey).toBe(AUTH_KEY);
    expect(constructed[0]?.model).toBe(env.GEMINI_MODEL);
  });

  it("throws invalid_key for a rejected standard key and drops the echoed key", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    fail(403, `Requests are blocked. reason: API_KEY_SERVICE_BLOCKED key=${STANDARD_KEY}`);
    const provider = new GeminiProvider({ apiKey: STANDARD_KEY });
    await expect(provider.completeJson(request)).rejects.toMatchObject({
      name: "ProviderError",
      category: "invalid_key",
      message: "The API key was rejected.",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(STANDARD_KEY);
  });

  it("throws no_balance for a depleted balance, without the raw body", async () => {
    fail(429, `credits are depleted key=${STANDARD_KEY}`);
    const error = await new GeminiProvider({ apiKey: STANDARD_KEY }).completeJson(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as ProviderError).category).toBe("no_balance");
    expect((error as ProviderError).message).toBe("The account has no balance for this model.");
    expect((error as ProviderError).message).not.toContain(STANDARD_KEY);
    expect((error as ProviderError).message).not.toContain("depleted");
  });

  it("keeps a per-minute quota as RateLimitError and logs the scrubbed limit", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    fail(
      429,
      `credits are depleted. key=${STANDARD_KEY}. Please reset in 30 seconds.`,
      [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{
          quotaMetric: "generativelanguage.googleapis.com/generate_content_requests",
          quotaId: "GenerateContentRequestsPerMinutePerProjectPerModel",
        }],
      }],
    );
    const error = await new GeminiProvider({ apiKey: STANDARD_KEY }).completeJson(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    const limit = error as RateLimitError;
    expect(limit.limitType).toBe("per-minute");
    expect(limit.message).toBe("Too many requests. Please try again later.");
    expect(limit.message).not.toContain(STANDARD_KEY);
    expect(limit.resetsAt).toBeDefined();
    const payload = warn.mock.calls[0]?.[0] as { limitType?: string; providerMessage?: string; resetsAt?: string };
    expect(payload.limitType).toBe("per-minute");
    expect(payload.resetsAt).toBe(limit.resetsAt);
    expect(payload.providerMessage).toContain("reset in 30 seconds");
    expect(payload.providerMessage).toContain("key=[REDACTED]");
    expect(payload.providerMessage).not.toContain(STANDARD_KEY);
  });

  it("reads a daily cap from the message when QuotaFailure lists no metric", async () => {
    fail(429, "Quota exceeded per day", [{
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [],
    }]);
    const error = await new GeminiProvider({ apiKey: STANDARD_KEY }).completeJson(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    const limit = error as RateLimitError;
    expect(limit.limitType).toBe("daily");
    expect(limit.message).toBe("Daily API quota exhausted. Please try again tomorrow.");
  });

  it("maps an outage and a network failure to unavailable without the raw message", async () => {
    fail(503, `overloaded ${STANDARD_KEY}`);
    await expect(new GeminiProvider({ apiKey: STANDARD_KEY }).completeJson(request)).rejects.toMatchObject({
      category: "unavailable",
      message: "The provider is unavailable.",
    });

    fail(undefined, "fetch failed");
    const error = await new GeminiProvider().completeJson(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).category).toBe("unavailable");
    expect((error as ProviderError).message).not.toContain("fetch failed");
  });

  it("turns an SDK abort into TimeoutError and a bad request into a plain error", async () => {
    fail(undefined, "This operation was aborted");
    await expect(new GeminiProvider().completeJson(request)).rejects.toBeInstanceOf(TimeoutError);

    fail(400, "invalid argument: response schema");
    await expect(new GeminiProvider().completeJson(request)).rejects.toThrow("The provider rejected the request.");
  });

  it("still reports malformed JSON as malformed JSON", async () => {
    generateContent.mockResolvedValueOnce(okResponse("not json"));
    await expect(new GeminiProvider().completeJson(request)).rejects.toThrow("Malformed JSON from AI provider");
  });
});
