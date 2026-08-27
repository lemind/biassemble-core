// Reason-grounded gates — check VERIFY's reason text against the claim's own structural marker (D030/D031 split, pure move; byte-identical negation regexes merged). See gates.ts for the barrel.

import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import {
  isSentenceTerminator,
  anchorWords as ordinalAnchorWords,
  anchorsOverlap,
  firstClauseBoundaryForward,
  SELECTOR_RE_G as ORDINAL_RE_G,
} from "../../lib/instance-selector.js";
import { NEGATION_CUE_RE, sameEntity, type Verdict } from "./gates-shared.js";
import { YEAR_TOKEN_RE_G } from "./gates-numeric-and-year.js";

// Window sized off a real captured VERIFY reason with margin. "n't" has no leading \b (contractions), same fix NEGATED_CONTRADICTION_RE applies.
const NEGATION_WINDOW = 60;

// D030 §3g follow-up (g17 continued) — number + its immediate unit word, e.g. "852 feet"/"852 ft".
const NUMBER_UNIT_RE = /(\d[\d,.]*)\s*([a-zA-Z]+)/g;
// Spelling variants only, scoped to the actually-observed g17 unit (review finding: broader
// speculative families were untested); an unmapped unit passes through via the `?? unit` fallback.
const UNIT_ALIASES: Record<string, string> = { ft: "feet", foot: "feet" };
function toUnitValue(match: RegExpMatchArray): { value: string; unit: string } {
  const unit = match[2]!.toLowerCase();
  return { value: match[1]!.replace(/,/g, ""), unit: UNIT_ALIASES[unit] ?? unit };
}

function lastClauseBoundary(window: string): number {
  let last = -1;
  for (let i = 0; i < window.length; i++) {
    const ch = window[i]!;
    if (ch === ";" || ch === "," || ch === "!" || ch === "?") last = i;
    else if (ch === "." && isSentenceTerminator(window, i)) last = i;
  }
  return last;
}

// Clause-scoped, not just char-distance: a negation earlier in the window but in a PRIOR clause
// ("not X; the event occurred in 2005") must not negate a year in a later, unrelated clause.
function isReasonYearNegated(reason: string, yearIndex: number): boolean {
  const windowStart = Math.max(0, yearIndex - NEGATION_WINDOW);
  const window = reason.slice(windowStart, yearIndex);
  const clauseStart = lastClauseBoundary(window);
  return NEGATION_CUE_RE.test(clauseStart === -1 ? window : window.slice(clauseStart + 1));
}

// Generic clause-scoped BACKWARD negation check — not ordinal-specific despite the name; used for
// value-level negation ("900 ft not 852 ft") and reason-side checks. See D032 §9 for the claim-side
// negation-scope guard this also backs (via isClaimTokenNegated below, not used standalone there).
function isNegatedAtPosition(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - NEGATION_WINDOW);
  const window = text.slice(windowStart, matchIndex);
  const clauseStart = lastClauseBoundary(window);
  return NEGATION_CUE_RE.test(clauseStart === -1 ? window : window.slice(clauseStart + 1));
}

// D032 §9 — bidirectional, unlike isNegatedAtPosition: a claim's negation can precede OR follow its
// token ("did not end in 1943" vs "1943 is not the year it ended"), both real phrasings of the same
// assertion. Review finding: a backward-only check misses the second shape entirely (see ADR).
function isClaimTokenNegated(claimText: string, matchIndex: number, matchLength: number): boolean {
  if (isNegatedAtPosition(claimText, matchIndex)) return true;
  const afterStart = matchIndex + matchLength;
  const clauseEndAbs = firstClauseBoundaryForward(claimText, afterStart);
  const windowEnd = Math.min(afterStart + NEGATION_WINDOW, clauseEndAbs === -1 ? claimText.length : clauseEndAbs);
  return NEGATION_CUE_RE.test(claimText.slice(afterStart, windowEnd));
}

