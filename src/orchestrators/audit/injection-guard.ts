/**
 * Injection-suspected detection — research.md §7 / FR-021 / D018 A8. A small,
 * concrete, first-pass heuristic set (research.md is explicit that this needs
 * a fixture set, mirroring evaluations/golden/audit/'s own discipline, before
 * it can be trusted — that fixture set is follow-up work, not built here).
 *
 * A match here means: reject outright, log the flagged content, surface as a
 * gated/failed claim. Never route through the D004 repair pipeline — repair's
 * job is fixing a well-intentioned but broken response, and a response that
 * trips these heuristics isn't well-intentioned by assumption.
 */

const INSTRUCTION_MARKERS: RegExp[] = [
  /\bignore\s+(all\s+|the\s+)?(previous|prior|above)\s+instructions?\b/i,
  /<\s*system\s*>/i,
  /\byou\s+are\s+now\b/i,
  /^\s*###/m,
  /^\s*(user|assistant|system)\s*:/im,
];

/**
 * Heuristic 1+2 (research.md §7): response text contains an instruction- or
 * role-marker pattern that a well-intentioned malformed response wouldn't.
 */
export function containsInjectionMarker(rawText: string): boolean {
  return INSTRUCTION_MARKERS.some((pattern) => pattern.test(rawText));
}

/**
 * Heuristic 3 (research.md §7): the text parses as valid JSON but its key
 * set has essentially nothing in common with what was asked for — a typo,
 * truncation, or missing-field pattern (ordinary malformation) still shares
 * most expected keys; an entirely different key set doesn't.
 */
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
