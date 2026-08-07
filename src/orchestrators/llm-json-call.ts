import type { ZodSchema } from "zod";
import { logger } from "../observability/logger.js";
import { repairWithFallback } from "../parsers/repair.js";
import { isSuspectedInjection, InjectionSuspectedError } from "./audit/injection-guard.js";
import { RateLimitError } from "../providers/gemini.js";
import { TimeoutError } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import type { LlmCallStatus, LlmCallFailureType } from "../persistence/types.js";

/** Per-attempt call detail (D023 §4/T025) — one per actual provider call, including retries, matching core.llm_calls' own "One row per actual provider call (including retries and fallback calls)" convention. */
export interface LlmCallCompletionInfo {
  raw: unknown;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  status: LlmCallStatus;
  failureType: LlmCallFailureType | null;
  errorMessage: string | null;
}

export interface LlmJsonCallOptions<T> {
  provider: Provider;
  system: string;
  user: string;
  schema: ZodSchema<T>;
  expectedKeys: string[];
  attempts: number;
  module: string;
  operation: string;
  /** Extra post-repair check (e.g. a required array field must not be null) — throws to trigger a retry. */
  isValid?: (result: T) => boolean;
  /**
   * Optional, additive (D023 §4/T025) — invoked once per attempt with call detail
   * (raw response, timing, tokens, status). Callers that don't pass this see no behavior
   * change at all; existing callers (audit/extract.service.ts) are unaffected.
   */
  onComplete?: (info: LlmCallCompletionInfo) => void;
}

/**
 * Retry + injection-guard + repair skeleton, factored out of the audit and Grounnel EXTRACT
 * orchestrators' near-identical control flow. Does NOT include cost/observability recording by
 * default (executeAndRecordLlmCall/LlmCallStore) — that's Postgres-backed and callers that need
 * it either keep their own wrapping around this (audit/verify.service.ts, predates this file) or
 * pass `onComplete` (Grounnel, D023 §4 — chosen over duplicating this control flow a second time).
 */
export async function callLlmForJson<T>(options: LlmJsonCallOptions<T>): Promise<T> {
  const { provider, system, user, schema, expectedKeys, attempts, module, operation, isValid, onComplete } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = new Date();
    const t0 = Date.now();
    let raw: unknown;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalTokens: number | null = null;
    try {
      const response = await provider.completeJson<unknown>({ system, user, options: { temperature: 0 } });
      raw = response.result;
      inputTokens = response.usage?.inputTokens ?? null;
      outputTokens = response.usage?.outputTokens ?? null;
      totalTokens = response.usage?.totalTokens ?? null;
    } catch (err) {
      if (err instanceof RateLimitError) throw err; // fails again immediately — retrying wastes attempts
      lastError = err as Error;
      logger.warn({ module, operation, attempt, err }, "provider call failed — retrying");
      onComplete?.({
        raw: null,
        startedAt,
        endedAt: new Date(),
        durationMs: Date.now() - t0,
        inputTokens,
        outputTokens,
        totalTokens,
        status: err instanceof TimeoutError ? "timeout" : "error",
        failureType: err instanceof TimeoutError ? "timeout" : "provider_error",
        errorMessage: lastError.message,
      });
      continue;
    }

    if (isSuspectedInjection(JSON.stringify(raw), expectedKeys)) {
      logger.error({ module, operation, raw }, "response flagged as injection-suspected — hard stop, not repaired");
      onComplete?.({
        raw,
        startedAt,
        endedAt: new Date(),
        durationMs: Date.now() - t0,
        inputTokens,
        outputTokens,
        totalTokens,
        status: "error",
        failureType: "other",
        errorMessage: "injection-suspected",
      });
      throw new InjectionSuspectedError(operation);
    }

    try {
      const { result } = await repairWithFallback(JSON.stringify(raw), schema, null, { salvageArrays: true });
      if (isValid && !isValid(result)) {
        throw new Error(`${operation} response failed schema validation (see repair warnings)`);
      }
      onComplete?.({
        raw,
        startedAt,
        endedAt: new Date(),
        durationMs: Date.now() - t0,
        inputTokens,
        outputTokens,
        totalTokens,
        status: "success",
        failureType: null,
        errorMessage: null,
      });
      return result;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ module, operation, attempt, err }, "response unparseable — retrying");
      onComplete?.({
        raw,
        startedAt,
        endedAt: new Date(),
        durationMs: Date.now() - t0,
        inputTokens,
        outputTokens,
        totalTokens,
        status: "error",
        failureType: "parse_error",
        errorMessage: lastError.message,
      });
    }
  }
  throw lastError ?? new Error(`${operation} failed after retries with no captured error`);
}
