import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env";
import { logger } from "../observability/logger";
import { extractJson } from "../parsers/json-from-llm";
import { scrubErrorMessage } from "../persistence/error-scrub";
import { zodToGeminiSchema } from "./gemini-schema";
import type { Provider, CompletionRequest, ProviderErrorCategory, ProviderResponse, TokenUsage } from "./types";
import { ProviderError, RateLimitError, TimeoutError } from "./types";

/** Default temperature for AI provider calls */
const DEFAULT_TEMPERATURE = 0.7;

const MODULE = "gemini-provider";

const CATEGORY_MESSAGE: Record<ProviderErrorCategory, string> = {
  invalid_key: "The API key was rejected.",
  no_balance: "The account has no balance for this model.",
  rate_limited: "The provider rate limit stopped this check.",
  unavailable: "The provider is unavailable.",
  model_access_denied: "This account cannot use that model.",
};

const PER_MINUTE = /per[\s_-]?minute|requests per minute|\brate limit\b|\brpm\b/i;
const DAILY = /per[\s_-]?day|\bdaily\b/i;
const BILLING = /billing|credit|depleted|spend(?:ing)? cap|arrears/i;
const KEY_REJECTED = /api[_ ]key|unauthenticated|permission_denied|access_token_type_unsupported|auth/;

export interface GeminiProviderOptions {
  /** Per-run model. Absent means the deployment model. */
  model?: string;
  /** Visitor key. Absent means the deployment authorization key. */
  apiKey?: string;
}

interface GeminiErrorDetail {
  "@type"?: string;
  violations?: unknown;
}

/** Per-minute and daily quota are rate limits. A depleted balance or a spend cap is no_balance (D033 §3, 2026-08-28). */
export function classifyGeminiError(
  status: number,
  blob: string,
  details?: readonly GeminiErrorDetail[],
): ProviderErrorCategory | null {
  const kind = limitKind(blob, details);
  const keyRejected = KEY_REJECTED.test(blob.toLowerCase());
  if (status === 401 || (status === 400 && keyRejected) || (status === 403 && keyRejected && kind !== "billing")) {
    return "invalid_key";
  }
  if ((kind === "per-minute" || kind === "daily") && (status === 429 || status === 403 || status === 400)) {
    return "rate_limited";
  }
  if (kind === "billing" && (status === 429 || status === 403 || status === 400)) return "no_balance";
  if (status === 429) return "rate_limited";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "unavailable";
  return null;
}

/** QuotaFailure quotaId/quotaMetric wins. The message is used only when that detail is absent. */
function limitKind(
  blob: string,
  details?: readonly GeminiErrorDetail[],
): "per-minute" | "daily" | "billing" | null {
  const metric = quotaMetricText(details);
  const source = metric ?? blob;
  if (PER_MINUTE.test(source)) return "per-minute";
  if (BILLING.test(source)) return "billing";
  if (DAILY.test(source)) return "daily";
  if (metric !== null) return "per-minute";
  return null;
}

function quotaMetricText(details: readonly GeminiErrorDetail[] | undefined): string | null {
  if (!details) return null;
  const parts: string[] = [];
  let sawQuotaFailure = false;
  for (const detail of details) {
    const type = detail["@type"];
    if (typeof type !== "string" || !type.includes("QuotaFailure")) continue;
    sawQuotaFailure = true;
    if (!Array.isArray(detail.violations)) continue;
    for (const violation of detail.violations) {
      if (!violation || typeof violation !== "object") continue;
      const row = violation as { quotaMetric?: unknown; quotaId?: unknown };
      if (typeof row.quotaMetric === "string") parts.push(row.quotaMetric);
      if (typeof row.quotaId === "string") parts.push(row.quotaId);
    }
  }
  return sawQuotaFailure ? parts.join(" ") : null;
}

/** Gemini calls. The model and key are per run; omitted values are the deployment model and its authorization key (D033 §3). */
export class GeminiProvider implements Provider {
  readonly mode = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private client: GoogleGenerativeAI;

  constructor(options?: GeminiProviderOptions) {
    const model = options?.model?.trim();
    this.model = model || env.GEMINI_MODEL;
    // A passed key is sent as given, even when blank. Only an omitted key uses the deployment key (D033 §3).
    this.apiKey = options?.apiKey === undefined ? env.GEMINI_API_KEY : options.apiKey.trim();
    this.client = new GoogleGenerativeAI(this.apiKey);
  }

