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
  /** Aggregate floor: fraction of matched claims that must land on an acceptable verdict. */
  minCorrectRate: number;
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
  rule: "no_false_accusation" | "below_correct_rate";
  detail: string;
}

export interface LiveEvalResult {
  ok: boolean;
  correctRate: number;
  correct: number;
  matched: number;
  violations: Violation[];
}

const ACCEPTABLE: Record<ClaimKind, string[]> = {
  true: ["supported", "partially_supported"],
  false: ["contradicted"],
  // Absent from the web is honestly reported either way; only `contradicted` is a false accusation.
  silence: ["unsupported", "unverifiable"],
  // D030 §3b (tasks.md T015/T016/T017) — `silence`'s ["unsupported", "unverifiable"] pair can't tell
  // "correctly excluded pre-search" apart from "searched, found nothing" (the exact ambiguity FR-008
  // exists to eliminate), so a true-exclusion/hard-negative fixture needs its own stricter kinds.
  excluded: ["unverifiable"],
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
 * `runs` is one or more executions of the SAME input text — a single run still scores every rule.
 */
export function evaluateGrounnelRun(runs: GrounnelRun[], spec: LiveEvalSpec): LiveEvalResult {
  const violations: Violation[] = [];
  let matched = 0;
  let correct = 0;

  for (const expected of spec.claims) {
    const found = runs.map((r) => findClaim(r, expected.match));
    if (found.every((c) => c === null)) continue; // EXTRACT never produced it — counted separately, not scored
    matched++;

    const acceptable = ACCEPTABLE[expected.kind];
    for (const [i, claim] of found.entries()) {
      if (!claim) continue;
      // A true or absent claim marked `contradicted` is the worst outcome the product can produce —
      // the single case ADR-000 §2's FP-discipline promise is actually about. `not_excluded`'s own
      // ACCEPTABLE list already allows `contradicted` (review finding: it isn't a ground-truth-true
      // kind like `true`/`silence`/`excluded`, it only asserts "reached search," so exempt it here too
      // — otherwise a correctly-scored `contradicted` outcome also forces a false violation.
      if (expected.kind !== "false" && expected.kind !== "not_excluded" && claim.verdict === "contradicted") {
        violations.push({
          rule: "no_false_accusation",
          detail: `run ${i}: ${expected.kind} claim "${claim.text.slice(0, 70)}" → contradicted`,
        });
      }
    }

    const primary = found.find((c) => c !== null)!;
    if (acceptable.includes(primary.verdict ?? "")) correct++;
  }

  const correctRate = matched === 0 ? 0 : correct / matched;
  if (correctRate < spec.minCorrectRate) {
    violations.push({
      rule: "below_correct_rate",
      detail: `${correct}/${matched} = ${correctRate.toFixed(2)} below floor ${spec.minCorrectRate}`,
    });
  }

  return { ok: violations.length === 0, correctRate, correct, matched, violations };
}
