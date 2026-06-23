import { ZodObject } from "zod";
import type { ZodSchema } from "zod";
import { logger } from "../observability/logger";
import { extractJson } from "./json-from-llm";

const MODULE = "repair";

/**
 * Maps known snake_case field names from LLM output to camelCase expected by Zod schemas.
 * The prompt system.json tells the LLM to output camelCase, but if the LLM
 * falls back to snake_case, this normalizes before Zod validation.
 */
function normalizeFields(raw: Record<string, unknown>): void {
  if (raw.reasoning_trace !== undefined && raw.reasoningTrace === undefined) {
    raw.reasoningTrace = raw.reasoning_trace;
    delete raw.reasoning_trace;
  }
  if (raw.no_bias_detected !== undefined && raw.noBiasDetected === undefined) {
    raw.noBiasDetected = raw.no_bias_detected;
    delete raw.no_bias_detected;
  }
}

/**
 * Attempts a field-by-field safe parse of a ZodObject.
 * Fields that fail validation are set to null instead of crashing the whole result.
 * This prevents a single malformed field (e.g. reasoningTrace) from
 * causing loss of the entire assessment.
 */
function partialParseObject<T>(
  raw: unknown,
  schema: ZodSchema<T>,
): T {
  // Zod v4 public API: ZodObject has .shape
  if (!(schema instanceof ZodObject) || typeof raw !== "object" || raw === null) {
    return schema.parse(raw);
  }

  const shape = schema.shape as Record<string, ZodSchema>;
  const input = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const errors: Array<{ field: string; message: string }> = [];

  for (const [field, fieldSchema] of Object.entries(shape)) {
    const value = input[field];

    if (value === undefined) {
      result[field] = null;
      continue;
    }

    const fieldResult = fieldSchema.safeParse(value);
    if (fieldResult.success) {
      result[field] = fieldResult.data;
    } else {
      errors.push({
        field,
        message: fieldResult.error.message,
      });
      result[field] = null;
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
 * Attempts to repair malformed LLM JSON output.
 * Uses extractJson for structural extraction, then parses and validates.
 * Falls back to field-by-field partial parse to recover valid fields.
 */
export function tryRepairJson<T>(text: string, schema: ZodSchema<T>): T {
  const extracted = extractJson(text);
  const parsed = JSON.parse(extracted) as Record<string, unknown>;

  // Normalize known snake_case → camelCase fields
  normalizeFields(parsed);

  // Step 1: Try full parse
  try {
    return schema.parse(parsed);
  } catch (error) {
    logger.warn(
      { module: MODULE, operation: "tryRepairJson", extracted, error },
      "Full JSON parse failed, trying partial field-level recovery",
    );
  }

  // Step 2: Partial field-by-field parse
  try {
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
 *
 * Returns both the parsed result and optional metadata from the fallback callback
 * (e.g., llmCallId for observability tracking).
 */
export async function repairWithFallback<T, M = void>(
  text: string,
  schema: ZodSchema<T>,
  fallbackProvider: (() => Promise<{ result: T; metadata: M }>) | null
): Promise<{ result: T; metadata: M | null }> {
  // Step 1: Try repair (extractJson + parse + validate)
  try {
    const result = tryRepairJson(text, schema);
    return { result, metadata: null };
  } catch (repairError) {
    logger.warn(
      { module: MODULE, operation: "repairWithFallback", repairError },
      "Repair attempt failed, trying fallback model call"
    );
  }

  // Step 2: Fallback model call
  if (fallbackProvider) {
    try {
      const { result, metadata } = await fallbackProvider();
      // Validate fallback output through schema (provider returns unvalidated data)
      const validated = schema.parse(result);
      return { result: validated, metadata };
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