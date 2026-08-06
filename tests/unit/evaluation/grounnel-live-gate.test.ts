import { describe, it, expect } from "vitest";
import { evaluateGrounnelRun, type GrounnelRun, type LiveEvalSpec } from "../../../src/evaluation/grounnel-live-gate.js";

describe("Grounnel live eval gate — the gate itself must fail when it should", () => {
  const spec: LiveEvalSpec = {
    id: "synthetic",
    minCorrectRate: 0.5,
    claims: [
      { match: "Eiffel Tower was completed in 1889", kind: "true" },
      { match: "first man on the Moon was Buzz Aldrin", kind: "false" },
      { match: "some genuinely obscure fact", kind: "silence" },
    ],
  };
  const claim = (text: string, verdict: string): { text: string; verdict: string } => ({ text, verdict });

  it("flags a true claim marked contradicted (a false accusation)", () => {
    const run: GrounnelRun = { claims: [claim("The Eiffel Tower was completed in 1889.", "contradicted")] };
    expect(evaluateGrounnelRun([run], spec).violations.map((v) => v.rule)).toContain("no_false_accusation");
  });

  it("does NOT flag a false claim correctly marked contradicted", () => {
    const run: GrounnelRun = { claims: [claim("The first man on the Moon was Buzz Aldrin.", "contradicted")] };
    expect(evaluateGrounnelRun([run], spec).violations.map((v) => v.rule)).not.toContain("no_false_accusation");
  });

  it("accepts either honest answer for a silence case, and only rejects contradicted", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "some genuinely obscure fact", kind: "silence" }] };
    for (const v of ["unsupported", "unverifiable"]) {
      expect(evaluateGrounnelRun([{ claims: [claim("Some genuinely obscure fact happened.", v)] }], s).ok).toBe(true);
    }
    expect(evaluateGrounnelRun([{ claims: [claim("Some genuinely obscure fact happened.", "contradicted")] }], s).ok).toBe(false);
  });

  it("computes correctRate only over matched claims, ignoring ones EXTRACT never produced", () => {
    const run: GrounnelRun = { claims: [claim("The Eiffel Tower was completed in 1889.", "supported")] };
    const result = evaluateGrounnelRun([run], spec);
    expect(result.matched).toBe(1); // only 1 of 3 expected claims was ever extracted
    expect(result.correctRate).toBe(1);
  });

  it("fails below_correct_rate when too many matched claims land on the wrong verdict", () => {
    const run: GrounnelRun = {
      claims: [claim("The Eiffel Tower was completed in 1889.", "unsupported"), claim("The first man on the Moon was Buzz Aldrin.", "unsupported")],
    };
    const result = evaluateGrounnelRun([run], spec);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("below_correct_rate");
  });

  it("matches on a short anchor substring, not the full expected sentence — EXTRACT doesn't quote verbatim", () => {
    const anchorSpec: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "Eiffel Tower", kind: "true" }] };
    const run: GrounnelRun = { claims: [claim("Construction of the Eiffel Tower was finished in 1889, according to sources.", "supported")] };
    const result = evaluateGrounnelRun([run], anchorSpec);
    expect(result.matched).toBe(1);
  });
});