// D030 §3g/§3j follow-up — CLAUSE-scoped: every number+unit in the ordinal match's own clause, with
// each match's own text index kept (needed to check negation per-occurrence, not just per-value —
// "not 852 ft" mentions 852 without confirming it). A nearest-only single pick (this function's
// original shape) forced 3 separate false contradictions on real live traffic — a rounded
// restatement, a hallucinated near-duplicate, and (on the claim side) a claim's own parenthetical
// aside — each outranking the value that should have been compared, purely by proximity. See ADR.
function clauseValues(text: string, matchIndex: number): Array<{ value: string; unit: string; index: number }> {
  const clauseStart = lastClauseBoundary(text.slice(0, matchIndex)) + 1;
  const clauseEndAbs = firstClauseBoundaryForward(text, matchIndex);
  const clauseEnd = clauseEndAbs === -1 ? text.length : clauseEndAbs;
  const matches = [...text.slice(clauseStart, clauseEnd).matchAll(NUMBER_UNIT_RE)];
  return matches.map((m) => ({ ...toUnitValue(m), index: clauseStart + (m.index ?? 0) }));
}

// Rough sentence spans to bound the locality check below — doesn't split mid-number, no need to handle abbreviations perfectly.
function reasonSentenceSpans(reason: string): Array<{ text: string; start: number; end: number }> {
  const spans: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < reason.length; i++) {
    const ch = reason[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (!isSentenceTerminator(reason, i)) continue;
    let end = i + 1;
    while (end < reason.length && ".!?".includes(reason[end]!) && isSentenceTerminator(reason, end)) end++;
    const text = reason.slice(start, end);
    if (text.trim().length > 0) spans.push({ text, start, end });
    start = end;
  }
  const tail = reason.slice(start);
  if (tail.trim().length > 0) spans.push({ text: tail, start, end: reason.length });
  return spans;
}

export interface ReasonYearGateInput {
  claimText: string;
  verdict: Verdict;
  reason: string | null;
}

export interface ReasonYearGateResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "reason_year_mismatch" | null;
}

