// The 10-gate chain applied to one VERIFY result (subject_entity disabled, D030 §3m Addendum 6) — pure/sync/no I/O (D025 §2) so T034/T035's retry can re-run it. Extracted as a free function (D031 split, pure move — it never touched `this`).

import {
  applyClaimReasonOverlapGate,
  applyContradictionEvidenceGate,
  applyCounterfactIgnoredGate,
  applyImplicitNegationGate,
  applyInstanceAttributionGate,
  applyNumericGate,
  applyReasonConsistencyGate,
  applyReasonOrdinalGate,
  applyReasonYearGate,
  applyYearGate,
  type InstanceAttribution,
} from "./gates.js";
import { originatingContradictionGate, PROTECTED_CONTRADICTION_GATES, type Verdict } from "./pipeline-helpers.js";
import type { GateEventInput } from "../../persistence/grounnel-gate-event-store.js";
import type { GateReason } from "../../persistence/types.js";

/** One gate's finding (D025 §2); `code` reuses `GateReason` so it can't drift from grounnel_gate_events.reason. */
export interface Diagnostic {
  code: GateReason;
  severity: "ERROR" | "WARNING" | "INFO";
  details: string;
}

export interface GateChainInput {
  verdict: Verdict;
  reason: string | null;
  evidence: string | null;
  claimText: string;
  passageText: string;
  subjectEntity: string;
  // Threaded in so this function stays pure/sync/no I/O — see D025 §2 for what feeds this.
  reasonSupportsVerdict: boolean | null;
  // Same threading, spec 013 T21 — the passage-grounded checker's answer for this claim, or null.
  instanceAttribution: InstanceAttribution | null;
}

export interface GateChainResult {
  verdict: Verdict;
  evidence: string | null;
  gateEvents: GateEventInput[];
  diagnostics: Diagnostic[];
  needsRetry: boolean;
}

