/**
 * Derived-value arithmetic — D018 §2.3 / research.md §4: growth-rate, sum,
 * and share-of-total computed here, in code, never left to VERIFY to
 * compute inside a prompt. Reuses compare.ts's tolerance constants rather
 * than duplicating them — a source filing's own rounded display ("22%" for
 * a precise 21.68% growth rate) must not be flagged as a mismatch, while a
 * genuine arithmetic error (claiming 25% from inputs that yield ~17%) must be.
 *
 * Not yet wired into extract.service.ts/verify.service.ts (T026's literal
 * scope is this module only): today, neither EXTRACT's nor VERIFY's schema
 * carries a derived_op/inputs/claimed_result shape for a claim — only
 * `derived: boolean` (does this claim require arithmetic checking at all).
 * Defining how a derived claim's operation and inputs get from the source
 * text into that shape is a real design question no governing document
 * (spec.md/data-model.md/research.md) answers yet, so it isn't guessed here.
 * This module is exercised directly against
 * evaluations/golden/audit/numbers-golden-set.json's derived-arithmetic
 * cases (proving the arithmetic itself is correct) and is ready to call once
 * that upstream shape exists — the same relationship compare.ts had to
 * verify.service.ts before T018 gave it a (deliberately narrow) integration.
 */

import { HEDGE_TOLERANCE_ABSOLUTE, RELATIVE_TOLERANCE } from "./compare.js";

export type DerivedOp = "pct_change" | "sum" | "share";

export interface DerivedClaim {
  derived_op: DerivedOp;
  inputs: number[];
  claimed_result: number;
  unit: string;
}

export interface DeriveResult {
  comparable: boolean;
  equal: boolean | null;
  computed: number | null;
  note: string;
}

// Filings always display growth-rate/share percentages pre-rounded to a
// whole number — the same rounding tolerance compare.ts uses for hedged
// claims applies here unconditionally, not just when the claim text hedges.
const PERCENT_FAMILY_UNITS = new Set(["percent", "percentage_points"]);

function computeDerivedValue(op: DerivedOp, inputs: number[]): number | null {
  switch (op) {
    case "pct_change": {
      if (inputs.length !== 2) return null;
      const [current, previous] = inputs as [number, number];
      if (previous === 0) return null; // divide-by-zero — not a guessable percentage
      return ((current - previous) / previous) * 100;
    }
    case "sum":
      return inputs.reduce((a, b) => a + b, 0);
    case "share": {
      if (inputs.length !== 2) return null;
      const [part, total] = inputs as [number, number];
      if (total === 0) return null;
      return (part / total) * 100;
    }
  }
}

export function derive(claim: DerivedClaim): DeriveResult {
  const computed = computeDerivedValue(claim.derived_op, claim.inputs);
  if (computed === null) {
    return {
      comparable: false,
      equal: null,
      computed: null,
      note: "derived computation divides by zero — cannot verify, not a guess",
    };
  }

  const tolerance = PERCENT_FAMILY_UNITS.has(claim.unit)
    ? HEDGE_TOLERANCE_ABSOLUTE
    : Math.max(Math.abs(computed) * RELATIVE_TOLERANCE, 1e-9);
  const equal = Math.abs(computed - claim.claimed_result) <= tolerance;

  return {
    comparable: true,
    equal,
    computed,
    note: equal
      ? `computed ${computed} matches claimed ${claim.claimed_result} within tolerance`
      : `computed ${computed} differs from claimed ${claim.claimed_result} beyond tolerance`,
  };
}
