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

/**
 * Forces verdict to `contradicted` when the model's own reason asserts a contradiction but the
 * verdict says otherwise — reuses audit's hardened CONTRADICTION_LANGUAGE_RE (D018 §5.5) rather
 * than a fresh regex. Real live-eval failures (2026-08-06): reason explicitly said "contradicts"/
 * "not Canada" while verdict landed on `unsupported`.
 *
 * One direction only, deliberately: the opposite (reason argues support, verdict says
 * contradicted — also observed live) has no equivalent hardened detector in this codebase yet.
 * A fresh "support-language" regex now would repeat the exact under-tested-heuristic mistake
 * this file's own incident history warns against — a named, not silently dropped, gap.
 *
 * D026 §22, real bug: `unverifiable` is excluded for the same reason applyImplicitNegationGate
 * already excludes it — it's the CONFIDENCE section's deliberate downgrade of a low-confidence
 * relationship, not a different relationship judgment. The reason text still legitimately
 * describes the underlying (possibly CONFLICT-shaped) relationship per the verify prompt's own
 * STEP1-3 binding rule, so without this exclusion this gate was force-flipping every low-confidence
 * conflict read straight back into a hard `contradicted` — the exact high-certainty false positive
 * the CONFIDENCE downgrade exists to prevent.
 */
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

// Matches a bare "X, not Y" correction with no contradiction verb — the shape
// applyReasonConsistencyGate deliberately doesn't catch (D022 §2, real gap: g05). Y's words must
// be capitalized (entity-shaped) so the match stops at the entity instead of swallowing trailing
// lowercase words ("not Canada to the United States" would otherwise capture "Canada to the").
const IMPLICIT_NEGATION_RE = /,\s*not\s+(?:the\s+)?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,2})/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case A gate (D022 §4) — bare "X, not Y" negation applyReasonConsistencyGate misses. Condition
 * 3 trades recall for precision by deliberate design — see D022 §4 before weakening it.
 */
export function applyImplicitNegationGate(input: ImplicitNegationInput): ImplicitNegationResult {
  // Only "unsupported" is in scope: "contradicted" is already there, "unverifiable" is a
  // confidence downgrade this gate shouldn't override, "supported" would mean firing on a
  // narrative correction the model already resolved correctly (D022 §4 review finding).
  if (input.verdict !== "unsupported" || !input.reason) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }

  const match = IMPLICIT_NEGATION_RE.exec(input.reason);
  if (!match) return { verdict: input.verdict, overridden: false, reason: null };

  const y = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
  const yInClaim = new RegExp(`\\b${escapeRegExp(y)}\\b`, "i").test(input.claimText);
  if (!yInClaim) return { verdict: input.verdict, overridden: false, reason: null };

  // Y's own words are excluded individually, not as one string — a multi-word Y ("United
  // Kingdom") must not let its own constituent words ("united", "states") count as the second,
  // independent entity condition 3 requires (D022 §4 review finding).
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

// Matches "..." or the single-character "…" the model sometimes uses to join two real, non-adjacent
// excerpts from the same passage into one evidence string (a live-eval finding, 2026-08-07, g04:
// "Germany invades Poland ... Japan formally surrenders", both real, ~1000 words apart in the
// source's dated timeline). Splitting on it, not just stripping it, matters — PUNCTUATION_RE alone
// would collapse the gap and require the two genuinely non-adjacent fragments to be contiguous.
const EVIDENCE_ELLIPSIS_RE = /\.{3,}|…/g;

/**
 * Every fragment (split on an ellipsis) must independently be a real, contiguous substring of the
 * passage — still rejects a single fabricated fragment, doesn't weaken gate #1's hallucination
 * check, just stops requiring multi-excerpt evidence to be one unbroken span (D019 §2, live-eval).
 */
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

/**
 * Gate #1b — cross-claim contamination backstop, deterministic (real live-test finding, 2026-08-10:
 * a batched VERIFY call answered the Marie Curie claim with Camp David Accords' reasoning verbatim,
 * citing real — but topically unrelated — evidence resolved from Marie Curie's OWN passage, so
 * gate #1's verbatim-grounding check passed it clean). Reuses extractKeyTerms/scoreKeyTermMatches
 * (D026 §6) rather than a new heuristic — same fail-open convention: no key terms extracted from the
 * claim, nothing to check, gate abstains. `contradicted`-only, same asymmetric scope as gate #1.
 */
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
  // Trimmed, not just truthy — a whitespace-only string ("  ") is truthy but carries no real
  // content, same as null (reviewed finding: naive `!!input.evidence` misclassified it as grounded).
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
  // D030 §3d — true only when `verdict === "contradicted"` was produced by reason_ordinal
  // specifically; blocks a numeric MATCH from forcing "supported" over it. Every other caller
  // omits this (undefined/falsy), leaving gate #2's existing raw-VERIFY-contradicted correction
  // behavior (e.g. the g11 threshold cases) untouched.
  contradictionProtectedFromForceSupported?: boolean;
}

