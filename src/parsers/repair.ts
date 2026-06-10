import type { ZodSchema } from "zod";
import { logger } from "../observability/logger";
import { extractJson } from "./json-from-llm";

const MODULE = "repair";

/**
 * Attempts to repair malformed LLM JSON output.
 * Uses extractJson for structural extraction, then parses and validates.
 * Returns the parsed and validated result, or throws if repair fails.
 */
export function tryRepairJson<T>(text: string, schema: ZodSchema<T>): T {
  // Step 1: Extract JSON structure (handles markdown, prose wrapping, trailing text)
  const extracted = extractJson(text);

  // Step 2: Try parse
  try {
    const parsed = JSON.parse(extracted);
    return schema.parse(parsed);
  } catch (error) {
    logger.warn(
      { module: MODULE, operation: "tryRepairJson", text, extracted, error },
      "JSON repair failed parse/validate after extraction"
    );
    throw new Error("Failed to parse or validate LLM output");
  }
}

/**
 * Full repair pipeline: attempt repair, then fallback model call, then fail.
 * 
 * Pipeline:
 *   invalid JSON → repair attempt (extractJson + parse + Zod validate)
 *   → if fails → fallback model call
 *   → if fallback fails → full failure → 502
 */
export async function repairWithFallback<T>(
  text: string,
  schema: ZodSchema<T>,
  fallbackProvider: (() => Promise<T>) | null
): Promise<T> {
  // Step 1: Try repair (extractJson + parse + validate)
  try {
    return tryRepairJson(text, schema);
  } catch (repairError) {
    logger.warn(
      { module: MODULE, operation: "repairWithFallback", repairError },
      "Repair attempt failed, trying fallback model call"
    );
  }

  // Step 2: Fallback model call
  if (fallbackProvider) {
    try {
      const result = await fallbackProvider();
      logger.info(
        { module: MODULE, operation: "repairWithFallback" },
        "Fallback model call succeeded"
      );
      return result;
    } catch (fallbackError) {
      logger.error(
        { module: MODULE, operation: "repairWithFallback", fallbackError },
        "Fallback model call also failed"
      );
    }
  }

  // Step 3: Fail with structured error
  throw new Error("Failed to produce valid output after repair and fallback");
}
