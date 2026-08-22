import { compare } from "../../numbers/compare.js";
import { extractNumericFact, CONTRADICTION_LANGUAGE_RE, NEGATED_CONTRADICTION_RE } from "../audit/verify-reconcilers.js";
import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import {
  isSentenceTerminator,
  anchorWords as ordinalAnchorWords,
  anchorsOverlap,
  SEQUENCE_SELECTOR_WORDS as ORDINAL_WORDS,
  SELECTOR_RE_G as ORDINAL_RE_G,
} from "../../lib/instance-selector.js";
import type { GrounnelVerdictEnum } from "../../contracts/grounnel.schemas.js";
import type { z } from "zod";

type Verdict = z.infer<typeof GrounnelVerdictEnum>;

export interface ReasonConsistencyInput {
  verdict: Verdict;
  reason: string | null;
}

export interface ReasonConsistencyResult {
  verdict: Verdict;
  overridden: boolean;
  // Machine-readable code for why this gate acted — null when overridden is false (D023 §5).
  reason: "contradiction_language_in_model_reason" | null;
}

/** Forces `contradicted` when the model's own reason asserts a contradiction but the verdict doesn't. `unverifiable` excluded (D026 §22) — it's a CONFIDENCE downgrade. */
export function applyReasonConsistencyGate(input: ReasonConsistencyInput): ReasonConsistencyResult {
  if (input.verdict === "contradicted" || input.verdict === "unverifiable" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  if (!CONTRADICTION_LANGUAGE_RE.test(input.reason) || NEGATED_CONTRADICTION_RE.test(input.reason)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "contradicted", overridden: true, reason: "contradiction_language_in_model_reason" };
}

export interface ImplicitNegationInput {
  verdict: Verdict;
  reason: string | null;
  claimText: string;
  passageText: string;
}

export interface ImplicitNegationResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "bare_negation_matched" | null;
}

// Bare "X, not Y" correction with no contradiction verb (D022 §2, g05). Y must be capitalized so the match stops at the entity, not trailing lowercase words.
const IMPLICIT_NEGATION_RE = /,\s*not\s+(?:the\s+)?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,2})/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case A gate (D022 §4) — bare "X, not Y" negation applyReasonConsistencyGate misses. Condition 3 trades recall for precision by design. */
export function applyImplicitNegationGate(input: ImplicitNegationInput): ImplicitNegationResult {
  // Only "unsupported" is in scope — the other verdicts either already cover this or shouldn't be overridden (D022 §4).
  if (input.verdict !== "unsupported" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const match = IMPLICIT_NEGATION_RE.exec(input.reason);
  if (!match) return { verdict: input.verdict, overridden: false, reason: null };

  const y = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
  const yInClaim = new RegExp(`\\b${escapeRegExp(y)}\\b`, "i").test(input.claimText);
  if (!yInClaim) return { verdict: input.verdict, overridden: false, reason: null };

  // Y's own words are excluded individually, not as one string — a multi-word Y must not double as the second entity condition 3 requires.
  const yWords = new Set(y.split(/\s+/));
  const passageLower = input.passageText.toLowerCase();
  const hasSecondEntity = extractKeyTerms(input.claimText)
    .filter((term) => !yWords.has(term))
    .some((term) => passageLower.includes(term));
  if (!hasSecondEntity) return { verdict: input.verdict, overridden: false, reason: null };

  return { verdict: "contradicted", overridden: true, reason: "bare_negation_matched" };
}

// Also strips smart quotes/dashes (’‘“”–—) — LLM JSON output commonly straightens these even
// when quoting "verbatim" from web prose that renders them typographically.
const PUNCTUATION_RE = /[.,!?;:"'()‘’“”–—]/g;

/** Exact substring after whitespace/punctuation normalization only — never fuzzy/semantic (D019 §2). */
function normalizeForSubstringCheck(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION_RE, "").replace(/\s+/g, " ").trim();
}

// Model sometimes joins two real, non-adjacent excerpts with "..." (g04) — split on it, not just strip it, so each fragment can be checked independently.
const EVIDENCE_ELLIPSIS_RE = /\.{3,}|…/g;

/** Every fragment (split on an ellipsis) must independently be a real, contiguous substring — still rejects a fabricated fragment, just allows a non-contiguous multi-excerpt span (D019 §2). */
function evidenceMatchesPassage(evidence: string, passageText: string): boolean {
  const normalizedPassage = normalizeForSubstringCheck(passageText);
  const fragments = evidence
    .split(EVIDENCE_ELLIPSIS_RE)
    .map((f) => normalizeForSubstringCheck(f))
    .filter((f) => f.length > 0);
  return fragments.length > 0 && fragments.every((f) => normalizedPassage.includes(f));
}

export interface CounterfactIgnoredInput {
  verdict: Verdict;
  /** Batched LLM classifier result — see D025 §2 for what feeds this and why it can be null. */
  reasonSupportsVerdict: boolean | null;
}

export interface CounterfactIgnoredResult {
  flagged: boolean;
  reason: "counterfact_ignored" | null;
}

/** Gate #5 (D025 §2) — flags only, never changes verdict itself, unlike gates #1-4. */
export function applyCounterfactIgnoredGate(input: CounterfactIgnoredInput): CounterfactIgnoredResult {
  // Reviewed finding: stated positively — flag only on an explicit "no", not on null/true.
  if (input.verdict !== "contradicted" && input.reasonSupportsVerdict === false) {
    return { flagged: true, reason: "counterfact_ignored" };
  }
  return { flagged: false, reason: null };
}

export interface ClaimReasonOverlapInput {
  verdict: Verdict;
  reason: string | null;
  claimText: string;
}

export interface ClaimReasonOverlapResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "claim_reason_no_overlap" | null;
}

