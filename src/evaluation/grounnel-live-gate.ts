/** Live-run eval gate for Grounnel — scores a real run against expected outcomes. Same design as audit-live-gate.ts (loose match, kind->verdict mapping, aggregate floor). */

export type ClaimKind = "true" | "false" | "silence" | "excluded" | "not_excluded";

export interface ExpectedClaim {
  /** Substring of the claim text as EXTRACT produced it — matched loosely, since EXTRACT rewords. */
  match: string;
  kind: ClaimKind;
}

export interface LiveEvalSpec {
  id: string;
  claims: ExpectedClaim[];
  /** Aggregate floor: fraction of matched claims that must land on an acceptable verdict. N=1 only. */
  minCorrectRate: number;
  /** Per-case override of the provisional detection floor (N>1). Defaults to DETECTION_RATE_INITIAL_FLOOR. */
  detectionFloor?: number;
}

export interface GrounnelClaim {
  text: string;
  verdict: string | null;
  /** Diagnostic only, not scored — lets a null verdict be told apart from a genuinely wrong one. */
  status?: string;
  reason?: string | null;
}
export interface GrounnelRun {
  id?: string;
  claims: GrounnelClaim[];
}

export interface Violation {
  rule: "no_false_accusation" | "below_correct_rate" | "below_detection_rate" | "incomplete_repetitions";
  detail: string;
}

/** D030 §3k — provisional engineering bar, NOT a scientifically justified threshold. At N=5 the only
 * reachable rates are 0/.2/.4/.6/.8/1, so this means "at least 4 of 5". Revise after Stage 2. */
export const DETECTION_RATE_INITIAL_FLOOR = 0.8;

/** Repetitions required before a result may fail the suite. Below this, a run is indicative only. */
export const MIN_VERDICT_REPETITIONS = 5;
/** One-sided significance for "is detection below the floor" (D030 §3m Addendum 9). */
export const DETECTION_ALPHA = 0.05;

/**
 * P(X <= k | n, p) — exact one-sided binomial lower tail. n is bounded by repetitions (<= 20), so a
 * plain loop is exact and cheap; logs keep the terms stable rather than overflowing factorials.
 */
export function binomCdf(k: number, n: number, p: number): number {
  if (k >= n) return 1;
  if (k < 0) return 0;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let logC = 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}

/** Per-expected-claim outcome across N repetitions — the distribution, not a collapsed boolean. */
export interface ClaimOutcome {
  match: string;
  kind: ClaimKind;
  /** Repetitions in which EXTRACT actually produced this claim. Unproduced ones aren't scored. */
  observations: number;
  correct: number;
  /** correct / observations; null when EXTRACT never produced it in any repetition. */
  rate: number | null;
  /** verdict -> count, e.g. { contradicted: 2, supported: 3 } — the g17-style coin-flip detector. */
  verdicts: Record<string, number>;
}

export interface LiveEvalResult {
  ok: boolean;
  /** Whether `ok` may be read as a verdict: enough repetitions AND enough observations of whatever
   * was actually tested. See D030 §3m Addendum 9. */
  verdictIsBinding: boolean;
  /** How many repetitions of the same input were scored. */
  runs: number;
  /** Hard gate: zero `contradicted` observations on any non-`false` kind, across every repetition. */
  safetyOk: boolean;
  correctRate: number;
  /** Over `kind: "false"` claims only — "did we actually catch the lie". Null when the case has none. */
  detectionRate: number | null;
  correct: number;
  matched: number;
  claims: ClaimOutcome[];
  violations: Violation[];
}

