import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetriableError } from "inngest";
import { env } from "../../../src/lib/env.js";
import { GeminiProvider } from "../../../src/providers/gemini.js";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, qwenChatCompletionsUrl } from "../../../src/providers/openai-compatible.js";
import { ProviderKeyRequiredError, UnknownProviderError } from "../../../src/providers/registry.js";
import { evalAbortKind, providerForEvent, resolveEvalProvider } from "../../../src/jobs/eval-grounnel-run.js";

const DEPLOY_DEEPSEEK = "sk-eval-deploy";
const DEPLOY_QWEN = "sk-eval-qwen";
const PASTED = "sk-pasted-into-provider-slot";

const geminiKeys = vi.hoisted(() => [] as string[]);

vi.mock("../../../src/lib/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/env.js")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      GEMINI_API_KEY: "test-key",
      GEMINI_MODEL: "gemini-2.0-flash",
      DEEPSEEK_API_KEY: "sk-eval-deploy",
      QWEN_API_KEY: "sk-eval-qwen",
      QWEN_WORKSPACE_ID: "ws-test",
    },
  };
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

afterEach(() => {
  geminiKeys.length = 0;
  env.DEEPSEEK_API_KEY = DEPLOY_DEEPSEEK;
  env.QWEN_API_KEY = DEPLOY_QWEN;
  env.QWEN_WORKSPACE_ID = "ws-test";
  vi.unstubAllGlobals();
});

describe("resolveEvalProvider (T2016)", () => {
  it("uses the Gemini deployment key when the event names no provider", () => {
    const provider = resolveEvalProvider(undefined);
    expect(provider.mode).toBe("gemini");
    expect(provider.model).toBe(env.GEMINI_MODEL);
    expect(geminiKeys).toEqual(["test-key"]);
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it("builds DeepSeek and Qwen with the deployment key and the fixed model", async () => {
    const seen: Array<{ url: string; authorization: string | null; model: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({
        url,
        authorization: headers.get("authorization"),
        model: JSON.parse(String(init.body)).model,
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      };
    });

    const deepseek = resolveEvalProvider("deepseek");
    await deepseek.completeJson({ system: "Reply with JSON.", user: '{"ok":true}' });
    const qwen = resolveEvalProvider("qwen");
    await qwen.completeJson({ system: "Reply with JSON.", user: '{"ok":true}' });

    expect(deepseek.model).toBe("deepseek-flash");
    expect(qwen.model).toBe("qwen3.7-flash");
    expect(seen[0]).toMatchObject({
      url: DEEPSEEK_CHAT_COMPLETIONS_URL,
      authorization: `Bearer ${DEPLOY_DEEPSEEK}`,
      model: "deepseek-flash",
    });
    expect(seen[1]).toMatchObject({
      url: qwenChatCompletionsUrl("ws-test"),
      authorization: `Bearer ${DEPLOY_QWEN}`,
      model: "qwen3.7-flash",
    });
  });

  it("rejects an unknown id without putting that id in the message", () => {
    expect(() => resolveEvalProvider(PASTED)).toThrow(UnknownProviderError);
    try {
      resolveEvalProvider(PASTED);
    } catch (err) {
      expect((err as Error).message).toBe("Unknown provider.");
      expect((err as Error).message).not.toContain(PASTED);
    }
  });

  it("fails closed when the deployment key is missing, and the error does not carry a key", () => {
    env.DEEPSEEK_API_KEY = undefined;
    try {
      providerForEvent("deepseek");
      expect.fail("expected a missing deployment key to stop the job");
    } catch (err) {
      expect(err).toBeInstanceOf(NonRetriableError);
      expect((err as Error).message).toBe("A provider key is required to build this client.");
      expect((err as Error).message).not.toContain(DEPLOY_DEEPSEEK);
      expect((err as Error).cause).toBeInstanceOf(ProviderKeyRequiredError);
    }
  });
});

describe("evalAbortKind (T2016)", () => {
  it("keeps a depleted-credit message as billing and names the new stopping sentences", () => {
    expect(evalAbortKind("credits are depleted")).toBe("billing");
    expect(evalAbortKind("The account has no balance for this model.")).toBe("balance");
    expect(evalAbortKind("The API key was rejected.")).toBe("key");
    expect(evalAbortKind("This account cannot use that model.")).toBe("model");
    expect(evalAbortKind("Too many requests. Please try again later.")).toBe("rate");
    expect(evalAbortKind("the network dropped")).toBeNull();
  });
});
