/** Injection-suspected detection (research.md §7, FR-021). A match = hard reject, never routed through the D004 repair pipeline. */

const INSTRUCTION_MARKERS: RegExp[] = [
  /\bignore\s+(all\s+|the\s+)?(previous|prior|above)\s+instructions?\b/i,
  /<\s*system\s*>/i,
  /\byou\s+are\s+now\b/i,
  /^\s*###/m,
  /^\s*(user|assistant|system)\s*:/im,
];

/** Heuristic 1+2: instruction/role-marker pattern a well-intentioned malformed response wouldn't have. */
export function containsInjectionMarker(rawText: string): boolean {
  return INSTRUCTION_MARKERS.some((pattern) => pattern.test(rawText));
}

/**
 * Blanks named fields (any nesting depth) before the marker scan. A field like VERIFY's `evidence`
 * is a verbatim copy of arbitrary web/passage text by design — judging it against "a well-intentioned
 * response wouldn't say this" is the wrong test for text the model was told to quote exactly, not
 * write itself. Real production case: a scraped page's "You are now subscribed" newsletter boilerplate,
 * quoted verbatim as evidence, false-positived the whole batch. Falls back to the raw text unchanged
 * if it isn't valid JSON — an already-malformed response gets no special treatment either way.
 */
function blankFields(rawText: string, fieldNames: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return rawText;
  }
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fieldNames.includes(k) ? null : strip(v)]));
    }
    return value;
  };
  return JSON.stringify(strip(parsed));
}

/** Heuristic 3: valid JSON but its key set shares essentially nothing with what was asked for (unlike ordinary malformation). */
export function hasUnrelatedKeySet(rawText: string, expectedKeys: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return false; // not valid JSON — ordinary malformation, not this heuristic's job
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const actualKeys = Object.keys(parsed as Record<string, unknown>);
  if (actualKeys.length === 0) return false;
  const overlap = actualKeys.filter((k) => expectedKeys.includes(k)).length;
  return overlap === 0;
}

/** `quotedFields` — field names holding verbatim external quotes (e.g. VERIFY's `evidence`), excluded from the marker scan only; `hasUnrelatedKeySet` still checks the full raw structure. */
export function isSuspectedInjection(rawText: string, expectedKeys: string[], quotedFields: string[] = []): boolean {
  const scanText = quotedFields.length > 0 ? blankFields(rawText, quotedFields) : rawText;
  return containsInjectionMarker(scanText) || hasUnrelatedKeySet(rawText, expectedKeys);
}

export class InjectionSuspectedError extends Error {
  constructor(stage: string) {
    super(`Injection-suspected response rejected at ${stage} — not routed to repair`);
    this.name = "InjectionSuspectedError";
  }
}
