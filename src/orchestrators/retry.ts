import { logger } from "../observability/logger";
import { env } from "../lib/env";
import { RateLimitError } from "../providers/gemini";

/** Default base delay for retry exponential backoff (ms) */
const DEFAULT_RETRY_BASE_DELAY_MS = 2000;


interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

const MODULE = "retry";

/**
 * Shared wall-clock check for EXTRACT/VERIFY's deadline-scoped retry loops (D018 §5.13). Not folded into
 * `withRetry` itself — VERIFY's injection-suspected hard-stop must never retry at all, which conflicts
 * with `withRetry`'s "retry everything but rate limits" semantics, so those loops stay hand-rolled; this
 * just removes the duplicated raw `Date.now()` comparison across all three call sites.
 */
export function isPastDeadline(deadlineAt: number): boolean {
  return Date.now() >= deadlineAt;
}

/**
 * Retries an async function with exponential backoff.
 * 
 * Rate-limit errors (RateLimitError) are NOT retried — they will fail again immediately.
 * Only transient errors (timeouts, 503s, network blips) trigger backoff.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? env.AI_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      // Rate-limit errors should NOT be retried — they will fail again immediately
      if (error instanceof RateLimitError) {
        logger.warn(
          { module: MODULE, operation: "withRetry", error },
          "Rate limit hit — not retrying"
        );
        throw error;
      }

      lastError = error;
      
      if (attempt > maxRetries) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 200;
      
      logger.warn(
        { module: MODULE, operation: "withRetry", attempt, delay: delay + jitter, error },
        "Operation failed, retrying..."
      );

      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  logger.error(
    { module: MODULE, operation: "withRetry", lastError, attempts: maxRetries + 1 },
    "Operation failed after all retries"
  );
  throw lastError;
}
