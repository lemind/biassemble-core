import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  detectTableCandidate,
  validateTableParse,
  selectColumnForPeriod,
  type ParsedTable,
  type ParseRejection,
} from "../../../../src/orchestrators/audit/table-parse.js";

/**
 * Contract-level gate for column/period-aware comparison (D018 §5). These pin the persisted-parse
 * boundary BEFORE any comparator consumes it, so a failure here reads as "the parse contract is wrong"
 * rather than "some verdict came out wrong". Blocks are real filing text from source-filing.md with the
 * fixture's `Column order ...` annotation stripped — that annotation is not in the real 10-Q, and a
 * previous attempt keyed on it and shipped a guaranteed no-op.
 */
interface Scenario {
  id: string;
  why: string;
  block: string;
  parse?: ParsedTable;
  expect: "accept" | "reject" | "ineligible";
  reason?: ParseRejection;
  assert_distinct_duration?: boolean;
}

const goldenSet: { scenarios: Scenario[] } = JSON.parse(
  readFileSync(new URL("../../../../evaluations/golden/audit/table-parse-golden-set.json", import.meta.url), "utf-8")
);

describe("table-parse contract against table-parse-golden-set.json", () => {
  for (const scenario of goldenSet.scenarios) {
    it(`${scenario.id} — ${scenario.expect}`, () => {
      const detected = detectTableCandidate(scenario.block);

      if (scenario.expect === "ineligible") {
        // The whole point: no header, no column identity, no guessing. Falls back instead.
        expect(detected).toBeNull();
        return;
      }

      expect(detected, `${scenario.id} should be a table candidate`).not.toBeNull();
      const result = validateTableParse(scenario.parse!, scenario.block, detected!);

      if (scenario.expect === "accept") {
        expect(result, `${scenario.id} (${scenario.why}) rejected: ${JSON.stringify(result)}`).toEqual({ ok: true });
      } else {
        expect(result.ok).toBe(false);
        if (scenario.reason) expect(result.ok === false && result.reason).toBe(scenario.reason);
      }

      if (scenario.assert_distinct_duration) {
        // The same date is both a three-month and a six-month column — collapsing them would let a
        // quarterly claim be argued against a six-month figure.
        const cols = scenario.parse!.columns;
        const march2026 = cols.filter((c) => c.period === "March 28, 2026");
        expect(march2026).toHaveLength(2);
        expect(new Set(march2026.map((c) => c.duration)).size).toBe(2);
      }
    });
  }

  it("column count comes from the block, not from the transcriber", () => {
    const seg = goldenSet.scenarios.find((s) => s.id === "table-001-segment-valid")!;
    expect(detectTableCandidate(seg.block)!.columnCount).toBe(6);
  });
});

describe("selectColumnForPeriod — period matching stays in code (D018 §5)", () => {
  const columns = [
    { duration: "Three Months Ended", period: "March 28, 2026" },
    { duration: "Three Months Ended", period: "March 29, 2025" },
    { duration: "Six Months Ended", period: "March 28, 2026" },
    { duration: "Six Months Ended", period: "March 29, 2025" },
  ];

  it("a quarterly claim selects the three-month column, never the six-month one of the same year", () => {
    // Year alone is ambiguous here — both index 0 and index 2 are 2026.
    expect(selectColumnForPeriod(columns, "fiscal Q2 2026")).toBe(0);
  });

  it("resolves the prior-year quarterly column when the claim names it", () => {
    expect(selectColumnForPeriod(columns, "fiscal Q2 2025")).toBe(1);
  });

  it("declines when the claim carries no period", () => {
    expect(selectColumnForPeriod(columns, null)).toBeNull();
  });

  it("declines when the claim's year is not among the columns", () => {
    expect(selectColumnForPeriod(columns, "fiscal Q2 2024")).toBeNull();
  });

  it("declines rather than guess when the claim names no duration and the year is ambiguous", () => {
    expect(selectColumnForPeriod(columns, "FY2026")).toBeNull();
  });
});