export function runGateChain(input: GateChainInput): GateChainResult {
  let verdict = input.verdict;
  const gateEvents: GateEventInput[] = [];
  const diagnostics: Diagnostic[] = [];

  // Reason-consistency gate (g04/g05) — runs before gate #1 so a flip to contradicted still clears its evidence check.
  const reasonConsistency = applyReasonConsistencyGate({ verdict, reason: input.reason, claimText: input.claimText });
  gateEvents.push({ gate: "reason_consistency", verdictBefore: verdict, verdictAfter: reasonConsistency.verdict, overridden: reasonConsistency.overridden, reason: reasonConsistency.reason });
  verdict = reasonConsistency.verdict;

  // Case A gate (D022 §4) — bare "X, not Y" negation, the gap applyReasonConsistencyGate
  // names but doesn't catch (g05). Also runs before gate #1 — a flip still needs real evidence.
  const implicitNegation = applyImplicitNegationGate({
    verdict,
    reason: input.reason,
    claimText: input.claimText,
    passageText: input.passageText,
  });
  gateEvents.push({ gate: "implicit_negation", verdictBefore: verdict, verdictAfter: implicitNegation.verdict, overridden: implicitNegation.overridden, reason: implicitNegation.reason });
  verdict = implicitNegation.verdict;

  // Reason/verdict year-mismatch gate (T069) — reads VERIFY's own reason for a differing year, not raw evidence (applyYearGate's whitelist couldn't keep up).
  const reasonYear = applyReasonYearGate({ verdict, reason: input.reason, claimText: input.claimText });
  gateEvents.push({ gate: "reason_year", verdictBefore: verdict, verdictAfter: reasonYear.verdict, overridden: reasonYear.overridden, reason: reasonYear.reason });
  verdict = reasonYear.verdict;

  // Reason/verdict ordinal-mismatch gate (D030) — same rationale as reasonYear, for a differing anchored ordinal.
  const reasonOrdinal = applyReasonOrdinalGate({ verdict, reason: input.reason, claimText: input.claimText });
  gateEvents.push({ gate: "reason_ordinal", verdictBefore: verdict, verdictAfter: reasonOrdinal.verdict, overridden: reasonOrdinal.overridden, reason: reasonOrdinal.reason });
  verdict = reasonOrdinal.verdict;

  // Instance-attribution gate (spec 013 T21) — reads the PASSAGES, the input reason_ordinal lacks; also before gate #1 so a flip still needs real evidence.
  const instanceAttribution = applyInstanceAttributionGate({ verdict, claimText: input.claimText, attribution: input.instanceAttribution });
  gateEvents.push({ gate: "instance_attribution", verdictBefore: verdict, verdictAfter: instanceAttribution.verdict, overridden: instanceAttribution.overridden, reason: instanceAttribution.reason });
  verdict = instanceAttribution.verdict;

  // Gate #5 (D025 §2/§3) — chain position (between implicit_negation and gate #1) is load-bearing, see ADR.
  const counterfact = applyCounterfactIgnoredGate({ verdict, reasonSupportsVerdict: input.reasonSupportsVerdict });
  // overridden is always false — this gate only flags (D025 §2); query by reason IS NOT NULL, not overridden = true.
  gateEvents.push({ gate: "counterfact_ignored", verdictBefore: verdict, verdictAfter: verdict, overridden: false, reason: counterfact.reason });
  if (counterfact.flagged) {
    diagnostics.push({ code: "counterfact_ignored", severity: "ERROR", details: "The model's own reason did not appear to support the verdict it gave for this claim." });
  }

  // Captured before gate #1 — needsRetry also needs a claim that arrived already "contradicted", not just a flipped one.
  const verdictBeforeGate1 = verdict;

  // Gate #1 — never reaches the store without passing this (D019 §2, T003, tasks.md acceptance).
  const gate1 = applyContradictionEvidenceGate({ verdict, evidence: input.evidence, passageText: input.passageText });
  gateEvents.push({ gate: "contradiction_evidence", verdictBefore: verdict, verdictAfter: gate1.verdict, overridden: gate1.overridden, reason: gate1.reason });
  verdict = gate1.verdict;
  let evidence = gate1.evidence;

  // T034 (g04) — verdict was "contradicted" going into gate #1 but no real evidence backed it.
  // details phrased generically, not "verdict was contradicted" — D025 §2's reconciliation prompt shows the model its own raw pre-gate verdict, which may differ.
  if (verdictBeforeGate1 === "contradicted" && (gate1.reason === "evidence_null" || gate1.reason === "evidence_not_grounded")) {
    diagnostics.push({
      code: gate1.reason,
      severity: "ERROR",
      details:
        gate1.reason === "evidence_null"
          ? "A contradiction was indicated but no evidence quote was given."
          : "A contradiction was indicated but the evidence quote wasn't found verbatim in the passage.",
    });
  }

  // Gate #1b (D026 §12) — cross-claim contamination backstop: a batched VERIFY call can answer one claim's id with a different claim's (topically unrelated but grounded) reasoning.
  const gate1b = applyClaimReasonOverlapGate({ verdict, reason: input.reason, claimText: input.claimText });
  gateEvents.push({ gate: "claim_reason_overlap", verdictBefore: verdict, verdictAfter: gate1b.verdict, overridden: gate1b.overridden, reason: gate1b.reason });
  verdict = gate1b.verdict;
  if (gate1b.overridden) {
    evidence = null; // stale — it was only meaningful attached to the discarded contradicted verdict.
    diagnostics.push({ code: "claim_reason_no_overlap", severity: "ERROR", details: "The model's reason for this contradiction shares no key terms with the claim itself — likely cross-claim contamination in a batched VERIFY call." });
  }

  // Gate #2 — numeric normalization/comparison (D019 §2). D030 §3d — a numeric MATCH must not silently un-contradict a verdict reason_ordinal produced.
  const gate2 = applyNumericGate({
    claimText: input.claimText,
    verdict,
    evidence,
    contradictionProtectedFromForceSupported: verdict === "contradicted" && PROTECTED_CONTRADICTION_GATES.has(originatingContradictionGate(gateEvents)?.gate ?? ""),
  });
  gateEvents.push({ gate: "numeric", verdictBefore: verdict, verdictAfter: gate2.verdict, overridden: gate2.overridden, reason: gate2.reason });
  verdict = gate2.verdict;

  // Gate #2b — year/date comparison; extractNumericFact (gate #2) never recognizes bare years.
  const gate2b = applyYearGate({ claimText: input.claimText, verdict, evidence });
  gateEvents.push({ gate: "year", verdictBefore: verdict, verdictAfter: gate2b.verdict, overridden: gate2b.overridden, reason: gate2b.reason });
  verdict = gate2b.verdict;

  // g17 subject_entity — DISABLED 2026-08-31 (D030 §3m Addendum 6): 0 confirmed genuine catches in
  // 320 firings vs a ~75% false-trigger rate; 7 fix candidates refuted. Call site skipped, not deleted.

  // D025 §2 — retry fires on any ERROR-severity diagnostic; the field exists so a future WARNING/INFO gate doesn't force one.
  const needsRetry = diagnostics.some((d) => d.severity === "ERROR");

  return { verdict, evidence, gateEvents, diagnostics, needsRetry };
}
