import { compare } from "../../numbers/compare.js";
import type { Claim } from "../../db/schema.js";
import type { RetrievedPassage } from "../../rag/corpus-client.js";

/** Five reconcilers below, each for one confirmed production incident. Rationale, scope, and known gaps: D018 §5. */

type CurrencyOrPercentUnit = "USD" | "percent";

interface ExtractedNumericFact {
  value: number;
  unit: CurrencyOrPercentUnit;
  /** Only meaningful for unit === "USD". null = no scale word found in this text. */
  scale: string | null;
}

// Parens = accounting-negative, e.g. "$(0.62)" = -0.62. Paren-then-scale group order matches
// real usage ("$(190.9) million", not "$(190.9 million)"). D018 §5.
const CURRENCY_RE = /\$\s?(\()?\s*([\d,]+(?:\.\d+)?)\s*(\))?\s*(billion|million|thousand)?/i;
const PERCENT_RE = /(-?[\d,]+(?:\.\d+)?)\s*%/;

/** One currency-or-percent fact from free text; currency tried first. D018 §5. */
export function extractNumericFact(text: string): ExtractedNumericFact | null {
  const currencyMatch = text.match(CURRENCY_RE);
  if (currencyMatch?.[2]) {
    let value = parseFloat(currencyMatch[2].replace(/,/g, ""));
    if (Number.isNaN(value)) return null;
    if (currencyMatch[1] === "(" || currencyMatch[3] === ")") {
      value = -Math.abs(value);
    }
    return { value, unit: "USD", scale: currencyMatch[4]?.toLowerCase() ?? null };
  }
  const percentMatch = text.match(PERCENT_RE);
  if (percentMatch?.[1]) {
    const value = parseFloat(percentMatch[1].replace(/,/g, ""));
    if (Number.isNaN(value)) return null;
    return { value, unit: "percent", scale: null };
  }
  return null;
}

/** All currency/percent matches, not just the first — dense evidence can hold 2+ figures for different measures. D018 §5. */
function extractAllNumericFacts(text: string): ExtractedNumericFact[] {
  const facts: ExtractedNumericFact[] = [];
  for (const m of text.matchAll(new RegExp(CURRENCY_RE.source, "gi"))) {
    if (!m[2]) continue;
    let value = parseFloat(m[2].replace(/,/g, ""));
    if (Number.isNaN(value)) continue;
    if (m[1] === "(" || m[3] === ")") value = -Math.abs(value);
    facts.push({ value, unit: "USD", scale: m[4]?.toLowerCase() ?? null });
  }
  for (const m of text.matchAll(new RegExp(PERCENT_RE.source, "g"))) {
    if (!m[1]) continue;
    const value = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(value)) continue;
    facts.push({ value, unit: "percent", scale: null });
  }
  return facts;
}

/** Disambiguates multiple same-unit evidence figures via scale-presence; stays silent if ambiguous. D018 §5. */
function pickEvidenceFact(claimFact: ExtractedNumericFact, evidenceText: string): ExtractedNumericFact | null {
  // Percent stays single-match (unlike USD below) — extending multi-candidate search to percent
  // broke verify-003. See D018 §5.
  if (claimFact.unit !== "USD") {
    const fact = extractNumericFact(evidenceText);
    return fact && fact.unit === claimFact.unit ? fact : null;
  }
  const candidates = extractAllNumericFacts(evidenceText).filter((f) => f.unit === "USD");
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  const sameScalePresence = candidates.filter((f) => (f.scale === null) === (claimFact.scale === null));
  return sameScalePresence.length === 1 ? (sameScalePresence[0] ?? null) : null;
}

