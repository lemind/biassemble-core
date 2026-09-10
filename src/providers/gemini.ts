import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env";
import { logger } from "../observability/logger";
import { extractJson } from "../parsers/json-from-llm";
import { zodToGeminiSchema } from "./gemini-schema";
import type { Provider, CompletionRequest, ProviderResponse, TokenUsage } from "./types";
import { TimeoutError } from "./types";

/** Default temperature for AI provider calls */
const DEFAULT_TEMPERATURE = 0.7;

const MODULE = "gemini-provider";

/**
 * Thrown when Gemini returns a 429 rate-limit or quota-exhausted error.
 * These should NOT be retried — they will fail again immediately.
 */
export class RateLimitError extends Error {
  /** "billing" (credits depleted — never self-clears), "daily" (quota) or "per-minute" (RPM) */
  readonly limitType: "billing" | "daily" | "per-minute";
  /** ISO timestamp when the limit resets, if available */
  readonly resetsAt?: string;

  constructor(message: string, limitType: "billing" | "daily" | "per-minute", resetsAt?: string) {
    super(message);
    this.name = "RateLimitError";
    this.limitType = limitType;
    this.resetsAt = resetsAt;
  }
}

/** Calls Gemini API via Google Generative AI SDK; handles rate limits, markdown-wrapped JSON, and timeout. */
export class GeminiProvider implements Provider {
  readonly mode = "gemini";
  private client: GoogleGenerativeAI;

  constructor() {
    this.client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }

  async completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>> {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;

    // Reviewed finding (2026-08-09): structural fix, not a prompt-wording one — constrains
    // token generation to the actual schema instead of just asking for it in prose. See
    // gemini-schema.ts's doc comment for the real production case this fixes.
    const responseSchema = request.responseSchema ? zodToGeminiSchema(request.responseSchema) : undefined;
    const model = this.client.getGenerativeModel(
      {
        model: env.GEMINI_MODEL,
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
        { module: MODULE, operation: "completeJson", latencyMs: Date.now() - t0, model: env.GEMINI_MODEL },
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
      // Detect rate-limit / quota errors — these should NOT be retried
      const err = error as Record<string, unknown>;
      const status = err?.status as number | undefined;
      const message = (err?.message as string | undefined) ?? String(error);

      if (status === 429 || message.includes("429") || message.toLowerCase().includes("rate limit")) {
        const lower = message.toLowerCase();
        // Google returns 429 for a depleted prepaid balance too. It is NOT a rate limit: waiting never
        // clears it, so it must not produce a "try again shortly" message (2026-08-28 incident).
        const isBilling = /credits are depleted|spend(ing)? cap/.test(lower);
        const isDaily = !isBilling && (lower.includes("quota") || lower.includes("daily"));
        const resetsAt = extractResetTime(message);
        // providerMessage is the only place Google states WHICH limit and when it resets; without it
        // a 429 is unattributable and the reset window can only be guessed at (2026-08-28 incident).
        const providerMessage = message.replace(/key=[^&\s"]+/gi, "key=[REDACTED]").slice(0, 500);
        logger.warn(
          { module: MODULE, operation: "completeJson", status, limitType: isBilling ? "billing" : isDaily ? "daily" : "per-minute", resetsAt, providerMessage },
          "Gemini rate limit hit — not retrying"
        );
        const limitType = isBilling ? "billing" : isDaily ? "daily" : "per-minute";
        throw new RateLimitError(
          (isBilling
            ? "AI provider credits are depleted — this needs an account top-up, not a retry."
            : isDaily
              ? "Daily API quota exhausted. Please try again tomorrow."
              : "Too many requests. Please try again later.") + ` [provider: ${providerMessage}]`,
          limitType,
          resetsAt
        );
      }

      // Detect timeout errors. The SDK's own timeout abort ("This operation was aborted") does not
      // contain "timeout" at all — live audits (46 claims) hit exactly this message and, misclassified
      // as a generic error, were neither retried at the call site nor logged as a timeout. D018 §5.10.
      if (
        message.toLowerCase().includes("timeout") ||
        message.toLowerCase().includes("timed out") ||
        message.toLowerCase().includes("deadline exceeded") ||
        message.toLowerCase().includes("aborted")
      ) {
        logger.warn(
          { module: MODULE, operation: "completeJson", message },
          "Gemini API call timed out"
        );
        throw new TimeoutError(message);
      }

      const errorMessage = (error as Error).message ?? String(error);
      const errorStack = (error as Error).stack;
      logger.error(
        { module: MODULE, operation: "completeJson", errorMessage, errorStack, error },
        "Gemini API call failed"
      );
      throw error;
    }
  }
}

/**
 * Try to extract a reset timestamp from a Gemini error message.
 * Gemini sometimes includes "reset in X seconds" or similar.
 */
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
