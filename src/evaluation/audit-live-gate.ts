/**
 * Live-run eval gate for audit mode — scores a real `/audit` response against expected outcomes.
 *
 * Deliberately tolerant of LLM variance: it asserts the invariants that hold regardless of which
 * wording the model produced, plus an aggregate floor, instead of exact per-claim matching. Rationale
 * and the failure history behind each rule: D018 §5.
 */

export type ClaimKind = "true" | "false" | "silence";

export interface ExpectedClaim {
  /** Substring of the claim as EXTRACT produced it — matched loosely, since EXTRACT rewords. */
  match: string;
  kind: ClaimKind;
}

export interface LiveEvalSpec {
  id: string;
  claims: ExpectedClaim[];
  /** Aggregate floor: fraction of matched claims that must land on an acceptable verdict. */
  minCorrectRate: number;
}

export interface AuditClaim {
  claim: string;
  verdict: string;
  evidence: string[] | null;
  source_refs: string[] | null;
  note: string | null;
}
export interface AuditRun {
  audit_id?: string;
  claims: AuditClaim[];
}

export interface Violation {
  rule: "no_false_accusation" | "nondeterministic_code_verdict" | "contradicted_without_evidence" | "below_correct_rate";
  detail: string;
}

export interface LiveEvalResult {
  ok: boolean;
  correctRate: number;
  matched: number;
  codeAdjudicated: number;
  violations: Violation[];
}

const CODE_TAG_RE = /\[verdict (?:set|overridden) by code:/;

const ACCEPTABLE: Record<ClaimKind, string[]> = {
  true: ["supported", "partially_supported"],
  false: ["contradicted"],
  // Absent from the source is honestly reported either way; only `contradicted` is wrong.
  silence: ["unsupported", "unverifiable"],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Loose match — EXTRACT rewords claims, so exact equality would make the gate brittle for the wrong reason. */
function findClaim(run: AuditRun, match: string): AuditClaim | null {
  const needle = norm(match);
  return run.claims.find((c) => norm(c.claim).includes(needle)) ?? null;
}

export function isCodeAdjudicated(claim: AuditClaim | null): boolean {
  return Boolean(claim?.note && CODE_TAG_RE.test(claim.note));
}

/**
 * `runs` is one or more executions of the SAME input. A single run still checks every rule except
 * determinism, which needs at least two.
 */
export function evaluateAuditRun(runs: AuditRun[], spec: LiveEvalSpec): LiveEvalResult {
  const violations: Violation[] = [];
  let matched = 0;
  let correct = 0;
  let codeAdjudicated = 0;

  for (const expected of spec.claims) {
    const found = runs.map((r) => findClaim(r, expected.match));
    if (found.every((c) => c === null)) continue; // EXTRACT never produced it — counted separately, not scored
    matched++;

    const acceptable = ACCEPTABLE[expected.kind];
    for (const [i, claim] of found.entries()) {
      if (!claim) continue;

      // A true or absent claim marked `contradicted` is the worst outcome the product can produce.
      if (expected.kind !== "false" && claim.verdict === "contradicted") {
        violations.push({
          rule: "no_false_accusation",
          detail: `run ${i}: ${expected.kind} claim "${claim.claim.slice(0, 70)}" → contradicted`,
        });
      }

      // Never assign contradicted without a citation a reviewer can follow (D018 §2.3).
      if (claim.verdict === "contradicted" && (!claim.evidence?.length || !claim.source_refs?.length)) {
        violations.push({
          rule: "contradicted_without_evidence",
          detail: `run ${i}: "${claim.claim.slice(0, 70)}" contradicted with empty evidence/source_refs`,
        });
      }
    }

    // Determinism is required only where code adjudicated: elsewhere the model is allowed to differ.
    const codeRuns = found.filter(isCodeAdjudicated);
    if (codeRuns.length > 0) {
      codeAdjudicated++;
      const verdicts = new Set(found.filter((c) => c !== null).map((c) => c!.verdict));
      if (verdicts.size > 1) {
        violations.push({
          rule: "nondeterministic_code_verdict",
          detail: `"${expected.match}" code-adjudicated but verdicts differ across runs: ${[...verdicts].join(", ")}`,
        });
      }
    }

    // Aggregate scoring uses the first run that produced the claim.
    const primary = found.find((c) => c !== null)!;
    if (acceptable.includes(primary.verdict)) correct++;
  }

  const correctRate = matched === 0 ? 0 : correct / matched;
  if (correctRate < spec.minCorrectRate) {
    violations.push({
      rule: "below_correct_rate",
      detail: `${correct}/${matched} = ${correctRate.toFixed(2)} below floor ${spec.minCorrectRate}`,
    });
  }

  return { ok: violations.length === 0, correctRate, matched, codeAdjudicated, violations };
}