export interface GateTwoResult {
  verdict: Verdict;
  overridden: boolean;
  reason: "threshold_comparison" | "equality_comparison" | null;
}

// A real live-eval failure (g11, 2026-08-06): "surpassed $3.5 trillion" against evidence stating
// $3.57 trillion got marked contradicted — the equality-only comparison below treated "3.5 ≠ 3.57"
// as confirming a mismatch, with no concept of threshold claims where a HIGHER evidence value means
// the claim holds, not that it's wrong. `compare()`'s own `direction` field already carries what's
// needed to fix this; it just wasn't used here before.
// D026 §22/T064, real bug found in self-review: strict comparators ("exceeded") and inclusive
// comparators ("at least") were previously grouped under one regex/one `holds` formula, so
// evidence exactly equal to the claimed value wrongly satisfied "exceeded" — an exact match
// only satisfies the INCLUSIVE wording, never the strict one. Split accordingly; mirrored for at_most.
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

// Reviewed finding — excludes a decimal ("2024.5") but not a sentence-ending period, and excludes
// a preceding "$" so "$1998" isn't misread as a year (D026 §5).
const YEAR_RE = /(?<![\d.$])(?:19|20)\d{2}(?!\d)(?!\.\d)/g;

// Gate #2's temporal-comparability guard — deliberately conservative, known duplication/cost tradeoffs. See D026 §5.
function yearsConflict(claimText: string, evidenceText: string): boolean {
  const claimYears = new Set(claimText.match(YEAR_RE) ?? []);
  if (claimYears.size === 0) return false;
  return (evidenceText.match(YEAR_RE) ?? []).some((y) => !claimYears.has(y));
}

// Reviewed finding (D026 §7) — extractNumericFact only ever returns its FIRST match; whole-sentence
// evidence (T043) makes a second, unrelated number in the same sentence common. Abstain when
// ambiguous rather than risk comparing against the wrong one, same precedent as yearsConflict.
const NUMERIC_TOKEN_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%/g;
function hasAmbiguousNumericEvidence(evidenceText: string): boolean {
  return (evidenceText.match(NUMERIC_TOKEN_RE) ?? []).length > 1;
}

