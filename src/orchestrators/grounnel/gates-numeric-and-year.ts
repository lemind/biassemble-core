// Numeric/temporal gates — extract a structural marker in code, then compare. Gate #2, #2b (D031 split, pure move). See gates.ts for the public barrel.

import { compare } from "../../numbers/compare.js";
import { extractNumericFact } from "../audit/verify-reconcilers.js";
import { MONTH_NAMES, sameEntity, type Verdict } from "./gates-shared.js";

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

// Known, accepted limit: only the FIRST role-keyword occurrence is used — sameEntity's overlap check mitigates, doesn't fully fix.
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

// Only gates the forced-`supported` direction — a wrong value is wrong regardless of hedging, so `contradicted` is never held back by this.
const HEDGE_RE = /\b(reportedly|allegedly|disputed|unclear|unreliable|unconfirmed|some sources)\b/i;

/** Gate #2b — narrower than a generic "any differing year": only acts on a shared structural marker (month+day, or same temporal role), never bare year proximity. extractNumericFact never reaches bare years. */
export function applyYearGate(input: YearGateInput): YearGateResult {
  if (!input.evidence) return { verdict: input.verdict, overridden: false, reason: null };
  const evidence = input.evidence;

  // Forced-`supported` must leave an existing `contradicted` alone — a date MATCH doesn't excuse a different fact's mismatch. Forced-`contradicted` stays unconditional.
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

// Exported for gates-numeric-and-year.test-adjacent reuse if ever needed; also used by
// gates-reason-grounded.ts's applyReasonYearGate (same year-token shape, D031's own reason gate).
export { YEAR_TOKEN_RE_G };
