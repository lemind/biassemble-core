import { ZodObject, ZodArray } from "zod";
import type { ZodSchema } from "zod";
import { logger } from "../observability/logger";
import { extractJson } from "./json-from-llm";

const MODULE = "repair";

// A real live-eval failure (Grounnel VERIFY, 2026-08-06): asked for `{results: [...]}`, Gemini
// returned the bare array directly, 3/3 retries. Zod correctly rejects it, but partialParseObject
// then reads the array as a keyless object and nulls the field — recoverable, not actually malformed.
function unwrapBareArrayResponse(parsed: unknown, schema: ZodSchema): unknown {
  if (!Array.isArray(parsed) || !(schema instanceof ZodObject)) return parsed;
  const shape = schema.shape as Record<string, ZodSchema>;
  const keys = Object.keys(shape);
  if (keys.length !== 1 || !(shape[keys[0]!] instanceof ZodArray)) return parsed;
  logger.warn({ module: MODULE, operation: "unwrapBareArrayResponse", field: keys[0] }, "Response was a bare array — wrapping into the expected single-array-field object");
  return { [keys[0]!]: parsed };
}

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

export interface RepairOptions {
  /** Opt-in only — some callers depend on the old null-then-retry behavior for correctness. D018 §5.15. */
  salvageArrays?: boolean;
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
  options: RepairOptions = {},
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
      continue;
    }

    // Array-typed field: drop only the bad indices instead of nulling the whole field. D018 §5.15 (T044).
    if (options.salvageArrays && Array.isArray(value)) {
      const badIndices = new Set(
        fieldResult.error.issues.map((issue) => issue.path[0]).filter((i): i is number => typeof i === "number")
      );
      if (badIndices.size > 0 && badIndices.size < value.length) {
        const filtered = value.filter((_, i) => !badIndices.has(i));
        const retried = fieldSchema.safeParse(filtered);
        if (retried.success) {
          errors.push({
            field,
            message: `salvaged ${filtered.length}/${value.length} element(s); dropped index(es) ${[...badIndices].join(",")}`,
          });
          result[field] = retried.data;
          continue;
        }
      }
    }

    errors.push({
      field,
      message: fieldResult.error.message,
    });
    result[field] = null;
  }

  if (errors.length > 0) {
    logger.warn(
      { module: MODULE, operation: "partialParseObject", errors },
      `Partial parse: ${errors.length} field(s) failed validation — set to null`,
    );
  }

  return result as T;
}

/**
 * Attempts to repair malformed LLM JSON output.
 * Uses extractJson for structural extraction, then parses and validates.
 * Falls back to field-by-field partial parse to recover valid fields.
 */
export function tryRepairJson<T>(text: string, schema: ZodSchema<T>, options: RepairOptions = {}): T {
  const extracted = extractJson(text);
  const rawParsed: unknown = JSON.parse(extracted);
  const parsed = unwrapBareArrayResponse(rawParsed, schema) as Record<string, unknown>;

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
    return partialParseObject(parsed, schema, options);
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
  fallbackProvider: (() => Promise<{ result: T; metadata: M }>) | null,
  options: RepairOptions = {}
): Promise<{ result: T; metadata: M | null }> {
  // Step 1: Try repair (extractJson + parse + validate)
  try {
    const result = tryRepairJson(text, schema, options);
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