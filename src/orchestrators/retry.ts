import { logger } from "../observability/logger.js";
import { env } from "../lib/env.js";

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Retries an async function with exponential backoff.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? env.AI_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      
      if (attempt > maxRetries) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 200;
      
      logger.warn(
        { attempt, delay: delay + jitter, error },
        "Operation failed, retrying..."
      );

      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  logger.error({ lastError, attempts: maxRetries + 1 }, "Operation failed after all retries");
  throw lastError;
}