/** Reason/verdict check, not a second fact-verification pass: catches a different year in VERIFY's own `reason` than the claim asserts. Locality guard requires >=2 shared claim key terms in that sentence. */
export function applyReasonYearGate(input: ReasonYearGateInput): ReasonYearGateResult {
  if (input.verdict === "contradicted" || input.verdict === "unverifiable" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const claimYearMatches = [...input.claimText.matchAll(YEAR_TOKEN_RE_G)];
  if (claimYearMatches.length !== 1) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const claimYearMatch = claimYearMatches[0]!;
  const claimYear = claimYearMatch[0];
  // D032 §9/§3k — abstain on a negated claim year; see ADR for the false-accusation mechanism.
  if (isClaimTokenNegated(input.claimText, claimYearMatch.index!, claimYearMatch[0].length)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const reason = input.reason;
  const reasonYearMatches = [...reason.matchAll(YEAR_TOKEN_RE_G)];
  if (reasonYearMatches.length === 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const claimYearConfirmed = reasonYearMatches.some((m) => m[0] === claimYear && !isReasonYearNegated(reason, m.index!));
  if (claimYearConfirmed) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const claimTerms = extractKeyTerms(input.claimText);
  const sentences = reasonSentenceSpans(reason);
  const hasAssociatedAlternative = reasonYearMatches.some((m) => {
    if (m[0] === claimYear || isReasonYearNegated(reason, m.index!)) return false;
    const sentence = sentences.find((s) => m.index! >= s.start && m.index! < s.end);
    return sentence !== undefined && scoreKeyTermMatches(claimTerms, sentence.text) >= 2;
  });
  if (!hasAssociatedAlternative) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  return { verdict: "contradicted", overridden: true, reason: "reason_year_mismatch" };
}

export interface ReasonOrdinalGateInput {
  claimText: string;
  verdict: Verdict;
  reason: string | null;
}

export interface ReasonOrdinalGateResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "reason_ordinal_mismatch" | null;
}

/** Reason/verdict gate for ordinal/sequence-position mismatch (D030 §3a) — anchors on the claim's own noun phrase, not a fixed role-noun vocabulary. Confirmation takes precedence over contradiction. */

function roundDecimal(x: string, p: number): string | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(x.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? "-" : "";
  const int = m[2] || "0";
  const frac = m[3] ?? "";
  if (frac.length <= p) return `${sign}${int}.${frac.padEnd(p, "0")}`;
  const keep = BigInt(int + frac.slice(0, p));
  const rounded = frac.charCodeAt(p) >= 53 ? keep + 1n : keep;
  const t = rounded.toString().padStart(p + 1, "0");
  return `${sign}${p === 0 ? t : t.slice(0, -p)}.${p === 0 ? "" : t.slice(-p)}`;
}
function valuesAgree(a: string, b: string): boolean {
  if (a === b) return true;
  const dp = (x: string) => (x.split(".")[1] ?? "").length;
  const p = Math.min(dp(a), dp(b));
  const ra = roundDecimal(a, p), rb = roundDecimal(b, p);
  return ra !== null && rb !== null && ra === rb;
}

export function applyReasonOrdinalGate(input: ReasonOrdinalGateInput): ReasonOrdinalGateResult {
  if (input.verdict === "contradicted" || input.verdict === "unverifiable" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const claimMatches = [...input.claimText.matchAll(ORDINAL_RE_G)];
  if (claimMatches.length !== 1) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const claimMatch = claimMatches[0]!;
  // D032 §9/§3k — abstain on a negated claim ordinal; this is the case that required unfreezing
  // this gate (D030 §3k's freeze amendment). See ADR for the false-accusation mechanism.
  if (isClaimTokenNegated(input.claimText, claimMatch.index!, claimMatch[0].length)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const claimOrdinal = claimMatch[1]!.toLowerCase();
  const claimAnchor = ordinalAnchorWords(input.claimText, claimMatch.index!, claimMatch.index! + claimMatch[0].length);
  if (claimAnchor.size === 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  // Clause-scoped like the reason side (review finding) — an unscoped whole-text lookup grabbed a
  // leading unrelated number ("In 1969, the first flight covered 852 ft" -> "1969") instead of the
  // claim's own value, silently defeating the mismatch check below. Every same-clause value kept
  // (D030 §3j review finding), not just the nearest — a claim phrased with a parenthetical aside
  // ("$23.4 billion (or precisely $23.43 billion)") has the same nearest-only mispick risk the
  // reason side had; negated occurrences dropped so "not 852 ft" doesn't count as the claim's own value.
  const claimValues = clauseValues(input.claimText, claimMatch.index!).filter((v) => !isNegatedAtPosition(input.claimText, v.index));

  const reason = input.reason;
  const reasonMatches = [...reason.matchAll(ORDINAL_RE_G)];
  if (reasonMatches.length === 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  let competing = false;
  for (const m of reasonMatches) {
    const ordinal = m[1]!.toLowerCase();
    const anchor = ordinalAnchorWords(reason, m.index!, m.index! + m[0].length);
    if (!anchorsOverlap(claimAnchor, anchor)) continue;
    if (isNegatedAtPosition(reason, m.index!)) continue;
    if (ordinal === claimOrdinal) {
      // D030 §3g/§3h/§3j follow-up — same ordinal word is confirmation unless the clause has
      // same-unit values and NONE of them match ANY of the claim's own (unnegated) values. Matching
      // anywhere, not just at the nearest position, closes: a rounded restatement outranking the
      // precise value; a hallucinated near-duplicate outranking the real one; and a value negated
      // ("not 852 ft") being wrongly counted as confirming just because it's textually present — see ADR.
      const localValues = clauseValues(reason, m.index!).filter((v) => !isNegatedAtPosition(reason, v.index));
      const hasSameUnitPair = localValues.some((lv) => claimValues.some((cv) => cv.unit === lv.unit));
      const hasMatch = localValues.some((lv) => claimValues.some((cv) => cv.unit === lv.unit && valuesAgree(cv.value, lv.value)));
      if (hasSameUnitPair && !hasMatch) {
        competing = true;
        continue;
      }
      // Confirmation found — takes precedence, return immediately (data-model.md §1 step 4).
      return { verdict: input.verdict, overridden: false, reason: null };
    }
    competing = true;
  }

  if (!competing) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" };
}

export interface SubjectEntityGateInput {
  verdict: Verdict;
  claimText: string;
  // "" when EXTRACT gave none — falls back to claimText, same as the rerank prompt's own fallback.
  subjectEntity: string;
  evidence: string | null;
}

export interface SubjectEntityGateResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "subject_entity_mismatch" | null;
}

/** Deterministic backstop for g17 — downgrades supported/partially_supported when evidence shares no proper noun with the claim's subject (D030). */
export function applySubjectEntityGate(input: SubjectEntityGateInput): SubjectEntityGateResult {
  if (input.verdict !== "supported" && input.verdict !== "partially_supported") {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  if (!input.evidence) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  // Guards undefined too, not just "" — untyped test fixtures can hit this at runtime.
  const anchor = input.subjectEntity && input.subjectEntity.trim().length > 0 ? input.subjectEntity : input.claimText;
  if (sameEntity(anchor, input.evidence)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "unverifiable", overridden: true, reason: "subject_entity_mismatch" };
}

// D031 — reason/verdict incoherence backstop; regex over VERIFY's own closed vocabulary, see ADR for AGENTS.md rule 12 tradeoff.
const AFFIRMATIVE_SOURCE_LANGUAGE_RE = /\b(?:sources?|passages?|evidence)\b[^.!?]{0,60}\b(?:states?|confirms?|indicates?|shows?|supports?|reports?)\b/i;
const UNGROUNDED_REASON_NEGATION_WORD_RE = /\bnot\b|n't|\bno\b|\bnone\b|\bnever\b|\bcannot\b|\bcan't\b/i;
// D032 §5/T7 — states both that evidence is missing AND that this isn't a falsehood finding (SC-2).
const UNGROUNDED_REASON_REPLACEMENT =
  "The available sources did not provide a specific passage that could be cited to verify this claim. This is not a finding that the claim is false — only that supporting evidence could not be confirmed.";

/** D031 — rewrites `reason` only, never verdict/confidence/citations; negation checked inside the match span itself, not a preceding window. */
export function rewriteUngroundedAffirmativeReason(verdict: Verdict, citationsCount: number, reason: string | null): string | null {
  if (verdict !== "unsupported" && verdict !== "unverifiable") return reason;
  if (citationsCount > 0) return reason;
  if (!reason) return reason;
  const match = AFFIRMATIVE_SOURCE_LANGUAGE_RE.exec(reason);
  if (!match) return reason;
  if (UNGROUNDED_REASON_NEGATION_WORD_RE.test(match[0])) return reason;
  return UNGROUNDED_REASON_REPLACEMENT;
}

// D032 §3f/T6b — labels subject_entity's downgrade distinctly; gate behaviour unchanged (D030 §3l/§3m stand).
const SUBJECT_ENTITY_DOWNGRADE_SUFFIX =
  " Evidence was found but could not be confirmed as being about this claim's specific subject — this is not a finding that no evidence exists.";

/** D032 §3f/T6b — appends a distinguishing note when `unverifiable` came from subject_entity, not from a genuine absence of evidence. */
export function labelSubjectEntityDowngrade(verdict: Verdict, gateEvents: readonly { gate: string; overridden: boolean }[], reason: string | null): string | null {
  if (verdict !== "unverifiable" || !reason) return reason;
  if (!gateEvents.some((e) => e.gate === "subject_entity" && e.overridden)) return reason;
  return reason + SUBJECT_ENTITY_DOWNGRADE_SUFFIX;
}

/** D032 §3f/T6b (review finding) — subject_entity takes precedence over the D031 rewrite below: it
 * also nulls evidence/citations, so both rules' preconditions can hold at once, and running both
 * produced a self-contradictory reason ("no evidence found" + "evidence was found"). Composed here,
 * not left as caller-side ordering, so the precedence can't silently drift out of sync again. */
export function composeUserFacingReason(
  verdict: Verdict,
  gateEvents: readonly { gate: string; overridden: boolean }[],
  citationsCount: number,
  reason: string | null
): string | null {
  const subjectEntityCausedThis = gateEvents.some((e) => e.gate === "subject_entity" && e.overridden);
  return subjectEntityCausedThis
    ? labelSubjectEntityDowngrade(verdict, gateEvents, reason)
    : rewriteUngroundedAffirmativeReason(verdict, citationsCount, reason);
}
