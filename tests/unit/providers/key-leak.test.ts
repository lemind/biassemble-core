import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callLlmForJson, type LlmCallCompletionInfo } from "../../../src/orchestrators/llm-json-call.js";
import { withRetry } from "../../../src/orchestrators/retry.js";
import { logger } from "../../../src/observability/logger.js";
import { scrubErrorMessage } from "../../../src/persistence/error-scrub.js";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  OpenAICompatibleProvider,
} from "../../../src/providers/openai-compatible.js";
import { preflightOwnKey } from "../../../src/providers/preflight.js";

const KEY = "sk-leak-check-key-value";
const Schema = z.object({ result: z.string() });

function http(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function provider() {
  return new OpenAICompatibleProvider({
    provider: "deepseek",
    model: "deepseek-flash",
    apiKey: KEY,
    baseUrl: DEEPSEEK_CHAT_COMPLETIONS_URL,
  });
}

function dump(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) return { name: item.name, message: item.message, ...item };
    return item;
  });
}

function assertNoKey(label: string, value: unknown) {
  expect(dump(value), label).not.toContain(KEY);
}

describe("key leak checks (T2015)", () => {
  const warn = vi.spyOn(logger, "warn");
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");

  afterEach(() => {
    warn.mockClear();
    info.mockClear();
    error.mockClear();
    vi.unstubAllGlobals();
  });

  function logs() {
    return [warn.mock.calls, info.mock.calls, error.mock.calls];
  }

  it("keeps the key out of a successful call's stored row and logs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(http(200, JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: '{"result":"ok"}' }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const stored: LlmCallCompletionInfo[] = [];
    const result = await callLlmForJson({
      provider: provider(),
      system: "Reply with JSON.",
      user: "ok",
      schema: Schema,
      expectedKeys: ["result"],
      attempts: 1,
      module: "key-leak",
      operation: "success",
      onComplete: (info) => stored.push(info),
    });
    expect(result).toEqual({ result: "ok" });
    expect(fetchMock.mock.calls[0]?.[1].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("success");
    assertNoKey("stored row", stored);
    assertNoKey("logs", logs());
    const job = { provider: "deepseek", model: "deepseek-flash" };
    assertNoKey("job payload", job);
  });

  it("drops a key echoed in a provider error from the stored error and the user message", async () => {
    const raw = JSON.stringify({ error: { code: "invalid_request_error", message: `Incorrect API key provided: ${KEY}` } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(http(401, raw)));
    const stored: LlmCallCompletionInfo[] = [];
    const thrown = await callLlmForJson({
      provider: provider(),
      system: "Reply with JSON.",
      user: "ok",
      schema: Schema,
      expectedKeys: ["result"],
      attempts: 2,
      module: "key-leak",
      operation: "error",
      onComplete: (info) => stored.push(info),
    }).catch((err: unknown) => err);
    expect(thrown).toMatchObject({ message: "The API key was rejected." });
    expect(stored[0]?.errorMessage).toBe("The API key was rejected.");
    expect(scrubErrorMessage(raw, [KEY])).not.toContain(KEY);
    const preflight = await preflightOwnKey(provider());
    assertNoKey("user message", thrown);
    assertNoKey("stored error", stored);
    assertNoKey("preflight", preflight);
    assertNoKey("logs", logs());
  });

  it("keeps the key out of a rate-limit retry and any job payload", async () => {
    const raw = JSON.stringify({ error: { message: `rate limit for ${KEY}`, code: "rate_limit" } });
    const fetchMock = vi.fn().mockResolvedValue(http(429, raw));
    vi.stubGlobal("fetch", fetchMock);
    const stored: LlmCallCompletionInfo[] = [];
    const judge = provider();
    const thrown = await callLlmForJson({
      provider: judge,
      system: "Reply with JSON.",
      user: "ok",
      schema: Schema,
      expectedKeys: ["result"],
      attempts: 2,
      module: "key-leak",
      operation: "rate",
      onComplete: (info) => stored.push(info),
    }).catch((err: unknown) => err);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(2);
    expect(thrown).toMatchObject({ category: "rate_limited" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(http(429, raw)));
    const retried = await withRetry(() => provider().completeJson({ system: "Reply with JSON.", user: "ok" }), {
      maxRetries: 2,
      baseDelayMs: 0,
    }).catch((err: unknown) => err);

    const job = { name: "grounnel/check", data: { provider: "deepseek", model: "deepseek-flash" } };
    assertNoKey("retry rows", stored);
    assertNoKey("user message", thrown);
    assertNoKey("withRetry error", retried);
    assertNoKey("job payload", job);
    assertNoKey("logs", logs());
  });
});