/**
 * Gate #2 — numeric normalization/comparison in code (D019 §2, T004). Row/table-matching and full
 * structured period detection are out of scope, see T004/D026 §5 for why.
 */
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

  // Reviewed finding (D030 §3d, 2026-08-21): a numeric MATCH must not excuse a genuine mismatch
  // reason_ordinal already found on a DIFFERENT fact in the same claim ("the third trial showed
  // 40%" vs. reason "the first trial showed 40%" — same %, different ordinal) — but unlike
  // applyYearGate's blanket canForceSupported, this can't block EVERY existing "contradicted": gate
  // #2's own tests (g11, 2026-08-06) rely on correcting a raw, ungated VERIFY "contradicted" to
  // "supported" when the actual numbers satisfy the claim. Only a contradiction reason_ordinal
  // itself produced is protected — narrowly scoped to that one gate, not "contradicted" in general.
  const canForceSupported = input.verdict !== "supported" && !input.contradictionProtectedFromForceSupported;

  const threshold = detectThreshold(input.claimText);
  if (threshold) {
    // direction is sign(claim - source). Strict wording ("exceeded") only holds on a real
    // difference (direction !== 0 in the required sense); inclusive wording ("at least") also
    // holds on an exact match (direction === 0) — see the D026 §22/T064 comment above detectThreshold.
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

// A near-identical month list exists in audit/table-parse.ts's DATE_RE (table-column detection, a
// different concern) — kept separate deliberately rather than a new cross-orchestrator import for
// one static array, matching this file's existing preference not to widen its coupling to `audit`.
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ALT = MONTH_NAMES.join("|");
// Wider than gate #2's own YEAR_RE (19xx/20xx only) — deliberately scoped to just this gate's
// regexes, not a change to YEAR_RE's existing behavior elsewhere in this file. Birth years for
// people-claims (the motivating real case) commonly fall in the 1700s/1800s.
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

// Generalized role/year extractor (review finding on the design plan) — a list, not a fixed
// {birth, death} shape, so a future role (founding, publication) is additive, not a reshape.
interface TemporalRoleFact {
  role: string;
  year: string;
}

// A "(YYYY–YYYY)" parenthetical immediately after a name is this codebase's own recognized
// bio-range convention (EXTRACT's prompt already calls this shape out for birth/death splitting).
const BIRTH_DEATH_RANGE_RE = new RegExp(`\\(\\s*(${YEAR_TOKEN})\\s*[–-]\\s*(${YEAR_TOKEN})\\s*\\)`);

// `established` folded into `founding` (same concept, needs to match the same role string on
// both sides) — `reclassified`/`launched`/`released` are new roles, added after a real live-run
// miss (Pluto reclassification year) where the gate abstained entirely for want of a keyword.
const ROLE_KEYWORDS: Array<{ re: RegExp; role: string }> = [
  { re: /\b(?:born|birth)\b/i, role: "birth" },
  { re: /\b(?:died|death|passed away)\b/i, role: "death" },
  { re: /\b(?:founded|founding|established)\b/i, role: "founding" },
  { re: /\b(?:published|publication)\b/i, role: "published" },
  { re: /\b(?:reclassified|reclassification)\b/i, role: "reclassified" },
  { re: /\b(?:launched|launch)\b/i, role: "launched" },
  { re: /\b(?:released|release)\b/i, role: "released" },
];

// How far (chars) a role keyword may sit from the year it anchors. Widened from 40 to 80 (real
// live-run finding, 2026-08-18) to reach the Pluto claim's 74-char keyword-to-year gap. Review
// finding: 100 was tried first and reproduced a live regression — "nearest year wins" only
// protects against a second year for the SAME entity, not a nearer year belonging to a genuinely
// different one (e.g. "...was born in Andernach... while his brother was born in 1925", 93 chars
// away) — 80 stays under that distance while still covering the real Pluto case, with margin.
const ROLE_YEAR_WINDOW = 80;
// \b on both sides (review finding) — without it this matched a 4-digit year-shaped substring
// inside a longer digit run (a record/page number near a role keyword), same class of bug YEAR_RE
// (line 259) already guards against elsewhere in this file.
const YEAR_TOKEN_RE_G = new RegExp(`\\b${YEAR_TOKEN}\\b`, "g");

// Known limitation, accepted (review finding): only the FIRST occurrence of each role keyword/
// range is used, so a text naming multiple people (subject and a relative, each with their own
// birth/death) could anchor to the wrong one. `sameEntity`'s proper-noun overlap check is the
// mitigation, not a full fix — genuine multi-entity disambiguation is out of scope, same D026 §5
// precedent this file already follows for not over-building per-fact attribution.
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
    // Nearest year to the keyword wins, not just the first one in the window — a window can
    // legitimately contain a second, farther role's year too (e.g. "born in 1895 and died in
    // 1948" — the "born" keyword's window also reaches "1948").
    let nearest: { year: string; distance: number } | null = null;
    for (const yearMatch of window.matchAll(YEAR_TOKEN_RE_G)) {
      const distance = Math.abs(yearMatch.index! - keywordOffsetInWindow);
      if (!nearest || distance < nearest.distance) nearest = { year: yearMatch[0], distance };
    }
    if (nearest) facts.push({ role, year: nearest.year });
  }
  return facts;
}

// Coarse entity guard — abstains when claim and evidence name disjoint proper nouns, so a
// coincidentally-matching date for a clearly different subject doesn't force a verdict either way.
// Known limitation, accepted: two different people sharing a surname (e.g. father/son) still
// overlap here and won't be caught — full entity linking is out of scope (D026 §5's own precedent:
// overly clever per-fact attribution was tried elsewhere in this file and rejected as fragile).
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z'-]+\b/g;
// Review finding — month names are capitalized proper-noun-shaped tokens too, and this gate's own
// claim/evidence pairs are date-heavy by construction, so without excluding them a shared month
// name alone (not an actual shared entity) was enough to defeat this guard.
const SENTENCE_START_STOPWORDS = new Set(
  ["the", "he", "she", "they", "his", "her", "their", "a", "an", "in", "on", "at", "this", "that", "its", ...MONTH_NAMES].map((w) => w.toLowerCase())
);

