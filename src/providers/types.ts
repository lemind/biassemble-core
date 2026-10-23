import type { ZodSchema } from "zod";

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CompletionRequest {
  system: string;
  user: string;
  responseSchema?: ZodSchema;
  options?: CompletionOptions;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderResponse<T> {
  result: T;
  usage?: TokenUsage;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export type ProviderErrorCategory =
  | "invalid_key"
  | "no_balance"
  | "rate_limited"
  | "unavailable"
  | "model_access_denied";

/**
 * A classified provider failure. The message is a short category sentence.
 * It never carries the raw provider body (D033 §3).
 */
export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;

  constructor(category: ProviderErrorCategory, message: string) {
    super(message);
    this.name = "ProviderError";
    this.category = category;
  }
}

/** Stops the rest of the check. An outage (`unavailable`) does not: that claim is retried, then left unchecked. */
export function stoppingProviderFailure(err: unknown): RateLimitError | ProviderError | null {
  if (err instanceof RateLimitError) return err;
  if (
    err instanceof ProviderError &&
    (err.category === "invalid_key" ||
      err.category === "no_balance" ||
      err.category === "rate_limited" ||
      err.category === "model_access_denied")
  ) {
    return err;
  }
  return null;
}

/**
 * Thrown when a provider returns a rate-limit or quota-exhausted error.
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

export interface Provider {
  readonly mode: string;
  /** The model this client calls. Call rows record this, not a process-wide env default (D033). */
  readonly model: string;
  completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>>;
  /** Own-key probe. Absent on the test double. It must not receive the article (T2013). */
  preflight?(): Promise<void>;
}
