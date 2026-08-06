import type { ZodSchema } from "zod";
import { logger } from "../observability/logger.js";
import { repairWithFallback } from "../parsers/repair.js";
import { isSuspectedInjection, InjectionSuspectedError } from "./audit/injection-guard.js";
import { RateLimitError } from "../providers/gemini.js";
import type { Provider } from "../providers/types.js";

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
}

/**
 * Retry + injection-guard + repair skeleton, factored out of the audit and Grounnel EXTRACT
 * orchestrators' near-identical control flow. Does NOT include cost/observability recording
 * (executeAndRecordLlmCall/LlmCallStore) — that's Postgres-backed and callers that need it
 * (audit/extract.service.ts) keep their own wrapping around this.
 */
export async function callLlmForJson<T>(options: LlmJsonCallOptions<T>): Promise<T> {
  const { provider, system, user, schema, expectedKeys, attempts, module, operation, isValid } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw: unknown;
    try {
      ({ result: raw } = await provider.completeJson<unknown>({ system, user, options: { temperature: 0 } }));
    } catch (err) {
      if (err instanceof RateLimitError) throw err; // fails again immediately — retrying wastes attempts
      lastError = err as Error;
      logger.warn({ module, operation, attempt, err }, "provider call failed — retrying");
      continue;
    }

    if (isSuspectedInjection(JSON.stringify(raw), expectedKeys)) {
      logger.error({ module, operation, raw }, "response flagged as injection-suspected — hard stop, not repaired");
      throw new InjectionSuspectedError(operation);
    }

    try {
      const { result } = await repairWithFallback(JSON.stringify(raw), schema, null, { salvageArrays: true });
      if (isValid && !isValid(result)) {
        throw new Error(`${operation} response failed schema validation (see repair warnings)`);
      }
      return result;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ module, operation, attempt, err }, "response unparseable — retrying");
    }
  }
  throw lastError ?? new Error(`${operation} failed after retries with no captured error`);
}