function properNounWords(text: string): Set<string> {
  const words = text.match(PROPER_NOUN_RE) ?? [];
  // Strip a trailing singular possessive ('s) — real prose names an entity once and then refers
  // back to it possessively ("Nauru's population"), and without this a bare "Nauru" in the claim
  // never set-matches "nauru's" in the evidence even though they're the same entity (found via
  // g17's new applySubjectEntityGate, a far more frequent caller of sameEntity than applyYearGate's
  // narrow original use).
  // Known, accepted limitation (review finding): a PLURAL possessive ("the Wrights' aircraft")
  // never reduces further to the singular root "wright" — PROPER_NOUN_RE's own \b already drops the
  // bare trailing apostrophe before this code sees it, and even a source-text lookahead can't fix
  // it: "Kansas'" (a singular name that already ends in s) and "Wrights'" (a pluralized surname)
  // are indistinguishable from the captured text alone, so "strip the trailing s" would silently
  // break the s-ending-singular case to fix the pluralized-surname one. No regex-only fix disambiguates
  // this; same class of accepted gap as this file's own "two people sharing a surname" note below.
  return new Set(
    words
      .map((w) => w.toLowerCase().replace(/'s?$/, ""))
      .filter((w) => !SENTENCE_START_STOPWORDS.has(w))
  );
}

// Shared by both detectors (review finding — Detector 1 previously had no entity guard at all,
// letting two unrelated subjects that coincidentally share a month+day force a verdict). Abstains
// only when BOTH sides name at least one proper noun and they share none — a text with no
// capitalized names at all (pronoun-only) is left to the year/date comparison alone.
function sameEntity(claimText: string, evidenceText: string): boolean {
  const claimNames = properNounWords(claimText);
  const evidenceNames = properNounWords(evidenceText);
  if (claimNames.size === 0 || evidenceNames.size === 0) return true;
  return [...claimNames].some((n) => evidenceNames.has(n));
}

// Only gates the forced-`supported` direction (review finding) — a wrong value is wrong
// regardless of how confidently the source states it, so `contradicted` is never held back by this.
const HEDGE_RE = /\b(reportedly|allegedly|disputed|unclear|unreliable|unconfirmed|some sources)\b/i;

/**
 * Gate #2b — deliberately narrower than D026 §5's rejected generic "any differing year" approach:
 * only acts when claim and evidence share a recognizable structural marker (identical month+day,
 * or the same temporal role — birth, death, ...) tying two numbers to the SAME fact, never bare
 * year proximity/set-overlap guessing. `applyNumericGate`'s own `extractNumericFact` only
 * recognizes currency/percent (shared with the `audit` orchestrator) — bare years never reach it.
 */
export function applyYearGate(input: YearGateInput): YearGateResult {
  if (!input.evidence) return { verdict: input.verdict, overridden: false, reason: null };
  const evidence = input.evidence;

  // Review finding — the forced-`supported` direction must also leave an existing `contradicted`
  // alone: a date MATCH doesn't excuse a genuine mismatch gate #2 (or an earlier gate) already
  // found on a DIFFERENT fact in the same claim (e.g. a wrong dollar figure alongside a correct
  // founding date) — reproduced live before this fix, gate #2b was silently undoing gate #2's own
  // correct contradiction. The forced-`contradicted` direction is unconditional, as before: a
  // wrong date is wrong regardless of what an already-`contradicted` verdict says about it too.
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

// Window sized off a real captured VERIFY reason ("None of the provided sentences mention the year
// 2005...", ~48 chars from "None" to "2005") with margin — same measure-then-set approach as
// ROLE_YEAR_WINDOW above.
// "n't" has no leading \b (contractions have no word boundary before 'n') — same fix
// NEGATED_CONTRADICTION_RE already applies (verify-reconcilers.ts) for the identical reason.
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

// Rough sentence spans with offsets, just to bound the locality check below — doesn't split mid-
// number (see isSentenceTerminator); doesn't need to handle abbreviations etc. perfectly otherwise.
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

/**
 * Reason/verdict consistency check (external review, 2026-08-18) — NOT a second fact-verification
 * pass. `applyYearGate`'s `ROLE_KEYWORDS` whitelist proved unable to keep up with unbounded evidence
 * phrasing (tasks.md Phase 35 revert); this instead checks whether VERIFY's own `reason` names a
 * different year for the claim's fact than the claim asserts, independent of whether the reason uses
 * applyReasonConsistencyGate's specific contradiction vocabulary.
 *
 * Locality guard: an alternative year only counts when its own sentence shares >=2 of the claim's
 * key terms (extractKeyTerms/scoreKeyTermMatches — same helper applyImplicitNegationGate already
 * uses) — otherwise a reason mentioning an unrelated year for a different fact ("...founded in 1919")
 * would be wrongly treated as contradicting this claim. `contradicted`-only and year-only, matching
 * this file's existing narrow-gate discipline (see applyReasonConsistencyGate above).
 */
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

// ORDINAL_WORDS, ORDINAL_RE_G, ordinalAnchorWords, anchorsOverlap moved to lib/instance-selector.ts
// (D030 §3f, imported above as ordinalAnchorWords/anchorsOverlap/ORDINAL_WORDS/ORDINAL_RE_G) — same
// anchor-window machinery, now shared with the new retrieval selector signal instead of drifting
// into two copies. Behavior here is unchanged.

// Same clause-scoped negation approach as isReasonYearNegated above (reuses lastClauseBoundary).
// Window matches the year gate's own 60-char constant rather than a smaller guess — this gate has
// no live-captured VERIFY reason to measure a real window off yet (T010, blocked on deployment
// access), and there's no principled reason to use a NARROWER window than the sibling gate that
// HAS been validated against real captured data. Revisit once real ordinal-mismatch reasons exist.
const ORDINAL_NEGATION_WORD_RE = /\bnot\b|n't|\bno\b|\bnone\b|\bnever\b/i;
const ORDINAL_NEGATION_WINDOW = 60;

function isOrdinalNegated(reason: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - ORDINAL_NEGATION_WINDOW);
  const window = reason.slice(windowStart, matchIndex);
  const clauseStart = lastClauseBoundary(window);
  return ORDINAL_NEGATION_WORD_RE.test(clauseStart === -1 ? window : window.slice(clauseStart + 1));
}

/**
 * Reason/verdict consistency gate — ordinal/sequence-position mismatch (D030, tasks.md T002/T003).
 * NOT a token-swapped copy of applyReasonYearGate (research.md Decision 2): an ordinal word
 * ("first", "second"...) is not inherently a fact the way a year is — it's equally likely to be
 * discourse structure ("First, the source says X. Second, it says Y.") as a factual attribute of
 * an event, so extraction anchors on the noun phrase the ordinal attaches to in the CLAIM text
 * itself, not a fixed role-noun vocabulary — the exact abstraction that already failed twice in
 * this codebase (the deleted applyOrdinalGate's ROLE_KEYWORDS, and the sibling year-gate's own
 * ROLE_KEYWORDS whitelist miss on "redesignated"/"downgraded").
 *
 * Confirmation takes precedence over contradiction, deliberately (data-model.md §1's "does NOT
 * fire" / "abstains — ambiguous" matrix rows): if the claim's own ordinal+anchor combination
 * appears anywhere in `reason`, un-negated, that's sufficient to leave the verdict alone — even if
 * a different ordinal on the same anchor also appears elsewhere in the same reason (a reason can
 * legitimately discuss more than one instance of the same anchored noun).
 */
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

/**
 * Deterministic backstop for g17 (real prod bug: unrelated real sources coincidentally matching a
 * claim's bare number/generic noun got graded supported). Reuses sameEntity()'s proper-noun-set
 * intersection above — the same trusted mechanism applyYearGate already runs on, not a new fixed
 * word list. Downgrades supported/partially_supported only, matching D019's asymmetry: this is a
 * false-miss risk (a real match happens to share no proper noun), never a false accusation.
 */
export function applySubjectEntityGate(input: SubjectEntityGateInput): SubjectEntityGateResult {
  if (input.verdict !== "supported" && input.verdict !== "partially_supported") {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  if (!input.evidence) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  // Guards undefined too, not just "" — tests aren't typechecked (tsconfig excludes tests/), so
  // fixtures predating this field hit this at runtime.
  const anchor = input.subjectEntity && input.subjectEntity.trim().length > 0 ? input.subjectEntity : input.claimText;
  if (sameEntity(anchor, input.evidence)) {
    return { verdict: input.verdict, overridden: false, reason: null };
  }
  return { verdict: "unverifiable", overridden: true, reason: "subject_entity_mismatch" };
}

