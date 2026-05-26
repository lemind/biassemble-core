import type { ZodSchema } from "zod";
import { logger } from "../observability/logger.js";

const MODULE = "repair";

/**
 * Attempts to repair malformed LLM JSON output.
 * Returns the parsed and validated result, or throws if repair fails.
 */
export function tryRepairJson<T>(text: string, schema: ZodSchema<T>): T {
  let cleaned = text.trim();

  // 1. Strip markdown code blocks if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?\s*/, "").replace(/\s*```$/, "");
  }

  // 2. Try simple parse
  try {
    const parsed = JSON.parse(cleaned);
    return schema.parse(parsed);
  } catch (error) {
    logger.warn(
      { module: MODULE, operation: "tryRepairJson", text, error },
      "JSON repair failed basic parse/validate"
    );
    throw new Error("Failed to parse or validate LLM output");
  }
}

/**
 * Full repair pipeline: attempt repair, then fallback model call, then fail.
 * 
 * Pipeline:
 *   invalid JSON → repair attempt → revalidate with Zod → fallback model call → fail → 502
 */
export async function repairWithFallback<T>(
  text: string,
  schema: ZodSchema<T>,
  fallbackProvider: (() => Promise<T>) | null
): Promise<T> {
  // Step 1: Try repair
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