/** Gate #1b — cross-claim contamination backstop: a batched VERIFY call answering one claim with another's reasoning still passes gate #1's grounding check. Reuses extractKeyTerms (D026 §6). */
export function applyClaimReasonOverlapGate(input: ClaimReasonOverlapInput): ClaimReasonOverlapResult {
  if (input.verdict !== "contradicted" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const terms = extractKeyTerms(input.claimText);
  if (terms.length === 0) return { verdict: input.verdict, overridden: false, reason: null };
  if (scoreKeyTermMatches(terms, input.reason) > 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "unsupported", overridden: true, reason: "claim_reason_no_overlap" };
}

export interface GateOneInput {
  verdict: Verdict;
  evidence: string | null;
  passageText: string;
}

export interface GateOneResult {
  verdict: Verdict;
  evidence: string | null;
  overridden: boolean;
  // Downgrade-only: "evidence_null" (no evidence given) vs "evidence_not_grounded" (D023 §5).
  reason: "evidence_null" | "evidence_not_grounded" | null;
}

/** Gate #1 — contradiction evidence gate (D019 §2, tasks.md T003). Only fires on `contradicted`. */
export function applyContradictionEvidenceGate(input: GateOneInput): GateOneResult {
  if (input.verdict !== "contradicted") {
    return { verdict: input.verdict, evidence: input.evidence, overridden: false, reason: null };
  }
  // Trimmed, not just truthy — a whitespace-only string is truthy but carries no real content.
  const hasContent = !!input.evidence?.trim();
  const evidenceOk = hasContent && evidenceMatchesPassage(input.evidence!, input.passageText);
  if (evidenceOk) {
    return { verdict: input.verdict, evidence: input.evidence, overridden: false, reason: null };
  }
  return {
    verdict: "unsupported",
    evidence: null,
    overridden: true,
    reason: hasContent ? "evidence_not_grounded" : "evidence_null",
  };
}

export interface GateTwoInput {
  claimText: string;
  verdict: Verdict;
  evidence: string | null;
  // D030 §3d — true only when reason_ordinal produced the current "contradicted"; blocks a numeric MATCH from overriding it.
  contradictionProtectedFromForceSupported?: boolean;
}

export interface GateTwoResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "threshold_comparison" | "equality_comparison" | null;
}

