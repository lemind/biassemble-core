import { describe, it, expect } from "vitest";
import { evaluateGrounnelRun, type GrounnelRun, type LiveEvalSpec } from "../../../src/evaluation/grounnel-live-gate.js";
import { normalizeRepeats, scoreGrounnelEvalCase } from "../../../src/evaluation/run-grounnel-eval.js";

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

  // D030 §3b (tasks.md T015/T016) — "excluded"/"not_excluded" distinguish pre-search exclusion from
  // "silence"'s looser ["unsupported", "unverifiable"] pair, which can't tell them apart.
  it("'excluded' only accepts unverifiable — unsupported (searched, found nothing) is the wrong outcome for a true exclusion", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "in need of a new laptop", kind: "excluded" }] };
    expect(evaluateGrounnelRun([{ claims: [claim("I was in need of a new laptop.", "unverifiable")] }], s).ok).toBe(true);
    expect(evaluateGrounnelRun([{ claims: [claim("I was in need of a new laptop.", "unsupported")] }], s).ok).toBe(false);
  });

  it("'not_excluded' rejects unverifiable — a hard-negative claim must not have been excluded pre-search", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "said Fleming", kind: "not_excluded" }] };
    expect(evaluateGrounnelRun([{ claims: [claim('"I discovered X in 1928," said Fleming.', "supported")] }], s).ok).toBe(true);
    expect(evaluateGrounnelRun([{ claims: [claim('"I discovered X in 1928," said Fleming.', "unsupported")] }], s).ok).toBe(true);
    expect(evaluateGrounnelRun([{ claims: [claim('"I discovered X in 1928," said Fleming.', "unverifiable")] }], s).ok).toBe(false);
  });

  // Review finding: `not_excluded`'s own ACCEPTABLE list allows `contradicted` (it only asserts
  // "reached search," not "is true"), but the no_false_accusation check originally exempted only
  // `"false"` — a correctly-scored `contradicted` outcome was also flagged as a false accusation,
  // forcing `ok:false` for a run that behaved exactly as intended.
  it("'not_excluded' does not treat a genuinely contradicted outcome as a false accusation", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "said Fleming", kind: "not_excluded" }] };
    const result = evaluateGrounnelRun([{ claims: [claim('"I discovered X in 1928," said Fleming.', "contradicted")] }], s);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// D030 §3k — repeated-run protocol. One repetition is a draw from a distribution, not a verdict:
