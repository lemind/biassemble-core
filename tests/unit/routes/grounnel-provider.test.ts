import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../src/lib/env.js";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, qwenChatCompletionsUrl } from "../../../src/providers/openai-compatible.js";
import { chooseExtractProvider } from "../../../src/routes/grounnel.js";
import type { Provider } from "../../../src/providers/types.js";

const DEPLOY_DEEPSEEK = "sk-eval-deploy";
const DEPLOY_QWEN = "sk-eval-qwen";
const VISITOR_GEMINI = "AIzaSyVisitorKey123456";
const VISITOR_DEEPSEEK = "sk-visitor-deepseek-key";
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

describe("chooseExtractProvider (T2010)", () => {
  afterEach(() => {
    geminiKeys.length = 0;
    env.DEEPSEEK_API_KEY = DEPLOY_DEEPSEEK;
    env.QWEN_API_KEY = DEPLOY_QWEN;
    env.QWEN_WORKSPACE_ID = "ws-test";
    vi.unstubAllGlobals();
  });

  it("keeps an omitted provider and an omitted key on the boot Gemini client", () => {
    expect(chooseExtractProvider(undefined, undefined)).toEqual({ ok: true });
    expect(chooseExtractProvider("gemini", "   ")).toEqual({ ok: true });
    expect(geminiKeys).toEqual([]);
  });

  it("keeps an omitted provider on the boot client even when the hidden choice is not Gemini", () => {
    expect(chooseExtractProvider(undefined, undefined, "deepseek")).toEqual({ ok: true });
    expect(geminiKeys).toEqual([]);
  });

  it("rejects deepseek and qwen without a key while the hidden choice stays Gemini", () => {
    expect(chooseExtractProvider("deepseek", undefined)).toEqual({ ok: false, status: 400, error: "provider_requires_own_key" });
    expect(chooseExtractProvider("  qwen  ", "")).toEqual({ ok: false, status: 400, error: "provider_requires_own_key" });
  });

  it("uses the deployment key when the hidden choice is that provider", async () => {
    const deepseek = chooseExtractProvider("deepseek", undefined, "deepseek");
    expect(deepseek.ok).toBe(true);
    if (!deepseek.ok) return;
    expect(deepseek.keySource).toBe("site");
    expect(await sent(deepseek.provider!)).toMatchObject({
      url: DEEPSEEK_CHAT_COMPLETIONS_URL,
      model: "deepseek-flash",
      authorization: `Bearer ${DEPLOY_DEEPSEEK}`,
    });

    const qwen = chooseExtractProvider("qwen", undefined, "qwen");
    expect(qwen.ok).toBe(true);
    if (!qwen.ok) return;
    expect(qwen.keySource).toBe("site");
    expect(await sent(qwen.provider!)).toMatchObject({
      url: qwenChatCompletionsUrl("ws-test"),
      model: "qwen3.7-flash",
      authorization: `Bearer ${DEPLOY_QWEN}`,
    });
  });

  it("builds an own-key client and does not use the deployment key", async () => {
    const gemini = chooseExtractProvider(undefined, VISITOR_GEMINI);
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;
    expect(gemini.keySource).toBe("own");
    expect(gemini.provider?.mode).toBe("gemini");
    expect(gemini.provider?.model).toBe(env.GEMINI_MODEL);
    expect(geminiKeys).toEqual([VISITOR_GEMINI]);

    const deepseek = chooseExtractProvider("deepseek", VISITOR_DEEPSEEK);
    expect(deepseek.ok).toBe(true);
    if (!deepseek.ok) return;
    expect(deepseek.keySource).toBe("own");
    const outbound = await sent(deepseek.provider!);
    expect(outbound.authorization).toBe(`Bearer ${VISITOR_DEEPSEEK}`);
    expect(outbound.authorization).not.toContain(DEPLOY_DEEPSEEK);
  });

  it("rejects an unknown provider without echoing the header", () => {
    const decision = chooseExtractProvider(PASTED, VISITOR_DEEPSEEK);
    expect(decision).toEqual({ ok: false, status: 400, error: "unknown_provider" });
    expect(JSON.stringify(decision)).not.toContain(PASTED);
    expect(JSON.stringify(decision)).not.toContain(VISITOR_DEEPSEEK);
    expect(chooseExtractProvider(["deepseek", PASTED], undefined)).toEqual({ ok: false, status: 400, error: "unknown_provider" });
    expect(JSON.stringify(chooseExtractProvider(["sk-array-provider"], undefined))).not.toContain("sk-array-provider");
  });

  it("does not read a non-string key header", () => {
    expect(chooseExtractProvider("gemini", ["sk-array-key"])).toEqual({ ok: true });
    expect(chooseExtractProvider("deepseek", ["sk-array-key"])).toEqual({ ok: false, status: 400, error: "provider_requires_own_key" });
    expect(JSON.stringify(chooseExtractProvider("deepseek", ["sk-array-key"]))).not.toContain("sk-array-key");
    expect(geminiKeys).toEqual([]);
  });

  it("fails closed when the allowed site provider has no deployment key", () => {
    env.DEEPSEEK_API_KEY = undefined;
    const decision = chooseExtractProvider("deepseek", undefined, "deepseek");
    expect(decision).toEqual({ ok: false, status: 502, error: "Extract failed" });
    expect(JSON.stringify(decision)).not.toContain("sk-");
  });

  it("fails closed when Qwen has no workspace, without echoing the visitor key", () => {
    env.QWEN_WORKSPACE_ID = undefined;
    const decision = chooseExtractProvider("qwen", VISITOR_DEEPSEEK);
    expect(decision).toEqual({ ok: false, status: 502, error: "Extract failed" });
    expect(JSON.stringify(decision)).not.toContain(VISITOR_DEEPSEEK);
  });
});