// g11: "surpassed $3.5T" vs evidence "$3.57T" was marked contradicted by equality-only comparison; compare()'s direction field fixes it.
// D026 §22/T064 — strict ("exceeded") and inclusive ("at least") comparators split: an exact match only satisfies the inclusive wording.
const AT_LEAST_STRICT_RE = /\b(surpassed|exceeded|topped|crossed|more than|greater than|over|above)\b/i;
const AT_LEAST_INCLUSIVE_RE = /\bat least\b/i;
const AT_MOST_STRICT_RE = /\b(less than|fewer than|under|below)\b/i;
const AT_MOST_INCLUSIVE_RE = /\b(at most|no more than)\b/i;

type ThresholdKind = "at_least_strict" | "at_least_inclusive" | "at_most_strict" | "at_most_inclusive";

function detectThreshold(claimText: string): ThresholdKind | null {
  if (AT_LEAST_STRICT_RE.test(claimText)) return "at_least_strict";
  if (AT_LEAST_INCLUSIVE_RE.test(claimText)) return "at_least_inclusive";
  if (AT_MOST_STRICT_RE.test(claimText)) return "at_most_strict";
  if (AT_MOST_INCLUSIVE_RE.test(claimText)) return "at_most_inclusive";
  return null;
}

// Excludes a decimal ("2024.5") and a preceding "$" so "$1998" isn't misread as a year (D026 §5).
const YEAR_RE = /(?<![\d.$])(?:19|20)\d{2}(?!\d)(?!\.\d)/g;

// Gate #2's temporal-comparability guard — deliberately conservative, known duplication/cost tradeoffs. See D026 §5.
function yearsConflict(claimText: string, evidenceText: string): boolean {
  const claimYears = new Set(claimText.match(YEAR_RE) ?? []);
  if (claimYears.size === 0) return false;
  return (evidenceText.match(YEAR_RE) ?? []).some((y) => !claimYears.has(y));
}

// extractNumericFact only returns its FIRST match; abstain when a second, unrelated number is also present (D026 §7).
const NUMERIC_TOKEN_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%/g;
function hasAmbiguousNumericEvidence(evidenceText: string): boolean {
  return (evidenceText.match(NUMERIC_TOKEN_RE) ?? []).length > 1;
}

/** Gate #2 — numeric normalization/comparison in code (D019 §2). Row/table-matching and structured period detection are out of scope (T004/D026 §5). */
export function applyNumericGate(input: GateTwoInput): GateTwoResult {
  if (!input.evidence) return { verdict: input.verdict, overridden: false, reason: null };

  const claimFact = extractNumericFact(input.claimText);
  const evidenceFact = extractNumericFact(input.evidence);
  if (!claimFact || !evidenceFact) return { verdict: input.verdict, overridden: false, reason: null };

  const comparison = compare(claimFact, evidenceFact);
  if (!comparison.comparable) return { verdict: input.verdict, overridden: false, reason: null };

  if (yearsConflict(input.claimText, input.evidence)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  if (hasAmbiguousNumericEvidence(input.evidence)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  // D030 §3d — a numeric MATCH must not excuse a mismatch reason_ordinal already found; scoped narrowly, not a blanket block like applyYearGate's.
  const canForceSupported = input.verdict !== "supported" && !input.contradictionProtectedFromForceSupported;

  const threshold = detectThreshold(input.claimText);
  if (threshold) {
    // direction is sign(claim - source). Strict wording only holds on a real difference; inclusive wording also holds on an exact match.
    const holds =
      threshold === "at_least_strict"
        ? comparison.direction < 0
        : threshold === "at_least_inclusive"
          ? comparison.direction <= 0
          : threshold === "at_most_strict"
            ? comparison.direction > 0
            : comparison.direction >= 0;
    if (holds && canForceSupported) return { verdict: "supported", overridden: true, reason: "threshold_comparison" };
    if (!holds && input.verdict !== "contradicted") return { verdict: "contradicted", overridden: true, reason: "threshold_comparison" };
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  if (comparison.equal === null) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  if (comparison.equal && canForceSupported) {
    return { verdict: "supported", overridden: true, reason: "equality_comparison" };
  }
  if (!comparison.equal && input.verdict !== "contradicted") {
    return { verdict: "contradicted", overridden: true, reason: "equality_comparison" };
  }
  return { verdict: input.verdict, overridden: false, reason: null };
}

// ─── Gate #2b — year/date comparison (D028-adjacent live-run finding, 2026-08-13) ─────────────

export interface YearGateInput {
  claimText: string;
  verdict: Verdict;
  evidence: string | null;
}

export interface YearGateResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "year_role_match" | "year_role_mismatch" | null;
}

// Kept separate from audit/table-parse.ts's near-identical month list — avoids widening coupling to `audit` for one static array.
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ALT = MONTH_NAMES.join("|");
// Wider than gate #2's YEAR_RE — birth years for people-claims commonly fall in the 1700s/1800s.
const YEAR_TOKEN = "(?:1[5-9]\\d{2}|20\\d{2})";
const FULL_DATE_MDY_RE = new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2}),?\\s+(${YEAR_TOKEN})\\b`, "i");
const FULL_DATE_DMY_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})\\s+(${YEAR_TOKEN})\\b`, "i");

