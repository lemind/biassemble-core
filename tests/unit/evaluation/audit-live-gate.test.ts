import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateAuditRun, type AuditRun, type LiveEvalSpec } from "../../../src/evaluation/audit-live-gate.js";

/**
 * Runs the live gate against REAL recorded `/audit` responses (2026-07-30, deployed f301845), not
 * synthetic ones. Fixtures are trimmed responses; specs classify each claim as true/false/silence.
 * Gate design and the incidents behind each rule: D018 §5.
 */
interface GateSpec extends LiveEvalSpec {
  runs: string[];
}

const gate: { specs: GateSpec[] } = JSON.parse(
  readFileSync(new URL("../../../evaluations/golden/audit/live-eval-gate.json", import.meta.url), "utf-8")
);

function loadRun(name: string): AuditRun {
  return JSON.parse(readFileSync(new URL(`../../../evaluations/golden/audit/live-eval-fixtures/${name}`, import.meta.url), "utf-8"));
}

describe("audit live eval gate — recorded real runs", () => {
  for (const spec of gate.specs) {
    it(`${spec.id} — zero false accusations`, () => {
      const result = evaluateAuditRun(spec.runs.map(loadRun), spec);
      const accusations = result.violations.filter((v) => v.rule === "no_false_accusation");
      expect(accusations, JSON.stringify(accusations, null, 2)).toHaveLength(0);
    });

    it(`${spec.id} — every contradicted verdict carries evidence and source_refs`, () => {
      const result = evaluateAuditRun(spec.runs.map(loadRun), spec);
      const uncited = result.violations.filter((v) => v.rule === "contradicted_without_evidence");
      expect(uncited, JSON.stringify(uncited, null, 2)).toHaveLength(0);
    });

    it(`${spec.id} — meets the aggregate correct-verdict floor (${spec.minCorrectRate})`, () => {
      const result = evaluateAuditRun(spec.runs.map(loadRun), spec);
      expect(result.matched).toBeGreaterThan(0);
      expect(result.correctRate).toBeGreaterThanOrEqual(spec.minCorrectRate);
    });
  }

  it("apple-mixed — code-adjudicated verdicts are identical across the two runs", () => {
    // The property the whole reconciler chain exists to guarantee. Model-only verdicts may differ.
    const spec = gate.specs.find((s) => s.id === "apple-mixed")!;
    const result = evaluateAuditRun(spec.runs.map(loadRun), spec);
    const drift = result.violations.filter((v) => v.rule === "nondeterministic_code_verdict");
    expect(drift, JSON.stringify(drift, null, 2)).toHaveLength(0);
    expect(result.codeAdjudicated).toBeGreaterThan(0);
  });
});

describe("audit live eval gate — the gate itself must fail when it should", () => {
  const spec: LiveEvalSpec = {
    id: "synthetic",
    minCorrectRate: 0.5,
    claims: [
      { match: "revenue was $10 million", kind: "true" },
      { match: "profit was $5 million", kind: "false" },
    ],
  };
  const claim = (text: string, verdict: string, note: string | null = null, evidence: string[] | null = ["x"]) => ({
    claim: text,
    verdict,
    evidence,
    source_refs: evidence ? ["p1"] : [],
    note,
  });

  it("flags a true claim marked contradicted", () => {
    const run: AuditRun = { claims: [claim("revenue was $10 million", "contradicted"), claim("profit was $5 million", "contradicted")] };
    expect(evaluateAuditRun([run], spec).violations.map((v) => v.rule)).toContain("no_false_accusation");
  });

  it("flags a contradicted verdict with no citation", () => {
    const run: AuditRun = { claims: [claim("revenue was $10 million", "supported"), claim("profit was $5 million", "contradicted", null, null)] };
    expect(evaluateAuditRun([run], spec).violations.map((v) => v.rule)).toContain("contradicted_without_evidence");
  });

  it("flags a code-adjudicated verdict that changed between runs", () => {
    const tag = "[verdict set by code: x]";
    const a: AuditRun = { claims: [claim("revenue was $10 million", "supported", tag), claim("profit was $5 million", "contradicted")] };
    const b: AuditRun = { claims: [claim("revenue was $10 million", "contradicted", tag), claim("profit was $5 million", "contradicted")] };
    expect(evaluateAuditRun([a, b], spec).violations.map((v) => v.rule)).toContain("nondeterministic_code_verdict");
  });

  it("does NOT flag a model-only verdict that changed between runs", () => {
    const a: AuditRun = { claims: [claim("revenue was $10 million", "supported"), claim("profit was $5 million", "contradicted")] };
    const b: AuditRun = { claims: [claim("revenue was $10 million", "partially_supported"), claim("profit was $5 million", "contradicted")] };
    expect(evaluateAuditRun([a, b], spec).violations.map((v) => v.rule)).not.toContain("nondeterministic_code_verdict");
  });

  it("accepts either honest answer for a silence trap, and only rejects contradicted", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "buyback", kind: "silence" }] };
    for (const v of ["unsupported", "unverifiable"]) {
      expect(evaluateAuditRun([{ claims: [claim("buyback of $1", v)] }], s).ok).toBe(true);
    }
    expect(evaluateAuditRun([{ claims: [claim("buyback of $1", "contradicted")] }], s).ok).toBe(false);
  });
});