/** Guards against a later reconciler undoing an earlier one's correct override. D018 §5.6. */
const CODE_OVERRIDE_TAG_RE = /\[verdict (?:set|overridden) by code:/;

/** Override notes lead with the code's conclusion; original LLM note kept but marked superseded. D018 §5.7. */
function buildOverrideNote(tag: string, originalNote: string | null): string {
  if (!originalNote) return tag;
  return `${tag} (model's original note, superseded by the above: "${originalNote}")`;
}

/** Scans retrieved passages directly when evidence is empty; NOT pickEvidenceFact reuse (percent needs 2+-match rejection here). D018 §5.2. */
function pickPassageFact(
  claimFact: ExtractedNumericFact,
  passages: RetrievedPassage[]
): { fact: ExtractedNumericFact; passageId: string; passageText: string } | null {
  const candidates: Array<{ fact: ExtractedNumericFact; passageId: string; passageText: string }> = [];
  for (const passage of passages) {
    const matches = extractAllNumericFacts(passage.text).filter((f) => f.unit === claimFact.unit);
    let fact: ExtractedNumericFact | null = null;
    if (matches.length === 1) {
      fact = matches[0] ?? null;
    } else if (matches.length > 1 && claimFact.unit === "USD") {
      const sameScale = matches.filter((f) => (f.scale === null) === (claimFact.scale === null));
      fact = sameScale.length === 1 ? (sameScale[0] ?? null) : null;
    }
    if (!fact) continue;
    if (claimFact.unit === "USD" && (claimFact.scale === null) !== (fact.scale === null)) continue;
    candidates.push({ fact, passageId: passage.passageId, passageText: passage.text });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  const firstValue = candidates[0]?.fact.value;
  const allAgree = candidates.every((c) => c.fact.value === firstValue);
  return allAgree ? (candidates[0] ?? null) : null;
}

/** A fact only counts as usable when its unit matches AND (for USD) scale-presence agrees — a same-unit fact that fails this must not block the passage fallback below. D018 §5.2. */
function isUsableNumericFact(claimFact: ExtractedNumericFact, fact: ExtractedNumericFact | null): fact is ExtractedNumericFact {
  if (!fact || claimFact.unit !== fact.unit) return false;
  if (claimFact.unit === "USD" && (claimFact.scale === null) !== (fact.scale === null)) return false;
  return true;
}

export function reconcileNumericVerdict(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null; confidence?: number },
  passages: RetrievedPassage[] = []
): { verdict: string; note: string | null; confidence: number; evidence?: string[]; sourceRefs?: string[] } {
  const confidence = result.confidence ?? 1;
  if (result.note && CODE_OVERRIDE_TAG_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const claimFact = extractNumericFact(claim.claimText);
  if (!claimFact) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  // Primary path: VERIFY's own quoted evidence, if it yields an unambiguous comparable fact.
  const firstEvidence = result.evidence?.[0];
  const evidenceFactCandidate = firstEvidence ? pickEvidenceFact(claimFact, firstEvidence) : null;
  let evidenceFact = isUsableNumericFact(claimFact, evidenceFactCandidate) ? evidenceFactCandidate : null;
  let evidenceOverride: { evidence: string[]; sourceRefs: string[] } | null = null;

  // Fallback: evidence was empty, OR it "found" a fact that isn't actually usable (e.g. a lone,
  // wrong-measure number the LLM happened to quote) — scan this claim's own retrieved passages
  // directly, independent of what the LLM echoed (see pickPassageFact above). Real regression
  // (2026-07-30): a single truncated evidence snippet naming the wrong figure used to be trusted
  // blindly, which blocked this fallback from ever running. D018 §5.2.
  if (!evidenceFact) {
    const passageMatch = pickPassageFact(claimFact, passages);
    if (passageMatch && isUsableNumericFact(claimFact, passageMatch.fact)) {
      evidenceFact = passageMatch.fact;
      evidenceOverride = { evidence: [passageMatch.passageText], sourceRefs: [passageMatch.passageId] };
    }
  }

  if (!evidenceFact) {
    return { verdict: result.verdict, note: result.note, confidence }; // nothing usable anywhere — trust the LLM
  }

  const comparison = compare(
    { value: claimFact.value, unit: claimFact.unit, scale: claimFact.scale, period: claim.period },
    { value: evidenceFact.value, unit: evidenceFact.unit, scale: evidenceFact.scale, period: claim.period }
  );
  if (!comparison.comparable) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  if (comparison.equal && result.verdict !== "supported") {
    return {
      verdict: "supported",
      note: buildOverrideNote(
        `[verdict set by code: ${claimFact.value} and ${evidenceFact.value} are within tolerance — compare.ts, D018 §2.3]`,
        result.note
      ),
      confidence: 1,
      ...(evidenceOverride ?? {}),
    };
  }
  if (!comparison.equal && result.verdict !== "contradicted") {
    return {
      verdict: "contradicted",
      note: buildOverrideNote(
        `[verdict set by code: ${claimFact.value} and ${evidenceFact.value} disagree beyond tolerance — compare.ts, D018 §2.3]`,
        result.note
      ),
      confidence: 1,
      ...(evidenceOverride ?? {}),
    };
  }
  return { verdict: result.verdict, note: result.note, confidence };
}

interface ExtractedQuarter {
  year: number;
  quarter: number;
}

// Requires a 4-digit year right after "Q[1-4]" — a bare "Q4" with no year must not match. D018 §5.3.
const QUARTER_RE = /\bQ([1-4])\s+(\d{4})\b/i;

function extractQuarter(text: string): ExtractedQuarter | null {
  const m = text.match(QUARTER_RE);
  if (!m || !m[1] || !m[2]) return null;
  return { quarter: parseInt(m[1], 10), year: parseInt(m[2], 10) };
}

function extractAllQuarters(text: string): ExtractedQuarter[] {
  const out: ExtractedQuarter[] = [];
  for (const m of text.matchAll(new RegExp(QUARTER_RE.source, "gi"))) {
    if (!m[1] || !m[2]) continue;
    out.push({ quarter: parseInt(m[1], 10), year: parseInt(m[2], 10) });
  }
  return out;
}

/** No scale-presence-equivalent signal for dates — 2+ quarter mentions in evidence means stay silent. D018 §5.3. */
function pickEvidenceQuarter(evidenceText: string): ExtractedQuarter | null {
  const candidates = extractAllQuarters(evidenceText);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** Passage-fallback mirror of pickPassageFact, for when VERIFY's evidence is empty or ambiguous — same per-passage, exactly-one-candidate discipline. D018 §5.3. */
function pickPassageQuarter(passages: RetrievedPassage[]): { quarter: ExtractedQuarter; passageId: string; passageText: string } | null {
  const candidates: Array<{ quarter: ExtractedQuarter; passageId: string; passageText: string }> = [];
  for (const passage of passages) {
    const matches = extractAllQuarters(passage.text);
    if (matches.length !== 1) continue;
    candidates.push({ quarter: matches[0]!, passageId: passage.passageId, passageText: passage.text });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  const first = candidates[0]!.quarter;
  const allAgree = candidates.every((c) => c.quarter.year === first.year && c.quarter.quarter === first.quarter);
  return allAgree ? (candidates[0] ?? null) : null;
}

/** Date comparator for quarter-shaped claims. Scoped to supported/contradicted inputs only (no same-measure signal for dates). D018 §5.3. */
export function reconcileTemporalVerdict(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null; confidence?: number },
  passages: RetrievedPassage[] = []
): { verdict: string; note: string | null; confidence: number; evidence?: string[]; sourceRefs?: string[] } {
  const confidence = result.confidence ?? 1;
  if (result.note && CODE_OVERRIDE_TAG_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  if (result.verdict !== "supported" && result.verdict !== "contradicted") {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const claimQuarter = extractQuarter(claim.claimText);
  if (!claimQuarter) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const firstEvidence = result.evidence?.[0];
  let evidenceQuarter = firstEvidence ? pickEvidenceQuarter(firstEvidence) : null;
  let evidenceOverride: { evidence: string[]; sourceRefs: string[] } | null = null;

  // Fallback: evidence was empty or ambiguous — scan retrieved passages directly, same shape as
  // reconcileNumericVerdict's fix (D018 §5.2), added preemptively rather than waiting for this
  // reconciler to also misfire on an evidence-empty run.
  if (!evidenceQuarter) {
    const passageMatch = pickPassageQuarter(passages);
    if (passageMatch) {
      evidenceQuarter = passageMatch.quarter;
      evidenceOverride = { evidence: [passageMatch.passageText], sourceRefs: [passageMatch.passageId] };
    }
  }

  if (!evidenceQuarter) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const equal = claimQuarter.year === evidenceQuarter.year && claimQuarter.quarter === evidenceQuarter.quarter;

  if (equal && result.verdict !== "supported") {
    return {
      verdict: "supported",
      note: buildOverrideNote(
        `[verdict set by code: both state Q${claimQuarter.quarter} ${claimQuarter.year} — date comparator, D018 §2.3]`,
        result.note
      ),
      confidence: 1,
      ...(evidenceOverride ?? {}),
    };
  }
  if (!equal && result.verdict !== "contradicted") {
    return {
      verdict: "contradicted",
      note: buildOverrideNote(
        `[verdict set by code: claim states Q${claimQuarter.quarter} ${claimQuarter.year}, evidence states Q${evidenceQuarter.quarter} ${evidenceQuarter.year} — different quarters, date comparator, D018 §2.3]`,
        result.note
      ),
      confidence: 1,
      ...(evidenceOverride ?? {}),
    };
  }
  return { verdict: result.verdict, note: result.note, confidence };
}

/** "supported" is invalid if its own note asserts a contradiction; runs FIRST in the chain (D018 §5.5) so later checks get final say. */
const CONTRADICTION_LANGUAGE_RE = /\b(contradicts?|conflicts?\s+with|differs?\s+from|is\s+inconsistent\s+with)\b/i;
// Clause-scoped negation, not fixed char count; "n't" has no leading \b (contractions have no word boundary before 'n'). D018 §5.5.
const NEGATED_CONTRADICTION_RE = /(?:\bnot\b|n't|\bno\b|\bnever\b)[^.,;]{0,40}\b(contradicts?|conflicts?|differ|inconsistent)\b/i;

export function reconcileVerdictNoteConsistency(result: {
  verdict: string;
  evidence: string[] | null;
  note: string | null;
  confidence?: number;
}): { verdict: string; note: string | null; confidence: number } {
  const confidence = result.confidence ?? 1;
  if (result.note && CODE_OVERRIDE_TAG_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  if (result.verdict !== "supported" || !result.note || !result.evidence?.length) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  if (!CONTRADICTION_LANGUAGE_RE.test(result.note) || NEGATED_CONTRADICTION_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  return {
    verdict: "contradicted",
    note: buildOverrideNote(
      "[verdict overridden by code: 'supported' is invalid when its own note asserts a contradiction — D018 §2.3 VERDICT/NOTE CONSISTENCY]",
      result.note
    ),
    confidence, // not forced to 1 — text heuristic, stays behind GateService's gate. D018 §5.8.
  };
}

/** Curated defined-term list (one entry per confirmed incident); requires both phrases nearby to avoid off-topic matches. D018 §5.4. */
const DEFINED_TERMS: RegExp[] = [/substantial doubt[^.]{0,80}going concern|going concern[^.]{0,80}substantial doubt/i];

// No 'g'/'y' flags on DEFINED_TERMS entries — this function reuses the same RegExp object repeatedly; a global flag would carry lastIndex state across calls.
function isDefinedTermNegatedInClaim(claimText: string, term: RegExp): boolean {
  const negated = new RegExp(`(?:\\bnot\\b|n't|\\bno\\b|\\bnever\\b)[^.,;]{0,40}(?:${term.source})`, term.flags.includes("i") ? "i" : "");
  return negated.test(claimText);
}

export function reconcileDefinedTermVerdict(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null; confidence?: number },
  passages: RetrievedPassage[] = []
): { verdict: string; note: string | null; confidence: number } {
  const confidence = result.confidence ?? 1;
  if (result.note && CODE_OVERRIDE_TAG_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  if (result.verdict === "contradicted" || result.verdict === "partially_supported") {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const evidence = result.evidence;
  // Real regression (2026-07-30): this used to bail out unconditionally when evidence was empty,
  // unlike reconcileNumericVerdict — added the same passages fallback here. D018 §5.4.
  if (!evidence?.length && passages.length === 0) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const term = DEFINED_TERMS.find((re) => re.test(claim.claimText));
  if (!term) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  if (isDefinedTermNegatedInClaim(claim.claimText, term)) {
    return { verdict: result.verdict, note: result.note, confidence }; // claim asserts the term's ABSENCE, not its presence
  }
  const termPresentVerbatim = Boolean(evidence?.some((e) => term.test(e))) || passages.some((p) => term.test(p.text));
  if (termPresentVerbatim) {
    return { verdict: result.verdict, note: result.note, confidence }; // term present verbatim — direct restatement, leave as-is
  }

  return {
    verdict: "partially_supported",
    note: buildOverrideNote(
      "[verdict set by code: claim asserts a defined term not present verbatim in the cited evidence or retrieved passages — rule 3, D018 §2.3]",
      result.note
    ),
    confidence, // not forced to 1 — text heuristic, stays behind GateService's gate. D018 §5.8.
  };
}

/** Multiple thresholds this checks for — expand only when a real case justifies it (T041b). */
const MAGNITUDE_PHRASES: Array<{ pattern: RegExp; multiple: number }> = [
  { pattern: /more than quadrupl/i, multiple: 4.0 },
  { pattern: /more than tripl/i, multiple: 3.0 },
  { pattern: /more than doubl/i, multiple: 2.0 },
];

export function detectMagnitudeClaim(claimText: string): { multiple: number } | null {
  for (const { pattern, multiple } of MAGNITUDE_PHRASES) {
    if (pattern.test(claimText)) return { multiple };
  }
  return null;
}

/** [current, prior] from a "$current $prior ..." table shape — narrow by design, not a general table parser. */
export function extractCurrentPriorPair(evidenceText: string): [number, number] | null {
  const values = [...evidenceText.matchAll(/\$?([\d,]+(?:\.\d+)?)/g)]
    .map((m) => (m[1] ? parseFloat(m[1].replace(/,/g, "")) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (values.length < 2 || values[0] === undefined || values[1] === undefined) return null;
  return [values[0], values[1]];
}

/** Ratio-vs-claimed-multiple boundary: >=multiple supported, >=90% partially_supported, else contradicted. D018 §5.9. */
export function reconcileMagnitudeClaim(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null; confidence?: number }
): { verdict: string; note: string | null; confidence: number } {
  const confidence = result.confidence ?? 1;
  if (result.note && CODE_OVERRIDE_TAG_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const firstEvidence = result.evidence?.[0];
  if (!firstEvidence) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  if (result.verdict !== "supported" && result.verdict !== "partially_supported" && result.verdict !== "contradicted") {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const magnitude = detectMagnitudeClaim(claim.claimText);
  if (!magnitude) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const pair = extractCurrentPriorPair(firstEvidence);
  if (!pair) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const [current, prior] = pair;
  if (prior === 0) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const ratio = current / prior;

  let forcedVerdict: string;
  if (ratio >= magnitude.multiple) {
    forcedVerdict = "supported";
  } else if (ratio >= magnitude.multiple * 0.9) {
    forcedVerdict = "partially_supported";
  } else {
    forcedVerdict = "contradicted";
  }

  if (forcedVerdict === result.verdict) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  return {
    verdict: forcedVerdict,
    note: buildOverrideNote(
      `[verdict set by code: computed ratio ${current}/${prior} = ${ratio.toFixed(3)}x vs claimed ${magnitude.multiple}x — compare.ts/D018 §2.3]`,
      result.note
    ),
    confidence: 1, // clears GateService's threshold — D018 §5.1.
  };
}
