import { describe, it, expect } from "vitest";
import {
  computeSystemMetrics,
  type SystemMetrics,
  type LLMResponse,
} from "../../../src/evaluation/compute-system-metrics";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("computeSystemMetrics", () => {
  it("returns zero metrics for empty responses array", () => {
    const result = computeSystemMetrics([]);
    expect(result).toEqual<SystemMetrics>({
      totalResponses: 0,
      schemaParsePassCount: 0,
      schemaParseRate: 0,
      repairAttemptCount: 0,
      repairSuccessCount: 0,
      repairRate: null,
    });
  });

  it("computes schema parse rate from responses that did not require repair", () => {
    const responses: LLMResponse[] = [
      { requiredRepair: false },
      { requiredRepair: true },
      { requiredRepair: false },
      { requiredRepair: false },
    ];

    const result = computeSystemMetrics(responses);
    expect(result.totalResponses).toBe(4);
    expect(result.schemaParsePassCount).toBe(3);
    expect(result.schemaParseRate).toBe(0.75);
  });

  it("computes repair rate from responses that required repair", () => {
    const responses: LLMResponse[] = [
      { requiredRepair: true, repairSucceeded: true },
      { requiredRepair: true, repairSucceeded: false },
      { requiredRepair: true, repairSucceeded: true },
      { requiredRepair: false },
    ];

    const result = computeSystemMetrics(responses);
    expect(result.repairAttemptCount).toBe(3);
    expect(result.repairSuccessCount).toBe(2);
    expect(result.repairRate).toBeCloseTo(2 / 3);
  });

  it("returns null repair rate when no repairs were attempted", () => {
    const responses: LLMResponse[] = [
      { requiredRepair: false },
      { requiredRepair: false },
    ];

    const result = computeSystemMetrics(responses);
    expect(result.repairAttemptCount).toBe(0);
    expect(result.repairSuccessCount).toBe(0);
    expect(result.repairRate).toBeNull();
  });

  it("handles all-failed responses", () => {
    const responses: LLMResponse[] = [
      { requiredRepair: true, repairSucceeded: false },
      { requiredRepair: true, repairSucceeded: false },
    ];

    const result = computeSystemMetrics(responses);
    expect(result.schemaParseRate).toBe(0);
    expect(result.repairRate).toBe(0);
    expect(result.schemaParsePassCount).toBe(0);
  });

  it("handles all-pass responses", () => {
    const responses: LLMResponse[] = [
      { requiredRepair: false },
      { requiredRepair: false },
      { requiredRepair: false },
    ];

    const result = computeSystemMetrics(responses);
    expect(result.schemaParseRate).toBe(1);
    expect(result.repairRate).toBeNull();
    expect(result.repairAttemptCount).toBe(0);
  });

  it("handles single response", () => {
    const result = computeSystemMetrics([
      { requiredRepair: true, repairSucceeded: true },
    ]);
    expect(result.totalResponses).toBe(1);
    expect(result.schemaParseRate).toBe(0);
    expect(result.repairRate).toBe(1);
  });
});
