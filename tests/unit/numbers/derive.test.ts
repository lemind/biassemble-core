import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { derive } from "../../../src/numbers/derive.js";
import type { DerivedClaim } from "../../../src/numbers/derive.js";

interface GoldenCase {
  id: string;
  trap_type: string;
  claim: DerivedClaim;
  expected: { comparable: boolean; equal: boolean | null; note: string };
}

const goldenSet: { cases: GoldenCase[] } = JSON.parse(
  readFileSync(
    new URL("../../../evaluations/golden/audit/numbers-golden-set.json", import.meta.url),
    "utf-8"
  )
);

// T024 scope: the 6 derived-arithmetic cases compare.test.ts explicitly
// carves out (num-010/011/012/017/018/019) — growth-rate and sum/share
// computed here, in code, never left to the LLM (research.md §4).
const derivedCases = goldenSet.cases.filter((c) => "derived_op" in c.claim);

describe("derive() against numbers-golden-set.json derived-arithmetic cases", () => {
  // Case count is stated in evaluations/golden/audit/README.md — a standalone length check
  // never calls derive() and doesn't prove anything about the code (removed on review).
  for (const c of derivedCases) {
    it(`${c.id} — ${c.trap_type}`, () => {
      const result = derive(c.claim);
      expect(result.comparable).toBe(c.expected.comparable);
      expect(result.equal).toBe(c.expected.equal);
    });
  }

  it("division-by-zero input (e.g. pct_change from a zero base) is comparable:false, not a thrown exception or a guessed result", () => {
    const result = derive({ derived_op: "pct_change", inputs: [100, 0], claimed_result: 50, unit: "percent" });
    expect(result.comparable).toBe(false);
    expect(result.equal).toBeNull();
  });
});