  async completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>> {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;

    // Reviewed finding (2026-08-09): structural fix, not a prompt-wording one — constrains
    // token generation to the actual schema instead of just asking for it in prose. See
    // gemini-schema.ts's doc comment for the real production case this fixes.
    const responseSchema = request.responseSchema ? zodToGeminiSchema(request.responseSchema) : undefined;
    const model = this.client.getGenerativeModel(
      {
        model: this.model,
        generationConfig: {
          temperature: request.options?.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: request.options?.maxTokens,
          ...(responseSchema ? { responseMimeType: "application/json", responseSchema } : {}),
        },
      },
      { timeout: timeoutMs }
    );

    const contents = [
      {
        role: "user",
        parts: [{ text: `SYSTEM: ${request.system}\n\nUSER: ${request.user}` }],
      },
    ];

    try {
      const t0 = Date.now();
      const result = await model.generateContent({ contents });
      logger.info(
        { module: MODULE, operation: "completeJson", latencyMs: Date.now() - t0, model: this.model },
        "Gemini API call completed"
      );
      const response = await result.response;
      const text = response.text();

      // Capture token usage from Gemini response
      const usageMetadata = response.usageMetadata;
      const usage: TokenUsage | undefined = usageMetadata ? {
        inputTokens: usageMetadata.promptTokenCount,
        // thoughtsTokenCount bills at the OUTPUT rate and is excluded from candidatesTokenCount on
        // 2.5 models — omitting it makes every row under-count against the invoice.
        outputTokens: (usageMetadata.candidatesTokenCount ?? 0) + ((usageMetadata as { thoughtsTokenCount?: number }).thoughtsTokenCount ?? 0),
        totalTokens: usageMetadata.totalTokenCount,
      } : undefined;

      try {
        return { result: JSON.parse(text) as T, usage };
      } catch (parseError) {
        // Try extracting JSON from markdown code blocks before giving up
        const extracted = extractJson(text);
        try {
          return { result: JSON.parse(extracted) as T, usage };
        } catch (secondError) {
          logger.error(
            { module: MODULE, operation: "completeJson", text, parseError, secondError },
            "Failed to parse Gemini JSON output"
          );
          throw new Error("Malformed JSON from AI provider");
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Malformed JSON from AI provider") throw error;

      const failure = readFailure(error);
      const message = scrubErrorMessage(failure.message, [this.apiKey]) ?? "";
      const status = failure.status ?? statusFromMessage(message);
      const category = status === undefined ? null : classifyGeminiError(status, message, failure.details);

      if (category === "rate_limited") {
        const kind = limitKind(message, failure.details);
        const limitType = kind === "daily" ? "daily" : "per-minute";
        const resetsAt = extractResetTime(message);
        // providerMessage names which limit and the reset; the thrown error stays the short sentence (2026-08-28).
        const providerMessage = message.slice(0, 500);
        logger.warn(
          { module: MODULE, operation: "completeJson", status, limitType, resetsAt, providerMessage },
          "Gemini rate limit hit — not retrying"
        );
        throw new RateLimitError(
          limitType === "daily"
            ? "Daily API quota exhausted. Please try again tomorrow."
            : "Too many requests. Please try again later.",
          limitType,
          resetsAt
        );
      }
      if (category) {
        logger.warn({ module: MODULE, operation: "completeJson", status, category }, "Gemini call classified");
        throw new ProviderError(category, CATEGORY_MESSAGE[category]);
      }
      // The SDK timeout abort says "This operation was aborted" and does not contain "timeout" (D018 §5.10).
      if (/timeout|timed out|deadline exceeded|aborted|abort/i.test(message)) {
        logger.warn({ module: MODULE, operation: "completeJson" }, "Gemini API call timed out");
        throw new TimeoutError("provider call timed out");
      }
      if (status === undefined && /fetch|network|econn|enotfound|socket/i.test(message)) {
        logger.warn({ module: MODULE, operation: "completeJson", category: "unavailable" }, "Gemini call classified");
        throw new ProviderError("unavailable", CATEGORY_MESSAGE.unavailable);
      }
      logger.error({ module: MODULE, operation: "completeJson", status }, "Gemini API call failed");
      throw new Error("The provider rejected the request.");
    }
  }
}

function readFailure(error: unknown): { status?: number; message: string; details?: GeminiErrorDetail[] } {
  if (typeof error === "object" && error !== null) {
    const err = error as { status?: unknown; message?: unknown; errorDetails?: unknown };
    return {
      status: typeof err.status === "number" ? err.status : undefined,
      message: typeof err.message === "string" ? err.message : String(error),
      details: Array.isArray(err.errorDetails) ? (err.errorDetails as GeminiErrorDetail[]) : undefined,
    };
  }
  return { message: String(error) };
}

function statusFromMessage(message: string): number | undefined {
  const bracket = message.match(/\[(\d{3})\s/);
  if (bracket?.[1]) return Number(bracket[1]);
  if (message.includes("429") || message.toLowerCase().includes("rate limit")) return 429;
  return undefined;
}

/** Gemini sometimes includes "reset in X seconds". */
function extractResetTime(message: string): string | undefined {
  const match = message.match(/reset\s+in\s+(\d+)\s+seconds/i);
  if (match && match[1]) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds)) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }
  return undefined;
}