// g17 sat at ~39% `contradicted` across 23 real runs while every single-run report read green.
describe("repeated runs (D030 §3k): safety is hard, detection is a rate", () => {
  const claim = (text: string, verdict: string): { text: string; verdict: string } => ({ text, verdict });
  const trueSpec: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "Eiffel Tower", kind: "true" }] };
  const falseSpec: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "Buzz Aldrin", kind: "false" }] };
  const runsOf = (verdicts: string[], text: string): GrounnelRun[] => verdicts.map((v) => ({ claims: [claim(text, v)] }));

  it("ONE false accusation in five repetitions still fails the safety gate", () => {
    const runs = runsOf(["supported", "supported", "contradicted", "supported", "supported"], "The Eiffel Tower was completed in 1889.");
    const result = evaluateGrounnelRun(runs, trueSpec);
    expect(result.safetyOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.rule === "no_false_accusation")).toHaveLength(1);
  });

  it("records the full verdict distribution, not a collapsed pass/fail bit", () => {
    const runs = runsOf(["contradicted", "supported", "contradicted", "supported", "supported"], "The first man on the Moon was Buzz Aldrin.");
    const result = evaluateGrounnelRun(runs, falseSpec);
    expect(result.runs).toBe(5);
    expect(result.claims[0]!.verdicts).toEqual({ contradicted: 2, supported: 3 });
    expect(result.claims[0]!.rate).toBeCloseTo(0.4);
    expect(result.detectionRate).toBeCloseTo(0.4);
  });

  it("a false claim detected 2/5 fails the provisional detection floor; 4/5 passes", () => {
    const text = "The first man on the Moon was Buzz Aldrin.";
    const weak = evaluateGrounnelRun(runsOf(["contradicted", "supported", "contradicted", "supported", "supported"], text), falseSpec);
    expect(weak.ok).toBe(false);
    expect(weak.violations.map((v) => v.rule)).toContain("below_detection_rate");

    const ok = evaluateGrounnelRun(runsOf(["contradicted", "contradicted", "contradicted", "supported", "contradicted"], text), falseSpec);
    expect(ok.detectionRate).toBeCloseTo(0.8);
    expect(ok.ok).toBe(true);
  });

  it("a true claim missed in 1 of 5 is recorded but is NOT a deploy blocker (only safety is hard)", () => {
    const runs = runsOf(["supported", "supported", "unsupported", "supported", "supported"], "The Eiffel Tower was completed in 1889.");
    const result = evaluateGrounnelRun(runs, trueSpec);
    expect(result.correctRate).toBeCloseTo(0.8);
    expect(result.safetyOk).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("N=1 keeps the original semantics exactly — the strict minCorrectRate floor still applies", () => {
    const result = evaluateGrounnelRun(runsOf(["unsupported"], "The Eiffel Tower was completed in 1889."), trueSpec);
    expect(result.runs).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("below_correct_rate");
  });

  it("scores every repetition a claim appears in, skipping ones EXTRACT never produced", () => {
    const runs: GrounnelRun[] = [
      { claims: [claim("The Eiffel Tower was completed in 1889.", "supported")] },
      { claims: [] },
      { claims: [claim("The Eiffel Tower was completed in 1889.", "supported")] },
    ];
    const result = evaluateGrounnelRun(runs, trueSpec);
    expect(result.claims[0]!.observations).toBe(2);
    expect(result.matched).toBe(2);
  });
});

// Review findings on the §3k protocol itself: the harness tracked per-repetition errors but never
// gated on them, so an underpowered run could still report green — the exact failure it exists to stop.
describe("repeated runs: a partial or unobserved case must never report a pass", () => {
  const claim = (text: string, verdict: string): { text: string; verdict: string } => ({ text, verdict });
  const goldenCase = {
    id: "s",
    text: "irrelevant",
    minCorrectRate: 1,
    claims: [{ match: "Eiffel Tower", kind: "true" as const }],
  };
  const run = (verdict: string): GrounnelRun => ({ claims: [claim("The Eiffel Tower was completed in 1889.", verdict)] });

  it("(review finding) scoring 2 of a requested 5 repetitions fails, even when both were correct", () => {
    const result = scoreGrounnelEvalCase(goldenCase, [run("supported"), run("supported")], ["quota", "quota", "quota"], undefined, 5);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("incomplete_repetitions");
    expect(result.runs).toBe(2);
  });

  it("all repetitions complete → no incomplete_repetitions violation", () => {
    const result = scoreGrounnelEvalCase(goldenCase, [run("supported"), run("supported")], [], undefined, 2);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("(review finding) zero successful repetitions reports safetyOk FALSE — unchecked is not safe", () => {
    const result = scoreGrounnelEvalCase(goldenCase, [], ["quota exhausted"], undefined, 5);
    expect(result.safetyOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("quota exhausted");
  });

  it("(review finding) a case whose claims EXTRACT never produced fails at N>1 instead of passing vacuously", () => {
    const empty: GrounnelRun[] = [{ claims: [] }, { claims: [] }, { claims: [] }];
    const result = evaluateGrounnelRun(empty, { id: "s", minCorrectRate: 1, claims: [{ match: "Eiffel Tower", kind: "true" }] });
    expect(result.matched).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("(review finding) a NaN/garbage repeats value normalizes to 1, never to zero repetitions", () => {
    expect(normalizeRepeats(Number.NaN)).toBe(1);
    expect(normalizeRepeats("abc")).toBe(1);
    expect(normalizeRepeats(undefined)).toBe(1);
    expect(normalizeRepeats(2.7)).toBe(2);
    expect(normalizeRepeats(0)).toBe(1);
    expect(normalizeRepeats(999)).toBe(20);
  });
});
