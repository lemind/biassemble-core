import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../src/observability/logger.js";
import {
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  OpenAICompatibleProvider,
  qwenChatCompletionsUrl,
} from "../../../src/providers/openai-compatible.js";
import { PREFLIGHT_PROMPT, PREFLIGHT_TIMEOUT_MS, preflightHttpStatus, preflightOwnKey } from "../../../src/providers/preflight.js";
import { GeminiProvider } from "../../../src/providers/gemini.js";
import { ProviderError, type Provider } from "../../../src/providers/types.js";

const KEY = "sk-unit-test-key";
const GEMINI_KEY = "AIzaSyVisitorKey123456";
const ARTICLE = "Some pasted article text.";

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

function http(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function provider(kind: "deepseek" | "qwen") {
  return new OpenAICompatibleProvider({
    provider: kind,
    model: kind === "deepseek" ? "deepseek-flash" : "qwen3.7-flash",
    apiKey: KEY,
    baseUrl: kind === "deepseek" ? DEEPSEEK_CHAT_COMPLETIONS_URL : qwenChatCompletionsUrl("ws-test"),
  });
}

function stub(status: number, body: string) {
  const fetchMock = vi.fn().mockResolvedValue(http(status, body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof vi.fn>): { url: string; method: string; body: string | undefined; authorization: string } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return {
    url,
    method: init.method ?? "GET",
    body: typeof init.body === "string" ? init.body : undefined,
    authorization: headers.authorization,
  };
}

describe("preflight (T2013)", () => {
  afterEach(() => {
    generateContent.mockReset();
    constructed.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checks DeepSeek with GET /user/balance and does not send the article", async () => {
    const fetchMock = stub(200, JSON.stringify({ is_available: true, balance_infos: [{ total_balance: "77.25" }] }));
    await provider("deepseek").preflight();
    const request = sent(fetchMock);
    expect(request.url).toBe(DEEPSEEK_BALANCE_URL);
    expect(request.method).toBe("GET");
    expect(request.authorization).toBe(`Bearer ${KEY}`);
    expect(request.body).toBeUndefined();
    expect(request.url).not.toContain(ARTICLE);
  });

  it("classifies DeepSeek is_available false as no_balance and drops the amounts", async () => {
    const warn = vi.spyOn(logger, "warn");
    stub(200, JSON.stringify({ is_available: false, balance_infos: [{ total_balance: "77.25" }] }));
    await expect(provider("deepseek").preflight()).rejects.toMatchObject({
      category: "no_balance",
      message: "The account has no balance for this model.",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("77.25");
    expect(logged).not.toContain(KEY);
  });

  it("classifies a DeepSeek 401 without returning the body", async () => {
    const raw = `Authentication Fails, ${KEY} echoed`;
    stub(401, JSON.stringify({ error: { message: raw, code: "invalid_request_error" } }));
    const error = await provider("deepseek").preflight().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ category: "invalid_key", message: "The API key was rejected." });
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("sends Qwen one fixed completion and omits max_tokens", async () => {
    const fetchMock = stub(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    await provider("qwen").preflight();
    const request = sent(fetchMock);
    const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    expect(request.url).toBe(qwenChatCompletionsUrl("ws-test"));
    expect(request.method).toBe("POST");
    expect(body).toEqual({
      model: "qwen3.7-flash",
      messages: [{ role: "user", content: PREFLIGHT_PROMPT }],
      enable_thinking: false,
    });
    expect(body).not.toHaveProperty("max_tokens");
    expect(request.body).not.toContain(ARTICLE);
  });

  it("classifies a Qwen 403 as model access even when the body says the key is invalid", async () => {
    stub(403, JSON.stringify({ error: { message: `invalid_api_key ${KEY}`, code: "invalid_api_key" } }));
    await expect(provider("qwen").preflight()).rejects.toMatchObject({
      category: "model_access_denied",
      message: "This account cannot use that model.",
    });
  });

  it("classifies Qwen throttling as a rate limit and an allocation quota as no balance", async () => {
    stub(429, JSON.stringify({ error: { message: "rate", code: "Throttling.RateQuota" } }));
    await expect(provider("qwen").preflight()).rejects.toMatchObject({ category: "rate_limited" });
    vi.unstubAllGlobals();
    stub(429, JSON.stringify({ error: { message: "quota", code: "AllocationQuota.Insufficient" } }));
    await expect(provider("qwen").preflight()).rejects.toMatchObject({ category: "no_balance" });
  });

  it("sends Gemini the fixed prompt on the visitor key and classifies a rejected key", async () => {
    const warn = vi.spyOn(logger, "warn");
    generateContent.mockResolvedValueOnce({ response: { text: () => "ok" } });
    const gemini = new GeminiProvider({ apiKey: GEMINI_KEY });
    await gemini.preflight();
    expect(generateContent).toHaveBeenCalledWith({
      contents: [{ role: "user", parts: [{ text: PREFLIGHT_PROMPT }] }],
    });
    expect(constructed[0]).toMatchObject({ apiKey: GEMINI_KEY, timeout: PREFLIGHT_TIMEOUT_MS });
    expect(JSON.stringify(generateContent.mock.calls)).not.toContain(ARTICLE);

    const error = new Error(`API key not valid. Please pass a valid API key. ${GEMINI_KEY}`) as Error & { status?: number };
    error.status = 400;
    generateContent.mockRejectedValueOnce(error);
    await expect(gemini.preflight()).rejects.toMatchObject({
      category: "invalid_key",
      message: "The API key was rejected.",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(GEMINI_KEY);
  });

  it("maps a Gemini rate limit to the short sentence and keeps the category", async () => {
    const error = new Error("Quota exceeded for quota metric generate_content_requests PerMinute") as Error & { status?: number };
    error.status = 429;
    generateContent.mockRejectedValueOnce(error);
    const failure = await preflightOwnKey(new GeminiProvider({ apiKey: GEMINI_KEY }));
    expect(failure).toEqual({ category: "rate_limited", message: "Too many requests. Please try again later." });
  });

  it("fails closed when the provider has no probe, and times out as unavailable", async () => {
    const completeJson = vi.fn();
    const missing = await preflightOwnKey({ mode: "mock", model: "mock", completeJson } as Provider);
    expect(missing).toEqual({ category: "unavailable", message: "The provider is unavailable." });
    expect(completeJson).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const pending = preflightOwnKey({
      mode: "gemini",
      model: "gemini-2.0-flash",
      preflight: () => new Promise(() => {}),
      completeJson,
    });
    await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ category: "unavailable", message: "The provider is unavailable." });
  });

  it("maps categories onto HTTP statuses without a site-key fallback field", () => {
    expect(preflightHttpStatus("invalid_key")).toBe(400);
    expect(preflightHttpStatus("no_balance")).toBe(400);
    expect(preflightHttpStatus("model_access_denied")).toBe(400);
    expect(preflightHttpStatus("rate_limited")).toBe(429);
    expect(preflightHttpStatus("unavailable")).toBe(503);
  });
});
