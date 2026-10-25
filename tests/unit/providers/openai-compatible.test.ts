import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyRawResponseSchema } from "../../../src/orchestrators/grounnel/pipeline-schemas.js";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_MAX_TOKENS,
  OpenAICompatibleProvider,
  qwenChatCompletionsUrl,
} from "../../../src/providers/openai-compatible.js";
import { ProviderError, TimeoutError, type CompletionRequest } from "../../../src/providers/types.js";

const KEY = "sk-unit-test-key";

function http(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function successBody(content: string) {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

function provider(kind: "deepseek" | "qwen") {
  return new OpenAICompatibleProvider({
    provider: kind,
    model: kind === "deepseek" ? "deepseek-flash" : "qwen3.7-flash",
    apiKey: KEY,
    baseUrl: kind === "deepseek" ? DEEPSEEK_CHAT_COMPLETIONS_URL : qwenChatCompletionsUrl("WS-Test"),
  });
}

const bare: CompletionRequest = { system: "Classify the claim.", user: "The claim text." };

function stub(status: number, body: string) {
  const fetchMock = vi.fn().mockResolvedValue(http(status, body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: Record<string, unknown>; authorization: string } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { url, body: JSON.parse(init.body as string) as Record<string, unknown>, authorization: headers.authorization };
}

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a DeepSeek body with max_tokens, thinking off, and JSON-object mode", async () => {
    const fetchMock = stub(200, successBody('{"result":"ok"}'));
    const result = await provider("deepseek").completeJson<{ result: string }>({
      ...bare,
      options: { temperature: 0 },
    });
    const request = sent(fetchMock);
    expect(request.url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
    expect(request.authorization).toBe(`Bearer ${KEY}`);
    expect(request.body).toMatchObject({
      model: "deepseek-flash",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: DEEPSEEK_MAX_TOKENS,
      thinking: { type: "disabled" },
    });
    expect(result).toEqual({ result: { result: "ok" }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  });

  it("uses a caller maxTokens for DeepSeek and omits max_tokens for Qwen", async () => {
    const deepseekFetch = stub(200, successBody('{"result":"ok"}'));
    await provider("deepseek").completeJson({ ...bare, options: { maxTokens: 100 } });
    expect(sent(deepseekFetch).body.max_tokens).toBe(100);

    vi.unstubAllGlobals();
    const qwenFetch = stub(200, successBody('{"result":"ok"}'));
    await provider("qwen").completeJson({ ...bare, options: { maxTokens: 100 } });
    const qwen = sent(qwenFetch);
    expect(qwen.url).toBe("https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(qwen.body.enable_thinking).toBe(false);
    expect(qwen.body).not.toHaveProperty("max_tokens");
    expect(qwen.body).not.toHaveProperty("thinking");
    expect(qwen.body.response_format).toEqual({ type: "json_object" });
  });

  it("appends the word JSON and an example on this request only, without changing the caller's prompt", async () => {
    const fetchMock = stub(200, successBody('{"result":"ok"}'));
    const request: CompletionRequest = { system: "Classify the claim.", user: "The claim text." };
    await provider("deepseek").completeJson(request);
    expect(request.user).toBe("The claim text.");
    expect(request.system).toBe("Classify the claim.");
    const messages = sent(fetchMock).body.messages as Array<{ role: string; content: string }>;
    expect(messages.find((message) => message.role === "user")!.content).toBe(
      'The claim text.\n\nReply with a JSON object. Example: {"result":"ok"}'
    );
  });

  it("leaves a prompt that already has the word JSON and an example unchanged", async () => {
    const fetchMock = stub(200, successBody('{"result":"ok"}'));
    await provider("qwen").completeJson({
      system: 'Reply with JSON. Example: {"result":"ok"}',
      user: "The claim text.",
    });
    const messages = sent(fetchMock).body.messages as Array<{ role: string; content: string }>;
    expect(messages.find((message) => message.role === "user")!.content).toBe("The claim text.");
  });

  it("still appends when the prompt has only the word JSON", async () => {
    const fetchMock = stub(200, successBody('{"result":"ok"}'));
    await provider("deepseek").completeJson({ system: "Reply with JSON.", user: "no example here" });
    const messages = sent(fetchMock).body.messages as Array<{ role: string; content: string }>;
    expect(messages.find((message) => message.role === "user")!.content).toContain('Example: {"result":"ok"}');
  });

  it.each([
    [401, "invalid_key", "The API key was rejected."],
    [402, "no_balance", "The account has no balance for this model."],
    [429, "rate_limited", "The provider rate limit stopped this check."],
    [500, "unavailable", "The provider is unavailable."],
    [503, "unavailable", "The provider is unavailable."],
  ] as const)("maps a DeepSeek %s onto %s", async (status, category, message) => {
    stub(status, JSON.stringify({ error: { message: `echo ${KEY} in the body` } }));
    try {
      await provider("deepseek").completeJson(bare);
      expect.fail("expected a classified error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).category).toBe(category);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("treats a DeepSeek 400 as a rejected request, not a key category", async () => {
    stub(400, JSON.stringify({ error: { code: "invalid_request", message: `bad ${KEY}` } }));
    try {
      await provider("deepseek").completeJson(bare);
      expect.fail("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderError);
      expect((error as Error).message).toBe("The provider rejected the request.");
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("reads a Qwen 429 as throttling or as an empty balance, and drops an echoed key", async () => {
    stub(429, JSON.stringify({ error: { code: "Throttling.RateQuota", message: "Requests rate limit exceeded" } }));
    await expect(provider("qwen").completeJson(bare)).rejects.toMatchObject({
      category: "rate_limited",
      message: "The provider rate limit stopped this check.",
    });

    vi.unstubAllGlobals();
    const echoed = "sk-echoed-secret-value";
    stub(429, JSON.stringify({ error: { code: "AllocationQuota.Insufficient", message: `balance exhausted for ${echoed}` } }));
    try {
      await provider("qwen").completeJson(bare);
      expect.fail("expected no_balance");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).category).toBe("no_balance");
      expect((error as Error).message).toBe("The account has no balance for this model.");
      expect((error as Error).message).not.toContain(echoed);
      expect((error as Error).message).not.toContain("sk-");
    }
  });

  it("maps a Qwen 403 to model_access_denied, including when the body says the key is invalid", async () => {
    stub(403, JSON.stringify({ error: { code: "invalid_api_key", message: `model not purchased ${KEY}` } }));
    try {
      await provider("qwen").completeJson(bare);
      expect.fail("expected model_access_denied");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).category).toBe("model_access_denied");
      expect((error as Error).message).toBe("This account cannot use that model.");
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("maps a Qwen 403 insufficient_quota to no_balance, not model_access_denied", async () => {
    stub(403, JSON.stringify({ error: { code: "insufficient_quota", message: "Free quota exhausted. Please add funds or disable the \"use free tier only\" mode." } }));
    try {
      await provider("qwen").completeJson(bare);
      expect.fail("expected no_balance");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).category).toBe("no_balance");
      expect((error as Error).message).toBe("The account has no balance for this model.");
    }
  });

  it("maps a Qwen 401 to invalid_key", async () => {
    stub(401, JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key" } }));
    await expect(provider("qwen").completeJson(bare)).rejects.toMatchObject({
      category: "invalid_key",
      message: "The API key was rejected.",
    });
  });

  it("throws on empty content instead of returning an object", async () => {
    stub(200, successBody("   "));
    await expect(provider("deepseek").completeJson(bare)).rejects.toThrow("provider returned empty content");
  });

  it("throws the shared malformed-JSON error for a non-JSON payload and for non-JSON content", async () => {
    stub(200, "not-json");
    await expect(provider("qwen").completeJson(bare)).rejects.toThrow("Malformed JSON from AI provider");

    vi.unstubAllGlobals();
    stub(200, successBody("not json"));
    await expect(provider("qwen").completeJson(bare)).rejects.toThrow("Malformed JSON from AI provider");
  });

  it("turns an abort into a timeout and a network failure into an outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    await expect(provider("deepseek").completeJson({ ...bare, options: { timeoutMs: 20 } })).rejects.toBeInstanceOf(TimeoutError);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    try {
      await provider("qwen").completeJson(bare);
      expect.fail("expected unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).category).toBe("unavailable");
      expect((error as Error).message).toBe("The provider is unavailable.");
      expect((error as Error).message).not.toContain("fetch failed");
    }
  });

  it("sends a response schema as json_schema, not bare json_object", async () => {
    const fetchMock = stub(200, successBody('{"results":[]}'));
    await provider("deepseek").completeJson({ ...bare, responseSchema: VerifyRawResponseSchema });
    const format = sent(fetchMock).body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("grounnel_response");
    expect(format.json_schema.strict).toBe(false);
    expect(JSON.stringify(format.json_schema.schema)).toContain("evidenceCitations");
    expect(format).not.toEqual({ type: "json_object" });
  });

  it("falls back to json_object and an output contract when json_schema is rejected", async () => {
    const cited = { results: [{ id: "c1", verdict: "unsupported", reason: null, confidence: 0.2, evidenceCitations: null }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(http(400, JSON.stringify({ error: { message: "response_format json_schema is not supported" } })))
      .mockResolvedValueOnce(http(200, successBody(JSON.stringify(cited))));
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider("qwen").completeJson<{ results: unknown[] }>({ ...bare, responseSchema: VerifyRawResponseSchema });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      response_format: { type: string };
    };
    const second = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string) as {
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(first.response_format.type).toBe("json_schema");
    expect(second.response_format).toEqual({ type: "json_object" });
    const user = second.messages.find((message) => message.role === "user")!.content;
    expect(user).toContain("OUTPUT CONTRACT:");
    expect(user).toContain("evidenceCitations");
    expect(user).toContain("MUST include non-empty evidenceCitations");
    expect(user).toContain("the verdict is unsupported with evidenceCitations null");
    expect(result.result).toEqual(cited);
  });

  it("returns a reply that already includes evidence citations unchanged", async () => {
    const cited = {
      results: [{ id: "c1", verdict: "supported", reason: "same fact", confidence: 0.9, evidenceCitations: [{ source: "A", n: 2 }] }],
    };
    stub(200, successBody(JSON.stringify(cited)));
    const result = await provider("deepseek").completeJson({ ...bare, responseSchema: VerifyRawResponseSchema });
    expect(result.result).toEqual(cited);
  });

  it("rejects a workspace id that is not a host label, and lowercases a valid one", () => {
    expect(qwenChatCompletionsUrl("WS-AbC")).toBe(
      "https://ws-abc.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
    expect(() => qwenChatCompletionsUrl("bad id")).toThrow("Qwen workspace id is not a host label");
    expect(() => qwenChatCompletionsUrl("a-")).toThrow("Qwen workspace id is not a host label");
  });
});
