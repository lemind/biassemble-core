import { describe, it, expect } from "vitest";
import { computeSystemMetrics } from "../../../src/evaluation/compute-system-metrics";

describe("computeSystemMetrics", () => {
  it("all parsed — no repairs", () => {
    const result = computeSystemMetrics([
      { requiredRepair: false },
      { requiredRepair: false },
      { requiredRepair: false },
    ]);
    expect(result.schemaParseRate).toBe(1);
    expect(result.repairRate).toBe(0);
  });

  it("all repaired — no parses", () => {
    const result = computeSystemMetrics([
      { requiredRepair: true },
      { requiredRepair: true },
    ]);
    expect(result.schemaParseRate).toBe(0);
    expect(result.repairRate).toBe(1);
  });

  it("some repaired, some parsed", () => {
    const result = computeSystemMetrics([
      { requiredRepair: false },
      { requiredRepair: true },
      { requiredRepair: false },
      { requiredRepair: true },
    ]);
    expect(result.schemaParseRate).toBe(0.5);
    expect(result.repairRate).toBe(0.5);
  });

  it("single response — parsed", () => {
    const result = computeSystemMetrics([{ requiredRepair: false }]);
    expect(result.schemaParseRate).toBe(1);
    expect(result.repairRate).toBe(0);
  });

  it("single response — repaired", () => {
    const result = computeSystemMetrics([{ requiredRepair: true }]);
    expect(result.schemaParseRate).toBe(0);
    expect(result.repairRate).toBe(1);
  });

  it("empty array — both rates are null (no data)", () => {
    const result = computeSystemMetrics([]);
    expect(result.schemaParseRate).toBeNull();
    expect(result.repairRate).toBeNull();
  });

  it("mixed — 3 parsed, 1 repaired", () => {
    const result = computeSystemMetrics([
      { requiredRepair: false },
      { requiredRepair: false },
      { requiredRepair: false },
      { requiredRepair: true },
    ]);
    expect(result.schemaParseRate).toBe(0.75);
    expect(result.repairRate).toBe(0.25);
  });
});