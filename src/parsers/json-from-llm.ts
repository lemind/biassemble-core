import { logger } from "../observability/logger.js";

const MODULE = "json-from-llm";

/**
 * Attempts to extract a valid JSON object from an LLM response string.
 * Handles: markdown code blocks, leading/trailing text, partial extraction.
 * Truncates trailing text after the JSON structure closes.
 */
export function extractJson(text: string): string {
  let cleaned = text.trim();

  // 1. Strip markdown code blocks if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "");
    cleaned = cleaned.replace(/\n?\s*```$/i, "");
    cleaned = cleaned.trim();
  }

  // 2. Find the first { or [ and last matching } or ]
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");

  let start = -1;
  let useObject = true;
  if (firstBrace >= 0 && firstBracket >= 0) {
    if (firstBrace <= firstBracket) {
      start = firstBrace;
      useObject = true;
    } else {
      start = firstBracket;
      useObject = false;
    }
  } else if (firstBrace >= 0) {
    start = firstBrace;
    useObject = true;
  } else if (firstBracket >= 0) {
    start = firstBracket;
    useObject = false;
  }

  // No JSON structure found
  if (start < 0) {
    logger.warn({ module: MODULE }, "No JSON structure found in LLM response");
    return cleaned;
  }

  // Extract from the first structural character
  const extracted = cleaned.slice(start);

  // Find the closing brace/bracket
  const openChar = useObject ? "{" : "[";
  const closeChar = useObject ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let closeIndex = -1;

  for (let i = 0; i < extracted.length; i++) {
    const char = extracted[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (inString) {
      if (char === "\\") {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }

  if (closeIndex >= 0) {
    const result = extracted.slice(0, closeIndex + 1);
    logger.info(
      { module: MODULE, originalLength: text.length, extractedLength: result.length },
      "Extracted JSON substring from LLM response"
    );
    return result;
  }

  // Could not find matching close — return extracted portion
  logger.warn(
    { module: MODULE, originalLength: text.length },
    "Could not find matching close bracket in LLM response"
  );
  return extracted;
}