interface FullDate {
  month: string;
  day: string;
  year: string;
}

function extractFullDate(text: string): FullDate | null {
  const mdy = FULL_DATE_MDY_RE.exec(text);
  if (mdy) return { month: mdy[1]!.toLowerCase(), day: mdy[2]!, year: mdy[3]! };
  const dmy = FULL_DATE_DMY_RE.exec(text);
  if (dmy) return { month: dmy[2]!.toLowerCase(), day: dmy[1]!, year: dmy[3]! };
  return null;
}

// A list, not a fixed {birth, death} shape, so a future role is additive.
interface TemporalRoleFact {
  role: string;
  year: string;
}

// A "(YYYY–YYYY)" parenthetical immediately after a name is this codebase's own recognized
// bio-range convention (EXTRACT's prompt already calls this shape out for birth/death splitting).
const BIRTH_DEATH_RANGE_RE = new RegExp(`\\(\\s*(${YEAR_TOKEN})\\s*[–-]\\s*(${YEAR_TOKEN})\\s*\\)`);

// `established` folded into `founding`; `reclassified`/`launched`/`released` added after a Pluto-reclassification miss.
const ROLE_KEYWORDS: Array<{ re: RegExp; role: string }> = [
  { re: /\b(?:born|birth)\b/i, role: "birth" },
  { re: /\b(?:died|death|passed away)\b/i, role: "death" },
  { re: /\b(?:founded|founding|established)\b/i, role: "founding" },
  { re: /\b(?:published|publication)\b/i, role: "published" },
  { re: /\b(?:reclassified|reclassification)\b/i, role: "reclassified" },
  { re: /\b(?:launched|launch)\b/i, role: "launched" },
  { re: /\b(?:released|release)\b/i, role: "released" },
];

// How far (chars) a role keyword may sit from the year it anchors — widened to 80 to reach the Pluto claim's 74-char gap; 100 reproduced a live regression on a different-entity year nearby.
const ROLE_YEAR_WINDOW = 80;
// \b on both sides — without it this matched a year-shaped substring inside a longer digit run.
const YEAR_TOKEN_RE_G = new RegExp(`\\b${YEAR_TOKEN}\\b`, "g");

// Known, accepted limitation: only the FIRST occurrence of each role keyword is used, so multiple people in one text could anchor to the wrong one. sameEntity's overlap check mitigates, doesn't fully fix.
function extractTemporalRoleFacts(text: string): TemporalRoleFact[] {
  const facts: TemporalRoleFact[] = [];
  const rangeMatch = BIRTH_DEATH_RANGE_RE.exec(text);
  if (rangeMatch) {
    facts.push({ role: "birth", year: rangeMatch[1]! });
    facts.push({ role: "death", year: rangeMatch[2]! });
  }
  for (const { re, role } of ROLE_KEYWORDS) {
    const kwMatch = re.exec(text);
    if (!kwMatch) continue;
    const windowStart = Math.max(0, kwMatch.index - ROLE_YEAR_WINDOW);
    const windowEnd = Math.min(text.length, kwMatch.index + kwMatch[0].length + ROLE_YEAR_WINDOW);
    const window = text.slice(windowStart, windowEnd);
    const keywordOffsetInWindow = kwMatch.index - windowStart;
    // Nearest year wins, not just the first in the window — a window can legitimately contain a farther role's year too.
    let nearest: { year: string; distance: number } | null = null;
    for (const yearMatch of window.matchAll(YEAR_TOKEN_RE_G)) {
      const distance = Math.abs(yearMatch.index! - keywordOffsetInWindow);
      if (!nearest || distance < nearest.distance) nearest = { year: yearMatch[0], distance };
    }
    if (nearest) facts.push({ role, year: nearest.year });
  }
  return facts;
}

