import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compare } from "../../../src/numbers/compare.js";
import type { NumericFact } from "../../../src/numbers/normalize.js";

interface GoldenCase {
  id: string;
  trap_type: string;
  claim: NumericFact;
  source: NumericFact;
  expected: { comparable: boolean; equal: boolean | null; note: string };
}

const goldenSet: { cases: GoldenCase[] } = JSON.parse(
  readFileSync(
    new URL(
      "../../../evaluations/golden/audit/numbers-golden-set.json",
      import.meta.url
    ),
    "utf-8"
  )
);

// T009 scope: only the comparability cases (research.md §4 / D018 §2.3).
// Cases with a `derived_op` (num-010/011/012/017/018/019) exercise derive.ts,
// which is Phase 4 (US2) work — out of scope for Phase 2 Foundational.
const comparabilityCases = goldenSet.cases.filter(
  (c) => !("derived_op" in c.claim)
);

describe("compare() against numbers-golden-set.json comparability cases", () => {
  // Case count is stated in evaluations/golden/audit/README.md — a standalone length check
  // never calls compare() and doesn't prove anything about the code (removed on review).
  for (const c of comparabilityCases) {
    it(`${c.id} — ${c.trap_type}`, () => {
      const result = compare(c.claim, c.source);
      expect(result.comparable).toBe(c.expected.comparable);
      expect(result.equal).toBe(c.expected.equal);
    });
  }

  // Numbers-golden-set.json's own stated pass bar (README.md): zero false
  // "not comparable = contradicted". This is the aggregate invariant, not
  // just per-case matching — restated here as its own assertion so a future
  // change that passes every individual case but violates the invariant in
  // aggregate still fails loudly.
  it("never reports comparable=false alongside equal=true or equal=false (not-comparable implies equal is null)", () => {
    for (const c of comparabilityCases) {
      const result = compare(c.claim, c.source);
      if (!result.comparable) {
        expect(result.equal).toBeNull();
      }
    }
  });
});

describe("compare() direction field (2026-08-03, D018 §5.14 addendum) — lets a caller ask 'which is bigger' without re-normalizing", () => {
  it("is 0 whenever not comparable", () => {
    for (const c of comparabilityCases) {
      const result = compare(c.claim, c.source);
      if (!result.comparable) expect(result.direction).toBe(0);
    }
  });

  it("is 0 when equal, 1 when claim > source, -1 when claim < source", () => {
    expect(compare({ value: 100, unit: "USD" }, { value: 100, unit: "USD" }).direction).toBe(0);
    expect(compare({ value: 150, unit: "USD" }, { value: 100, unit: "USD" }).direction).toBe(1);
    expect(compare({ value: 50, unit: "USD" }, { value: 100, unit: "USD" }).direction).toBe(-1);
  });

  it("uses the currency-converted value, not the raw one, when an FX rate is involved", () => {
    // 100 EUR at fx_rate_to_usd 1.1 canonicalizes to 110 USD-equivalent — direction must reflect
    // that conversion, not a naive raw-value comparison (100 vs 100 would wrongly say equal).
    const result = compare(
      { value: 100, unit: "EUR", fx_rate_to_usd: 1.1 },
      { value: 100, unit: "USD" }
    );
    expect(result.comparable).toBe(true);
    expect(result.direction).toBe(1);
  });
});
