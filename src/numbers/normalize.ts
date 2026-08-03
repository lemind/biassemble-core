/**
 * Deterministic unit/scale/currency/period normalization — D018 §2.3: "arithmetic
 * happens in code, never in the LLM." No LLM call anywhere in this module's path.
 * Shape matches evaluations/golden/audit/numbers-golden-set.json's claim/source
 * fixture objects exactly (research.md §4) so the golden set is the test suite,
 * with no fixture-format translation layer to maintain.
 */

export interface NumericFact {
  /** Accounting notation like "(1)" is a string; parsed to a negative number. */
  value: number | string;
  unit: string | null;
  scale?: string | null;
  period?: string | null;
  scope?: string | null;
  hedge?: string | null;
  fx_rate_to_usd?: number;
  notation?: "accounting_parens";
}

export type UnitFamily = "currency" | "percent" | "percentage_points" | "unknown";

export interface NormalizedFact {
  canonicalValue: number;
  unitFamily: UnitFamily;
  /** Only meaningful when unitFamily === "currency". */
  currency: string | null;
  period: string | null;
  scope: string | null;
  hedge: string | null;
  fxRateToUsd: number | null;
  /** True when the unit/scale could not be resolved (e.g. missing unit) — num-016. */
  unresolved: boolean;
}

const SCALE_MULTIPLIERS: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

/** "(1)" → -1 (accounting negative notation) — num-015. Never string-compared. */
function parseValue(raw: number | string): number {
  if (typeof raw === "number") return raw;
  const trimmed = raw.trim();
  const parenMatch = trimmed.match(/^\((.+)\)$/);
  if (parenMatch) {
    const inner = Number(parenMatch[1]);
    if (Number.isNaN(inner)) {
      throw new Error(`Cannot parse accounting-notation value: ${raw}`);
    }
    return -inner;
  }
  const n = Number(trimmed);
  if (Number.isNaN(n)) {
    throw new Error(`Cannot parse numeric value: ${raw}`);
  }
  return n;
}

export function normalize(fact: NumericFact): NormalizedFact {
  const rawValue = parseValue(fact.value);
  const scale = fact.scale ?? null;

  let unitFamily: UnitFamily;
  let canonicalValue: number;
  let currency: string | null = null;
  let unresolved = false;

  if (fact.unit === null || fact.unit === undefined) {
    // Missing unit — do not guess the scale from digits matching (num-016).
    unitFamily = "unknown";
    canonicalValue = rawValue;
    unresolved = true;
  } else if (fact.unit === "percent") {
    unitFamily = "percent";
    canonicalValue = rawValue;
  } else if (fact.unit === "basis_points") {
    // 50bp = 0.5% by definition — exact conversion, not a trap (num-009).
    unitFamily = "percent";
    canonicalValue = rawValue / 100;
  } else if (fact.unit === "percentage_points") {
    // Deliberately its own family, never merged with "percent" — a pp value
    // is not convertible to a percent without a base value we don't have (num-008).
    unitFamily = "percentage_points";
    canonicalValue = rawValue;
  } else {
    // Currency-like unit (USD, EUR, ...).
    unitFamily = "currency";
    currency = fact.unit;
    const multiplier = scale ? SCALE_MULTIPLIERS[scale] : undefined;
    if (scale && multiplier === undefined) {
      throw new Error(`Unknown scale: ${scale}`);
    }
    canonicalValue = rawValue * (multiplier ?? 1);
  }

  return {
    canonicalValue,
    unitFamily,
    currency,
    period: fact.period ?? null,
    scope: fact.scope ?? null,
    hedge: fact.hedge ?? null,
    fxRateToUsd: fact.fx_rate_to_usd ?? null,
    unresolved,
  };
}
