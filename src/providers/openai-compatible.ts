/** DeepSeek and Qwen chat-completions client. JSON-object mode. Qwen omits max_tokens (D033 §3, §6). */
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";
import { scrubErrorMessage } from "../persistence/error-scrub.js";
import {
  ProviderError,
  TimeoutError,
  type CompletionRequest,
  type Provider,
  type ProviderErrorCategory,
  type ProviderResponse,
  type TokenUsage,
} from "./types.js";

const MODULE = "openai-compatible";

/** DeepSeek cuts a JSON object off when max_tokens is omitted (D033 §6). */
export const DEEPSEEK_MAX_TOKENS = 8192;

export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";

const JSON_REQUEST_SUFFIX = 'Reply with a JSON object. Example: {"result":"ok"}';

const CATEGORY_MESSAGE: Record<ProviderErrorCategory, string> = {
  invalid_key: "The API key was rejected.",
  no_balance: "The account has no balance for this model.",
  rate_limited: "The provider rate limit stopped this check.",
  unavailable: "The provider is unavailable.",
  model_access_denied: "This account cannot use that model.",
};

export interface OpenAICompatibleConfig {
  provider: "deepseek" | "qwen";
  model: string;
  apiKey: string;
  /** Full chat-completions URL, including the Qwen workspace host. */
  baseUrl: string;
}

interface ProviderErrorBody {
  code?: unknown;
  message?: unknown;
}

export function qwenChatCompletionsUrl(workspaceId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId)) {
    throw new Error("Qwen workspace id is not a host label");
  }
  return `https://${workspaceId.toLowerCase()}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
}

/** DeepSeek follows the HTTP status. Qwen does not: a 429 and a 403 depend on the error code (D033 §3). */
export function classifyCompatibleError(
  provider: "deepseek" | "qwen",
  status: number,
  code: string,
  message: string,
): ProviderErrorCategory | null {
  if (provider === "deepseek") {
    if (status === 401) return "invalid_key";
    if (status === 402) return "no_balance";
    if (status === 429) return "rate_limited";
    if (status === 500 || status === 503) return "unavailable";
    return null;
  }
  const blob = `${code} ${message}`.toLowerCase();
  // A 403 is an unpurchased model even when the body also says the key is invalid (D033 §3).
  if (status === 403) return "model_access_denied";
  if (status === 429) {
    // Throttling.RateQuota is an RPM limit. Balance is arrears, exhausted, or AllocationQuota (D033 §3).
    if (/arrears|insufficient|exhausted|allocationquota|overdue/.test(blob)) return "no_balance";
    return "rate_limited";
  }
  if (status === 401 || /invalid_api_key|incorrect api key/.test(blob)) return "invalid_key";
  if (status === 500 || status === 503) return "unavailable";
  return null;
}

function promptHasJsonContract(system: string, user: string): boolean {
  const combined = `${system}\n${user}`;
  return /\bjson\b/i.test(combined) && /\{[^{}]*\}/.test(combined);
}

export class OpenAICompatibleProvider implements Provider {
  readonly mode: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.mode = config.provider;
  }

  async completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>> {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;
    const { system, user } = this.requestMessages(request.system, request.user);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: request.options?.temperature ?? 0,
    };
    if (this.config.provider === "deepseek") {
      body.max_tokens = request.options?.maxTokens ?? DEEPSEEK_MAX_TOKENS;
      body.thinking = { type: "disabled" };
    } else {
      body.enable_thinking = false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.config.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw await this.errorForResponse(response);
      return await this.parseSuccess<T>(response);
    } catch (error: unknown) {
      if (error instanceof ProviderError || error instanceof TimeoutError) throw error;
      if (isKeptProviderError(error)) throw error;
      if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out|aborted|abort/i.test(error.message))) {
        throw new TimeoutError("provider call timed out");
      }
      logger.warn({ module: MODULE, operation: "completeJson", provider: this.config.provider }, "provider call failed");
      throw new ProviderError("unavailable", CATEGORY_MESSAGE.unavailable);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestMessages(system: string, user: string): { system: string; user: string } {
    if (promptHasJsonContract(system, user)) return { system, user };
    return { system, user: `${user}\n\n${JSON_REQUEST_SUFFIX}` };
  }

  private async errorForResponse(response: Response): Promise<Error> {
    const detail = await readErrorBody(response, this.config.apiKey);
    const category = classifyCompatibleError(this.config.provider, response.status, detail.code, detail.message);
    if (!category) {
      logger.warn(
        { module: MODULE, operation: "completeJson", provider: this.config.provider, status: response.status },
        "provider rejected the request",
      );
      return new Error("The provider rejected the request.");
    }
    logger.warn(
      { module: MODULE, operation: "completeJson", provider: this.config.provider, status: response.status, category, code: detail.code },
      "provider call classified",
    );
    return new ProviderError(category, CATEGORY_MESSAGE[category]);
  }

  private async parseSuccess<T>(response: Response): Promise<ProviderResponse<T>> {
    const raw = await response.text();
    let payload: {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      throw new Error("Malformed JSON from AI provider");
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("provider returned empty content");
    }
    let result: T;
    try {
      result = JSON.parse(content) as T;
    } catch {
      throw new Error("Malformed JSON from AI provider");
    }
    const usage = payload.usage;
    const tokens: TokenUsage | undefined = usage
      ? {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }
      : undefined;
    return { result, usage: tokens };
  }
}

function isKeptProviderError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === "provider returned empty content" ||
      error.message === "Malformed JSON from AI provider" ||
      error.message === "The provider rejected the request.")
  );
}

async function readErrorBody(response: Response, apiKey: string): Promise<{ code: string; message: string }> {
  const raw = scrubErrorMessage(await response.text(), [apiKey]) ?? "";
  try {
    const parsed = JSON.parse(raw) as { error?: ProviderErrorBody } | ProviderErrorBody;
    const error = parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object"
      ? parsed.error
      : (parsed as ProviderErrorBody);
    return {
      code: typeof error.code === "string" ? error.code : "",
      message: typeof error.message === "string" ? error.message : "",
    };
  } catch {
    return { code: "", message: "" };
  }
}
