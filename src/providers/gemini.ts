import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env";
import { logger } from "../observability/logger";
import { extractJson } from "../parsers/json-from-llm";
import type { Provider, CompletionRequest } from "./types";

/** Default temperature for AI provider calls */
const DEFAULT_TEMPERATURE = 0.7;

const MODULE = "gemini-provider";

/**
 * Thrown when Gemini returns a 429 rate-limit or quota-exhausted error.
 * These should NOT be retried — they will fail again immediately.
 */
export class RateLimitError extends Error {
  /** "daily" (quota) or "per-minute" (RPM) */
  readonly limitType: "daily" | "per-minute";
  /** ISO timestamp when the limit resets, if available */
  readonly resetsAt?: string;

  constructor(message: string, limitType: "daily" | "per-minute", resetsAt?: string) {
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

  async completeJson<T>(request: CompletionRequest): Promise<T> {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;

    const model = this.client.getGenerativeModel(
      {
        model: env.GEMINI_MODEL,
        generationConfig: {
          temperature: request.options?.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: request.options?.maxTokens,
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

      try {
        return JSON.parse(text) as T;
      } catch (parseError) {
        // Try extracting JSON from markdown code blocks before giving up
        const extracted = extractJson(text);
        try {
          return JSON.parse(extracted) as T;
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
        const isDaily = message.toLowerCase().includes("quota") || message.toLowerCase().includes("daily");
        const resetsAt = extractResetTime(message);
        logger.warn(
          { module: MODULE, operation: "completeJson", status, limitType: isDaily ? "daily" : "per-minute", resetsAt },
          "Gemini rate limit hit — not retrying"
        );
        throw new RateLimitError(
          isDaily
            ? "Daily API quota exhausted. Please try again tomorrow."
            : "Too many requests. Please try again later.",
          isDaily ? "daily" : "per-minute",
          resetsAt
        );
      }

      logger.error(
        { module: MODULE, operation: "completeJson", error },
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
