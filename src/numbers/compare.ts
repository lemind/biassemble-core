/**
 * Comparability + equality decision — D018 §2.3. VERIFY compares only
 * already-canonical numbers produced here; it never computes anything itself.
 *
 * Pass bar (evaluations/golden/audit/README.md): zero false
 * "not comparable = contradicted" — whenever comparable=false, a data gap
 * (currency/period/unit mismatch) must never be treated downstream as
 * evidence the claim is wrong.
 */

import { normalize, type NumericFact, type NormalizedFact } from "./normalize.js";

export interface ComparisonResult {
  comparable: boolean;
  equal: boolean | null;
  note: string;
}

/**
 * Absolute tolerance for a hedged claim ("about 10%" vs 10.4%). Not derived
 * from any measurement — this golden set doesn't contain a case that needs a
 * tighter or looser bound, so 1.0 (percentage/unit point) is a defensible
 * round default, not a precisely calibrated constant. Revisit if a real case
 * needs a different value, the same way D018 §4.1's 0.5 partial-credit
 * weight is an explicit, documented convention rather than an empirical fit.
 */
const HEDGE_TOLERANCE_ABSOLUTE = 1.0;

/**
 * Relative tolerance for unhedged comparisons — covers legitimate floating-point
 * rounding from scale/currency conversion (e.g. num-005's FX conversion lands at
 * 59999.5 vs a claimed 60000), not genuine mismatches. 0.1% is comfortably below
 * every real mismatch this golden set tests (all of which differ by whole
 * percentage points or more) and comfortably above float rounding noise.
 */
const RELATIVE_TOLERANCE = 0.001;

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

/** Converts `fact` into `targetCurrency`, or null if there's no way to. */
function convertToCurrency(fact: NormalizedFact, targetCurrency: string): number | null {
  if (fact.currency === targetCurrency) return fact.canonicalValue;
  if (fact.fxRateToUsd != null && targetCurrency === "USD") {
    return fact.canonicalValue * fact.fxRateToUsd;
  }
  return null;
}

export function compare(claim: NumericFact, source: NumericFact): ComparisonResult {
  const a = normalize(claim);
  const b = normalize(source);

  if (a.unresolved || b.unresolved) {
    return {
      comparable: false,
      equal: null,
      note: "missing or ambiguous unit — cannot compare without disambiguation, not a guess",
    };
  }

  if (a.unitFamily !== b.unitFamily) {
    return {
      comparable: false,
      equal: null,
      note: `unit families differ ("${a.unitFamily}" vs "${b.unitFamily}") — not directly comparable`,
    };
  }

  if (a.period && b.period && normalizeLabel(a.period) !== normalizeLabel(b.period)) {
    return {
      comparable: false,
      equal: null,
      note: `periods differ ("${a.period}" vs "${b.period}") — not comparable without task-context resolution`,
    };
  }

  if (a.scope && b.scope && normalizeLabel(a.scope) !== normalizeLabel(b.scope)) {
    return {
      comparable: false,
      equal: null,
      note: `scopes differ ("${a.scope}" vs "${b.scope}") — not directly comparable`,
    };
  }

  let claimValue = a.canonicalValue;
  let sourceValue = b.canonicalValue;

  if (a.unitFamily === "currency" && a.currency !== b.currency) {
    const sourceInClaimCurrency = convertToCurrency(b, a.currency!);
    const claimInSourceCurrency = convertToCurrency(a, b.currency!);
    if (sourceInClaimCurrency == null && claimInSourceCurrency == null) {
      return {
        comparable: false,
        equal: null,
        note: `different currency ("${a.currency}" vs "${b.currency}"), no FX rate provided — cannot compare`,
      };
    }
    if (sourceInClaimCurrency != null) {
      sourceValue = sourceInClaimCurrency;
    } else {
      claimValue = claimInSourceCurrency!;
    }
  }

  const hedged = Boolean(a.hedge || b.hedge);
  const tolerance = hedged
    ? HEDGE_TOLERANCE_ABSOLUTE
    : Math.max(Math.abs(sourceValue) * RELATIVE_TOLERANCE, 1e-9);
  const equal = Math.abs(claimValue - sourceValue) <= tolerance;

  return {
    comparable: true,
    equal,
    note: equal ? "within tolerance" : "differs beyond tolerance",
  };
}
