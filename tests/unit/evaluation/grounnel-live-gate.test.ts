import { describe, it, expect } from "vitest";
import { evaluateGrounnelRun, type GrounnelRun, type LiveEvalSpec } from "../../../src/evaluation/grounnel-live-gate.js";
import { normalizeRepeats, scoreGrounnelEvalCase, summarizeGrounnelEvalCases } from "../../../src/evaluation/run-grounnel-eval.js";

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

  // D032 §4 #8/#9/T6 — "excluded" is now its own verdict (was folded into "unverifiable" pre-T6,
  // the exact ambiguity D030 §3b's FR-008 flagged). "excluded"/"not_excluded" kinds distinguish
  // pre-search exclusion from "silence"'s looser ["unsupported", "unverifiable"] pair.
  it("'excluded' only accepts excluded — unsupported and unverifiable are both the wrong outcome for a true exclusion", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "in need of a new laptop", kind: "excluded" }] };
    expect(evaluateGrounnelRun([{ claims: [claim("I was in need of a new laptop.", "excluded")] }], s).ok).toBe(true);
    expect(evaluateGrounnelRun([{ claims: [claim("I was in need of a new laptop.", "unverifiable")] }], s).ok).toBe(false);
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

  // CONTRACT CHANGE (supersedes Addendum 9): detection fails on the plain rate again. The
  // significance test could only ever reject 0/5 and 1/5 at N=5, so a floor of 0.7 enforced ~0.2 and
  // 2/5 passed while reporting green. The floor now means what it says; variance is absorbed by
  // setting the floor below measured capability, not by weakening the comparison.
  it("a false claim detected 2/5 fails a 0.80 floor — 0.40 is below it, and the floor means it", () => {
    const text = "The first man on the Moon was Buzz Aldrin.";
    const weak = evaluateGrounnelRun(runsOf(["contradicted", "supported", "contradicted", "supported", "supported"], text), falseSpec);
    expect(weak.detectionRate).toBeCloseTo(0.4);
    expect(weak.violations.map((v) => v.rule)).toContain("below_detection_rate");

    const collapsed = evaluateGrounnelRun(runsOf(["supported", "supported", "supported", "supported", "supported"], text), falseSpec);
    expect(collapsed.violations.map((v) => v.rule)).toContain("below_detection_rate");
    expect(collapsed.ok).toBe(false);
  });

  it("the SAME rate fails once there are enough observations to say so — 4/10 red, 4/5 green", () => {
    const text = "The first man on the Moon was Buzz Aldrin.";
    const five = evaluateGrounnelRun(runsOf(["contradicted", "contradicted", "contradicted", "contradicted", "supported"], text), falseSpec);
    expect(five.detectionRate).toBeCloseTo(0.8);
    expect(five.ok).toBe(true);

    // 0.40 over ten observations: p=0.006, now distinguishable from the 0.80 floor.
    const ten = evaluateGrounnelRun(
      runsOf(["contradicted", "contradicted", "contradicted", "contradicted", "supported", "supported", "supported", "supported", "supported", "supported"], text),
      falseSpec,
    );
    expect(ten.detectionRate).toBeCloseTo(0.4);
    expect(ten.violations.map((v) => v.rule)).toContain("below_detection_rate");
  });

  it("below MIN_VERDICT_REPETITIONS the detection test is skipped and the result is not binding", () => {
    const text = "The first man on the Moon was Buzz Aldrin.";
    const four = evaluateGrounnelRun(runsOf(["contradicted", "supported", "supported", "supported"], text), falseSpec);
    expect(four.verdictIsBinding).toBe(false);
    expect(four.violations.map((v) => v.rule)).not.toContain("below_detection_rate");

    const five = evaluateGrounnelRun(runsOf(["supported", "supported", "supported", "supported", "supported"], text), falseSpec);
    expect(five.verdictIsBinding).toBe(true);
  });

  // Both of these shipped past the first version of this change and were caught in review.
  it("a false claim EXTRACT under-produced leaves detection untested — that is NOT a binding pass", () => {
    const text = "The first man on the Moon was Buzz Aldrin.";
    // 6 repetitions, but the false claim only appears in 3 of them, missed every time.
    const runs: GrounnelRun[] = [
      ...Array.from({ length: 3 }, () => ({ claims: [claim(text, "supported")] })),
      ...Array.from({ length: 3 }, () => ({ claims: [] as Array<{ text: string; verdict: string }> })),
    ];
    const res = evaluateGrounnelRun(runs, falseSpec);
    expect(res.runs).toBe(6);
    expect(res.detectionRate).toBe(0);
    // The test could not run on 3 observations, so the result must not read as a pass.
    expect(res.verdictIsBinding).toBe(false);
  });

  it("detection is gated per false claim — one claim collapsing is not hidden by another passing", () => {
    const twoFalse: LiveEvalSpec = {
      id: "two-false", minCorrectRate: 1,
      claims: [
        { match: "first man on the Moon was Buzz Aldrin", kind: "false" },
        { match: "Great Wall is Roman", kind: "false" },
      ],
    };
    // Claim A perfect 5/5, claim B total collapse 0/5. Aggregate is 5/10 = 0.50.
    const runs: GrounnelRun[] = Array.from({ length: 5 }, () => ({
      claims: [
        claim("The first man on the Moon was Buzz Aldrin.", "contradicted"),
        claim("The Great Wall is Roman.", "supported"),
      ],
    }));
    const res = evaluateGrounnelRun(runs, twoFalse);
    expect(res.violations.map((v) => v.rule)).toContain("below_detection_rate");
    expect(res.violations.find((v) => v.rule === "below_detection_rate")!.detail).toContain("Great Wall");
    expect(res.ok).toBe(false);
  });

  it("one errored case does NOT disarm the gate for a case that genuinely failed", () => {
    const okCase = { id: "g-ok", ok: true, verdictIsBinding: true, runs: 5, safetyOk: true, correctRate: 1, detectionRate: 1,
      correct: 5, matched: 5, falseAccusations: 0, claims: [], violations: [], runDetails: [], run: null } as never;
    const brokenCase = { id: "g-bad", ok: false, verdictIsBinding: true, runs: 5, safetyOk: true, correctRate: 0, detectionRate: 0,
      correct: 0, matched: 5, falseAccusations: 0, claims: [],
      violations: [{ rule: "below_detection_rate", detail: "0/5" }], runDetails: [], run: null } as never;
    // Infrastructure casualty: every repetition threw, so it is non-binding through no fault of the pipeline.
    const erroredCase = { id: "g-err", ok: false, verdictIsBinding: false, runs: 0, safetyOk: false, correctRate: 0, detectionRate: null,
      correct: 0, matched: 0, falseAccusations: 0, claims: [], violations: [], runDetails: [], run: null, errors: ["boom"] } as never;

    const summary = summarizeGrounnelEvalCases([okCase, brokenCase, erroredCase]);
    expect(summary.bindingFailures).toBe(1);
    expect(summary.bindingPassed).toBe(false); // the real regression still turns the suite red
    expect(summary.verdictIsBinding).toBe(false); // coverage is incomplete, and that is reported separately
  });


  // CONTRACT CHANGE: this used to assert ok:true — at N>1 the correctness floor was skipped
  // entirely, so a miss never blocked. That also meant 5-of-5 wrong reported ok. A case that
  // legitimately flakes now says so by declaring minCorrectRate below 1.0 (asserted above);
  // 1.0 means "must never be wrong" and one miss is the verdict at any N.
  it("a true claim missed in 1 of 5 FAILS a case whose declared floor is 1.0", () => {
    const runs = runsOf(["supported", "supported", "unsupported", "supported", "supported"], "The Eiffel Tower was completed in 1889.");
    const result = evaluateGrounnelRun(runs, trueSpec);
    expect(result.correctRate).toBeCloseTo(0.8);
    expect(result.safetyOk).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("below_correct_rate");
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

  // The floor used to apply ONLY at runs.length === 1, so a case wrong in every one of 5 runs
  // reported ok:true — the floor was deleted at N>1, not relaxed. Escalation then rescored a
  // screen failure at N=5 and laundered it into a confirmed pass.
  it("(review finding) fails a case wrong in all 5 runs — the floor applies at every N, not just N=1", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, claims: [{ match: "Eiffel Tower", kind: "true" }] };
    const wrong: GrounnelRun[] = Array.from({ length: 5 }, () => ({ claims: [claim("The Eiffel Tower stands.", "unverifiable")] }));
    const result = evaluateGrounnelRun(wrong, s);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("below_correct_rate");
  });

  it("a case that declares a floor below 1.0 tolerates a miss at that rate but not below it", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 0.8, claims: [{ match: "Eiffel Tower", kind: "true" }] };
    const runs = (bad: number): GrounnelRun[] =>
      Array.from({ length: 5 }, (_, i) => ({ claims: [claim("The Eiffel Tower stands.", i < bad ? "unverifiable" : "supported")] }));
    expect(evaluateGrounnelRun(runs(1), s).ok).toBe(true);   // 4/5 = 0.80, at the floor
    expect(evaluateGrounnelRun(runs(2), s).ok).toBe(false);  // 3/5 = 0.60, below it
  });

  // g17 carries minCorrectRate 1.0 AND detectionFloor 0.7 — pooling them would fail it on any
  // missed detection, contradicting its own floor. `false` claims answer to detectionFloor at N>=5.
  it("keeps detectionFloor governing false claims, so minCorrectRate 1.0 does not override it", () => {
    const s: LiveEvalSpec = { id: "s", minCorrectRate: 1, detectionFloor: 0.6, claims: [{ match: "Buzz Aldrin", kind: "false" }] };
    const runs = (hit: number): GrounnelRun[] =>
      Array.from({ length: 5 }, (_, i) => ({ claims: [claim("The first man on the Moon was Buzz Aldrin.", i < hit ? "contradicted" : "supported")] }));
    expect(evaluateGrounnelRun(runs(3), s).ok).toBe(true);   // 3/5 = 0.60, exactly at the floor
    expect(evaluateGrounnelRun(runs(2), s).ok).toBe(false);  // 2/5 = 0.40 is below it, and now says so
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