const ACCEPTABLE: Record<ClaimKind, string[]> = {
  true: ["supported", "partially_supported"],
  false: ["contradicted"],
  // Absent from the web is honestly reported either way; only `contradicted` is a false accusation.
  silence: ["unsupported", "unverifiable"],
  // D032 §4 #8/#9/T6 — `excluded` is now its own verdict, not folded into `unverifiable`; this is
  // the ambiguity D030 §3b's FR-008 flagged, resolved by giving exclusion its own value (D032 §3f).
  excluded: ["excluded"],
  not_excluded: ["supported", "partially_supported", "unsupported", "contradicted"],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Loose match — EXTRACT rewords claims, so exact equality would make the gate brittle for the wrong reason. */
function findClaim(run: GrounnelRun, match: string): GrounnelClaim | null {
  const needle = norm(match);
  return run.claims.find((c) => norm(c.text).includes(needle)) ?? null;
}

/**
 * `runs` is one or more repetitions of the SAME input text. D030 §3k: this pipeline is stochastic, so
 * one repetition is a draw from a distribution, not a verdict — every claim is scored in EVERY
 * repetition it appears in, and the result carries rates plus the raw verdict distribution.
 * N=1 keeps the original semantics exactly, so existing single-run callers are unaffected.
 */
export function evaluateGrounnelRun(runs: GrounnelRun[], spec: LiveEvalSpec): LiveEvalResult {
  const violations: Violation[] = [];
  const claims: ClaimOutcome[] = [];
  let matched = 0;
  let correct = 0;
  let detectionObservations = 0;
  let detectionCorrect = 0;
  let nonDetectionObservations = 0;
  let nonDetectionCorrect = 0;

  for (const expected of spec.claims) {
    const found = runs.map((r) => findClaim(r, expected.match));
    if (found.every((c) => c === null)) continue; // EXTRACT never produced it — counted separately, not scored

    const acceptable = ACCEPTABLE[expected.kind];
    const outcome: ClaimOutcome = { match: expected.match, kind: expected.kind, observations: 0, correct: 0, rate: null, verdicts: {} };

    for (const [i, claim] of found.entries()) {
      if (!claim) continue;
      const verdict = claim.verdict ?? "null";
      outcome.observations++;
      outcome.verdicts[verdict] = (outcome.verdicts[verdict] ?? 0) + 1;
      if (acceptable.includes(verdict)) outcome.correct++;

      // A true or absent claim marked `contradicted` is the worst outcome the product can produce —
      // the single case ADR-000 §2's FP-discipline promise is actually about. `not_excluded`'s own
      // ACCEPTABLE list already allows `contradicted` (review finding: it isn't a ground-truth-true
      // kind like `true`/`silence`/`excluded`, it only asserts "reached search," so exempt it here too
      // — otherwise a correctly-scored `contradicted` outcome also forces a false violation.
      // Scanned in EVERY repetition: one false accusation in five runs is still a false accusation.
      if (expected.kind !== "false" && expected.kind !== "not_excluded" && claim.verdict === "contradicted") {
        violations.push({
          rule: "no_false_accusation",
          detail: `run ${i}: ${expected.kind} claim "${claim.text.slice(0, 70)}" → contradicted`,
        });
      }
    }

    outcome.rate = outcome.observations === 0 ? null : outcome.correct / outcome.observations;
    claims.push(outcome);
    matched += outcome.observations;
    correct += outcome.correct;
    if (expected.kind === "false") {
      detectionObservations += outcome.observations;
      detectionCorrect += outcome.correct;
    } else {
      // Kept apart so minCorrectRate and detectionFloor cannot fight: g17 is 1.0 AND 0.7, and
      // pooling them would fail it on any missed detection, contradicting its own floor.
      nonDetectionObservations += outcome.observations;
      nonDetectionCorrect += outcome.correct;
    }
  }

  const safetyOk = !violations.some((v) => v.rule === "no_false_accusation");
  const correctRate = matched === 0 ? 0 : correct / matched;
  const detectionRate = detectionObservations === 0 ? null : detectionCorrect / detectionObservations;

  // Nothing observed is not a pass. At N=1 the floor below already caught this (0 < any floor), but
  // at N>1 a case whose claims EXTRACT never produced has detectionRate === null and would otherwise
  // fall through every gate and report ok — a vacuous green, the exact thing §3k exists to stop.
  if (matched === 0) {
    violations.push({
      rule: "below_correct_rate",
      detail: `no expected claim was produced in any of the ${runs.length} repetition(s) — nothing was scored`,
    });
  } else if (runs.length === 1) {
    // The SCREEN. One run, all kinds pooled: a missed detection here is the signal that triggers
    // escalation, so `false` claims must count at N=1 even though detectionFloor governs at N>=5.
    if (correctRate < spec.minCorrectRate) {
      violations.push({
        rule: "below_correct_rate",
        detail: `${correct}/${matched} = ${correctRate.toFixed(2)} below floor ${spec.minCorrectRate}`,
      });
    }
  } else {
    // The floor applies at EVERY N, over non-`false` claims. It used to apply only at N=1, so a
    // case wrong in 5 of 5 runs reported ok — the floor was deleted, not relaxed. A case that
    // genuinely flakes says so by LOWERING its own minCorrectRate; the gate never opts out.
    const ndRate = nonDetectionObservations === 0 ? null : nonDetectionCorrect / nonDetectionObservations;
    if (ndRate !== null && ndRate < spec.minCorrectRate) {
      violations.push({
        rule: "below_correct_rate",
        detail: `${nonDetectionCorrect}/${nonDetectionObservations} = ${ndRate.toFixed(2)} below floor ${spec.minCorrectRate}`,
      });
    }
    // Detection is gated PER false claim, not on the summed rate: summing hides one claim at 0/5
    // behind two at 5/5, and separate claims do not share a rate. D030 §3m Addendum 9.
    const floor = spec.detectionFloor ?? DETECTION_RATE_INITIAL_FLOOR;
    for (const c of claims) {
      if (c.kind !== "false" || c.observations < MIN_VERDICT_REPETITIONS) continue;
      // A hypothesis test, NOT a threshold — never "simplify" back to `rate < floor` (see the ADR).
      const p = binomCdf(c.correct, c.observations, floor);
      if (p < DETECTION_ALPHA) {
        violations.push({
          rule: "below_detection_rate",
          detail: `"${c.match.slice(0, 60)}": ${c.correct}/${c.observations} = ${(c.correct / c.observations).toFixed(2)}, p=${p.toFixed(3)} — significantly below floor ${floor}`,
        });
      }
    }
  }

  // Binding means the test that matters actually had the observations to run. A false claim EXTRACT
  // produced in only 4 of 6 repetitions leaves detection untested, and untested is not a pass.
  const underObservedFalseClaim = claims.some((c) => c.kind === "false" && c.observations < MIN_VERDICT_REPETITIONS);
  const verdictIsBinding = runs.length >= MIN_VERDICT_REPETITIONS && !underObservedFalseClaim;

  return { ok: violations.length === 0, verdictIsBinding, runs: runs.length, safetyOk, correctRate, detectionRate, correct, matched, claims, violations };
}
