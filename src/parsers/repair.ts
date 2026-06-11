import { z } from "zod";
import type { ZodSchema } from "zod";
import { logger } from "../observability/logger";
import { extractJson } from "./json-from-llm";

const MODULE = "repair";

/**
 * Attempts a field-by-field safe parse of a Zod object.
 * Fields that fail validation are set to null.
 * This prevents a single malformed field (e.g. reasoningTrace) from
 * causing loss of the entire assessment.
 */
function partialParseObject<T>(
  raw: unknown,
  schema: ZodSchema<T>,
): T {
  // Get the shape definition (ZodObject internal)
  const def = (schema as any)._def;
  const shapeFn: (() => Record<string, z.ZodTypeAny>) | undefined = def?.shape;
  const shape = typeof shapeFn === "function" ? shapeFn() : null;

  if (!shape || typeof raw !== "object" || raw === null) {
    return schema.parse(raw);
  }

  const result: Record<string, unknown> = {};
  const input = raw as Record<string, unknown>;
  const errors: Array<{ field: string; message: string }> = [];

  for (const [field, fieldSchema] of Object.entries(shape)) {
    const value = input[field];

    if (value === undefined) {
      // Required field missing — partial cannot produce a valid result, fall through to full parse attempt
      try {
        return schema.parse(raw);
      } catch {
        result[field] = null;
        continue;
      }
    }

    const fieldResult = fieldSchema.safeParse(value);
    if (fieldResult.success) {
      result[field] = fieldResult.data;
    } else {
      errors.push({
        field,
        message: fieldResult.error.message,
      });
      // Required fields that fail: set to null as fallback
    }
  }

  if (errors.length > 0) {
    logger.warn(
      { module: MODULE, operation: "partialParseObject", errors },
      `Partial parse: ${errors.length} field(s) failed validation — set to null`,
    );
  }

  return result as unknown as T;
}

/**
 * Maps snake_case field names from LLM output to camelCase expected by Zod schemas.
 * Currently handles: reasoning_trace → reasoningTrace
 * The prompt schema.md uses reasoning_trace (snake_case) but Zod schema expects reasoningTrace (camelCase).
 */
function mapReasoningTrace(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || raw instanceof Array) return;
  const obj = raw as Record<string, unknown>;
  if (obj.reasoning_trace !== undefined && obj.reasoningTrace === undefined) {
    obj.reasoningTrace = obj.reasoning_trace;
    delete obj.reasoning_trace;
  }
}

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
    mapReasoningTrace(parsed);
    return schema.parse(parsed);
  } catch (error) {
    logger.warn(
      { module: MODULE, operation: "tryRepairJson", text, extracted, error },
      "Full JSON parse/validate failed, trying partial field-level recovery",
    );
  }

  // Step 3: Partial parse — try each field individually
  try {
    const parsed = JSON.parse(extracted);
    mapReasoningTrace(parsed);
    return partialParseObject(parsed, schema);
  } catch (partialError) {
    logger.warn(
      { module: MODULE, operation: "tryRepairJson", partialError },
      "Partial field-level recovery also failed",
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