// Coarse entity guard — abstains when claim and evidence name disjoint proper nouns. Known,
// accepted gap: two people sharing a surname (father/son) still overlap and won't be caught.
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z'-]+\b/g;
// Month names are capitalized proper-noun-shaped tokens too, and these date-heavy pairs would otherwise defeat this guard on a shared month alone.
const SENTENCE_START_STOPWORDS = new Set(
  ["the", "he", "she", "they", "his", "her", "their", "a", "an", "in", "on", "at", "this", "that", "its", ...MONTH_NAMES].map((w) => w.toLowerCase())
);

function properNounWords(text: string): Set<string> {
  const words = text.match(PROPER_NOUN_RE) ?? [];
  // Strips a trailing singular possessive ('s) so "Nauru's" set-matches bare "Nauru" (g17). Plural
  // possessives ("Wrights'") are a known, accepted gap — "Kansas'" vs "Wrights'" are indistinguishable text-only.
  return new Set(
    words
      .map((w) => w.toLowerCase().replace(/'s?$/, ""))
      .filter((w) => !SENTENCE_START_STOPWORDS.has(w))
  );
}

// Shared by both detectors. Abstains only when BOTH sides name at least one proper noun and share none — pronoun-only text is left to the date comparison alone.
function sameEntity(claimText: string, evidenceText: string): boolean {
  const claimNames = properNounWords(claimText);
  const evidenceNames = properNounWords(evidenceText);
  if (claimNames.size === 0 || evidenceNames.size === 0) return true;
  return [...claimNames].some((n) => evidenceNames.has(n));
}

// Only gates the forced-`supported` direction — a wrong value is wrong regardless of hedging, so `contradicted` is never held back by this.
const HEDGE_RE = /\b(reportedly|allegedly|disputed|unclear|unreliable|unconfirmed|some sources)\b/i;

/** Gate #2b — narrower than a generic "any differing year": only acts on a shared structural marker (month+day, or same temporal role), never bare year proximity. extractNumericFact never reaches bare years. */
export function applyYearGate(input: YearGateInput): YearGateResult {
  if (!input.evidence) return { verdict: input.verdict, overridden: false, reason: null };
  const evidence = input.evidence;

  // The forced-`supported` direction must leave an existing `contradicted` alone — a date MATCH doesn't excuse a mismatch on a different fact in the same claim. Forced-`contradicted` stays unconditional.
  const canForceSupported = (verdict: Verdict) => verdict !== "supported" && verdict !== "contradicted";

  if (!sameEntity(input.claimText, evidence)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  // Detector 1 — same month+day, different year.
  const claimDate = extractFullDate(input.claimText);
  const evidenceDate = extractFullDate(evidence);
  if (claimDate && evidenceDate && claimDate.month === evidenceDate.month && Number(claimDate.day) === Number(evidenceDate.day)) {
    if (claimDate.year !== evidenceDate.year) {
      if (input.verdict !== "contradicted") return { verdict: "contradicted", overridden: true, reason: "year_role_mismatch" };
      return { verdict: input.verdict, overridden: false, reason: null };
    }
    if (!HEDGE_RE.test(evidence) && canForceSupported(input.verdict)) {
      return { verdict: "supported", overridden: true, reason: "year_role_match" };
    }
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  // Detector 2 — role-anchored year comparison.
  const claimFacts = extractTemporalRoleFacts(input.claimText);
  const evidenceFacts = extractTemporalRoleFacts(evidence);
  if (claimFacts.length === 0 || evidenceFacts.length === 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  let sawMismatch = false;
  let sawMatch = false;
  for (const claimFact of claimFacts) {
    for (const evidenceFact of evidenceFacts) {
      if (claimFact.role !== evidenceFact.role) continue;
      if (claimFact.year === evidenceFact.year) sawMatch = true;
      else sawMismatch = true;
    }
  }

  if (sawMismatch) {
    if (input.verdict !== "contradicted") return { verdict: "contradicted", overridden: true, reason: "year_role_mismatch" };
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  if (sawMatch && !HEDGE_RE.test(evidence) && canForceSupported(input.verdict)) {
    return { verdict: "supported", overridden: true, reason: "year_role_match" };
  }
  return { verdict: input.verdict, overridden: false, reason: null };
}

// ─── Reason/verdict consistency gate — year mismatch (candidate; not wired into runGateChain,
// see tasks.md Phase 35/36) ─────────────────────────────────────────────────────────────────

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

// Window sized off a real captured VERIFY reason with margin. "n't" has no leading \b (contractions), same fix NEGATED_CONTRADICTION_RE applies.
const REASON_YEAR_NEGATION_WORD_RE = /\bnot\b|n't|\bno\b|\bnone\b|\bnever\b/i;
const REASON_YEAR_NEGATION_WINDOW = 60;

// isSentenceTerminator moved to lib/instance-selector.ts (D030 §3f) — shared with the retrieval
// selector signal now, imported above. Still used here (year/ordinal negation windows below).

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
  const windowStart = Math.max(0, yearIndex - REASON_YEAR_NEGATION_WINDOW);
  const window = reason.slice(windowStart, yearIndex);
  const clauseStart = lastClauseBoundary(window);
  return REASON_YEAR_NEGATION_WORD_RE.test(clauseStart === -1 ? window : window.slice(clauseStart + 1));
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

/** Reason/verdict check, not a second fact-verification pass: catches a different year in VERIFY's own `reason` than the claim asserts. Locality guard requires >=2 shared claim key terms in that sentence. */
export function applyReasonYearGate(input: ReasonYearGateInput): ReasonYearGateResult {
  if (input.verdict === "contradicted" || input.verdict === "unverifiable" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const claimYears = [...input.claimText.matchAll(YEAR_TOKEN_RE_G)].map((m) => m[0]);
  if (claimYears.length !== 1) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const claimYear = claimYears[0]!;

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

// ─── Reason/verdict consistency gate — ordinal mismatch (D030, tasks.md T002/T003) ──────────

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

// ORDINAL_WORDS/ORDINAL_RE_G/ordinalAnchorWords/anchorsOverlap moved to lib/instance-selector.ts (D030 §3f) — shared, behavior unchanged.

// Same clause-scoped negation approach as isReasonYearNegated (reuses lastClauseBoundary); window matches the year gate's own 60-char constant.
const ORDINAL_NEGATION_WORD_RE = /\bnot\b|n't|\bno\b|\bnone\b|\bnever\b/i;
const ORDINAL_NEGATION_WINDOW = 60;

function isOrdinalNegated(reason: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - ORDINAL_NEGATION_WINDOW);
  const window = reason.slice(windowStart, matchIndex);
  const clauseStart = lastClauseBoundary(window);
  return ORDINAL_NEGATION_WORD_RE.test(clauseStart === -1 ? window : window.slice(clauseStart + 1));
}

/** Reason/verdict gate for ordinal/sequence-position mismatch (D030 §3a) — anchors on the claim's own noun phrase, not a fixed role-noun vocabulary. Confirmation takes precedence over contradiction. */
export function applyReasonOrdinalGate(input: ReasonOrdinalGateInput): ReasonOrdinalGateResult {
  if (input.verdict === "contradicted" || input.verdict === "unverifiable" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const claimMatches = [...input.claimText.matchAll(ORDINAL_RE_G)];
  if (claimMatches.length !== 1) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  const claimMatch = claimMatches[0]!;
  const claimOrdinal = claimMatch[1]!.toLowerCase();
  const claimAnchor = ordinalAnchorWords(input.claimText, claimMatch.index!, claimMatch.index! + claimMatch[0].length);
  if (claimAnchor.size === 0) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

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
    if (isOrdinalNegated(reason, m.index!)) continue;
    if (ordinal === claimOrdinal) {
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

