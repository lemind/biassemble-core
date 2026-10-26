import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../src/lib/env.js";
import { GeminiProvider } from "../../../src/providers/gemini.js";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  OpenAICompatibleProvider,
  qwenChatCompletionsUrl,
} from "../../../src/providers/openai-compatible.js";
import {
  PROVIDER_CLAIM_CAP,
  ProviderKeyRequiredError,
  SITE_DEFAULT_PROVIDER,
  UnknownProviderError,
  providerOption,
  providerOptions,
  resolveProvider,
} from "../../../src/providers/registry.js";
import type { Provider } from "../../../src/providers/types.js";

const WORKSPACE = "ws-test";
const VISITOR_KEY = "AIzaSyVisitorKey123456";
const OWN_KEY = "sk-registry-test-key";

const geminiKeys = vi.hoisted(() => [] as string[]);

vi.mock("../../../src/lib/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/env.js")>();
  return { ...actual, env: { ...actual.env, QWEN_WORKSPACE_ID: "ws-test" } };
});

vi.mock("@google/generative-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/generative-ai")>();
  class GoogleGenerativeAI {
    constructor(public apiKey: string) {
      geminiKeys.push(apiKey);
    }
    getGenerativeModel() {
      return { generateContent: vi.fn() };
    }
  }
  return { ...actual, GoogleGenerativeAI };
});

function httpOk() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

async function sent(provider: Provider): Promise<{ url: string; model: string; authorization: string }> {
  const fetchMock = vi.fn().mockResolvedValue(httpOk());
  vi.stubGlobal("fetch", fetchMock);
  await provider.completeJson({ system: "Reply with JSON.", user: "ok" });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  const body = JSON.parse(init.body as string) as { model: string };
  return { url, model: body.model, authorization: headers.authorization };
}

describe("provider registry", () => {
  afterEach(() => {
    geminiKeys.length = 0;
    vi.unstubAllGlobals();
  });

  it("lists the three own-key providers at cap 40, with Gemini as the hidden site default", () => {
    expect(providerOptions.map((option) => option.id)).toEqual(["gemini", "deepseek", "qwen"]);
    for (const option of providerOptions) {
      expect(option.claimCap).toBe(PROVIDER_CLAIM_CAP);
      expect(option.claimCap).toBe(40);
      expect(option.selectableWithOwnKey).toBe(true);
    }
    expect(providerOption("gemini")?.defaultModel).toBe(env.GEMINI_MODEL);
    expect(providerOption("deepseek")?.defaultModel).toBe("deepseek-flash");
    expect(providerOption("qwen")?.defaultModel).toBe("qwen3.7-flash");
    expect(providerOption("claude")).toBeUndefined();
    expect(SITE_DEFAULT_PROVIDER).toBe("gemini");
  });

  it("builds Gemini on the deployment model and key, and forwards a visitor key", () => {
    const site = resolveProvider("gemini");
    expect(site).toBeInstanceOf(GeminiProvider);
    expect((site as GeminiProvider).model).toBe(env.GEMINI_MODEL);
    expect(geminiKeys).toEqual([env.GEMINI_API_KEY]);

    const own = resolveProvider("gemini", VISITOR_KEY);
    expect((own as GeminiProvider).model).toBe(env.GEMINI_MODEL);
    expect(geminiKeys[1]).toBe(VISITOR_KEY);
  });

  it("builds DeepSeek and Qwen with the caller key, model, and endpoint", async () => {
    const deepseek = resolveProvider("deepseek", OWN_KEY);
    expect(deepseek).toBeInstanceOf(OpenAICompatibleProvider);
    expect(deepseek.mode).toBe("deepseek");
    const deepseekCall = await sent(deepseek);
    expect(deepseekCall.url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
    expect(deepseekCall.model).toBe("deepseek-flash");
    expect(deepseekCall.authorization).toBe(`Bearer ${OWN_KEY}`);

    const qwen = resolveProvider("qwen", OWN_KEY);
    expect(qwen.mode).toBe("qwen");
    const qwenCall = await sent(qwen);
    expect(qwenCall.url).toBe(qwenChatCompletionsUrl(WORKSPACE));
    expect(qwenCall.model).toBe("qwen3.7-flash");
    expect(qwenCall.authorization).toBe(`Bearer ${OWN_KEY}`);
  });

  it("refuses DeepSeek and Qwen without a key, and rejects an unknown id", () => {
    expect(() => resolveProvider("deepseek")).toThrow(ProviderKeyRequiredError);
    expect(() => resolveProvider("qwen", "  ")).toThrow(ProviderKeyRequiredError);
    expect(() => resolveProvider("claude")).toThrow(UnknownProviderError);
    try {
      resolveProvider("claude");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownProviderError);
      expect((error as UnknownProviderError).message).not.toContain("claude");
    }
  });
});
