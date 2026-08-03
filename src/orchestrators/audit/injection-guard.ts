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

export function isSuspectedInjection(rawText: string, expectedKeys: string[]): boolean {
  return containsInjectionMarker(rawText) || hasUnrelatedKeySet(rawText, expectedKeys);
}

export class InjectionSuspectedError extends Error {
  constructor(stage: string) {
    super(`Injection-suspected response rejected at ${stage} — not routed to repair`);
    this.name = "InjectionSuspectedError";
  }
}
