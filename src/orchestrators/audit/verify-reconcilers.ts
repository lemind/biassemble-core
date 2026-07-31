import { compare } from "../../numbers/compare.js";
import { detectTableCandidate, columnsForCells, narrowByPeriod, tableScaleOf, rowCells } from "./table-parse.js";
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
/** "negative $52 million" is the prose form of the accounting parens already handled above. D018 §5. */
const NEGATIVE_PREFIX_RE = /\b(?:negative|minus)\s+$/i;

/** One currency-or-percent fact from free text; currency tried first. D018 §5. */
export function extractNumericFact(text: string): ExtractedNumericFact | null {
  const currencyMatch = text.match(CURRENCY_RE);
  if (currencyMatch?.[2]) {
    let value = parseFloat(currencyMatch[2].replace(/,/g, ""));
    if (Number.isNaN(value)) return null;
    if (currencyMatch[1] === "(" || currencyMatch[3] === ")") {
      value = -Math.abs(value);
    }
    if (NEGATIVE_PREFIX_RE.test(text.slice(0, currencyMatch.index ?? 0))) value = -Math.abs(value);
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

const MEASURE_STOPWORDS = new Set([
  "the", "a", "an", "of", "at", "in", "on", "for", "to", "and", "or", "with", "its", "it", "as", "by", "from", "that",
  "this", "was", "were", "is", "are", "be", "been", "has", "have", "had", "reports", "reported", "we", "our",
  // Scale words are units, not measure names — keeping them out lets a prose figure whose own row is
  // only "million or" fall back to the row that actually names the measure. D018 §5.2.
  "million", "billion", "thousand",
]);

const TOKEN_RE = /[A-Za-z]+|\d[\d,]*(?:\.\d+)?/g;
/** Fraction of a row's own label the claim must account for before that row's figures are comparable. */
const LABEL_COVERAGE_MIN = 0.5;

interface PassageRow {
  start: number;
  labelWords: string[];
  /** False when labelWords were inherited from the previous row rather than named by this one. */
  ownLabel: boolean;
}

/** Row starts wherever a word follows a number — in a table that is the next row's label, in prose the next clause. D018 §5.2. */
function segmentRows(text: string): PassageRow[] {
  const starts = [0];
  let prevWasNumber = false;
  for (const m of text.matchAll(TOKEN_RE)) {
    const isNumber = /\d/.test(m[0]!.charAt(0));
    if (!isNumber && prevWasNumber) starts.push(m.index ?? 0);
    prevWasNumber = isNumber;
  }
  const rows: PassageRow[] = [];
  for (let i = 0; i < starts.length; i++) {
    const slice = text.slice(starts[i]!, starts[i + 1] ?? text.length);
    const words = (slice.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 1 && !MEASURE_STOPWORDS.has(w));
    // A row with no content word of its own (prose: "million or $(0.87)") inherits the last row that
    // had one, so the measure named upstream still identifies the figure.
    rows.push({
      start: starts[i]!,
      labelWords: words.length > 0 ? words : (rows[i - 1]?.labelWords ?? []),
      ownLabel: words.length > 0,
    });
  }
  return rows;
}


function rowIndexFor(rows: PassageRow[], index: number): number {
  let found = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.start <= index) found = i;
  return found;
}

/** Same as extractAllNumericFacts, but each fact keeps its position so it can be tied to a row. D018 §5.2. */
function extractNumericFactsWithIndex(text: string): Array<{ fact: ExtractedNumericFact; index: number }> {
  const out: Array<{ fact: ExtractedNumericFact; index: number }> = [];
  for (const m of text.matchAll(new RegExp(CURRENCY_RE.source, "gi"))) {
    if (!m[2]) continue;
    let value = parseFloat(m[2].replace(/,/g, ""));
    if (Number.isNaN(value)) continue;
    if (m[1] === "(" || m[3] === ")" || NEGATIVE_PREFIX_RE.test(text.slice(0, m.index ?? 0))) value = -Math.abs(value);
    out.push({ fact: { value, unit: "USD", scale: m[4]?.toLowerCase() ?? null }, index: m.index ?? 0 });
  }
  for (const m of text.matchAll(new RegExp(PERCENT_RE.source, "g"))) {
    if (!m[1]) continue;
    const value = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(value)) continue;
    out.push({ fact: { value, unit: "percent", scale: null }, index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 1 && !MEASURE_STOPWORDS.has(w));
}

/**
 * Picks the one row whose label identifies the claim's subject. Rarity-weighted: "americas" (one row)
 * beats "net sales" (header + total row), which is why a segment claim no longer matches the Total
 * row. Ties on rarity break on label coverage; a genuine tie declines. D018 §5.2.
 */
function pickBestRow(
  rows: Array<{ labelWords: string[] }>,
  claimWords: Set<string>,
  allRows: Array<{ labelWords: string[] }>
): number | null {
  // Frequency counts EVERY row, not just the ones holding comparable figures — otherwise a table's
  // header row ("...shows net sales by segment...") goes uncounted and "net sales" scores as rare as
  // "americas", which is exactly how the Americas false accusation survived the first fix. D018 §5.2.
  const rowFreq = new Map<string, number>();
  for (const row of allRows) for (const w of new Set(row.labelWords)) rowFreq.set(w, (rowFreq.get(w) ?? 0) + 1);

  let best: { idx: number; rarity: number; coverage: number } | null = null;
  let tied = false;
  for (let idx = 0; idx < rows.length; idx++) {
    const label = new Set(rows[idx]!.labelWords);
    const matched = [...label].filter((w) => claimWords.has(w));
    if (matched.length === 0) continue;
    // Most of the row's own label must be what the claim is about. Without this, a net-income-margin
    // claim matched the "Total net sales" row on the single shared word "net" (verify-011).
    const coverage = matched.length / label.size;
    if (coverage < LABEL_COVERAGE_MIN) continue;
    const rarity = Math.max(...matched.map((w) => 1 / (rowFreq.get(w) ?? 1)));
    if (!best || rarity > best.rarity || (rarity === best.rarity && coverage > best.coverage)) {
      best = { idx, rarity, coverage };
      tied = false;
    } else if (rarity === best.rarity && coverage === best.coverage) {
      tied = true;
    }
  }
  return best && !tied ? best.idx : null;
}

/** Claim period naming a year the passage never mentions = different period, not a conflicting figure. D018 §5.2. */
function passagePeriodConflicts(claimPeriod: string | null, passageText: string): boolean {
  const claimYears = claimPeriod?.match(/(?<![\d.])(?:19|20)\d{2}(?![\d.])/g);
  if (!claimYears?.length) return false;
  const passageYears = passageText.match(/(?<![\d.])(?:19|20)\d{2}(?![\d.])/g);
  if (!passageYears?.length) return false;
  return !claimYears.some((y) => passageYears.includes(y));
}

/**
 * Same-unit figures from the ONE row whose label names the claim's subject, in passages of the claim's
 * own period. Callers decide by unanimity, never by picking one. Row scoping replaced bigram matching
 * after a true claim ("Americas net sales grew 12%") was contradicted against the Total row. D018 §5.2.
 */
function collectPassageFacts(
  claim: Claim,
  claimFact: ExtractedNumericFact,
  passages: RetrievedPassage[]
): { candidates: Array<{ fact: ExtractedNumericFact; passageId: string; passageText: string }>; rowSiblings: ExtractedNumericFact[] } {
  // Only the words leading up to the claim's OWN figure name its subject. Using the whole sentence
  // matched "net income margin ... of total net sales" to the net-sales row (verify-011). D018 §5.2.
  const claimFigure = extractNumericFactsWithIndex(claim.claimText).find(
    (c) => c.fact.unit === claimFact.unit && c.fact.value === claimFact.value
  );
  const none = { candidates: [], rowSiblings: [] };
  if (!claimFigure) return none;
  const claimWords = new Set(contentWords(claim.claimText.slice(0, claimFigure.index)));
  if (claimWords.size === 0) return none;

  // Pooled across passages so the row naming the subject wins; bare ($-less) rows included, since SEC
  // tables mark only the first and total row. D018 §5.2.
  const pool: Array<{ labelWords: string[]; passage: RetrievedPassage; rowText: string; facts: ExtractedNumericFact[] }> = [];
  const allRows: Array<{ labelWords: string[] }> = [];
  for (const passage of passages) {
    if (passagePeriodConflicts(claim.period, passage.text)) continue;
    const rows = segmentRows(passage.text);
    allRows.push(...rows);
    // Facts are still extracted over the WHOLE passage and assigned by position: segmentRows can split a
    // figure from its scale word ("$190.9" | "million"), and re-extracting per row would drop the scale.
    const byRow = new Map<number, ExtractedNumericFact[]>();
    for (const { fact, index } of extractNumericFactsWithIndex(passage.text)) {
      if (!isUsableNumericFact(claimFact, fact)) continue;
      const idx = rowIndexFor(rows, index);
      byRow.set(idx, [...(byRow.get(idx) ?? []), fact]);
    }
    // Bare rows are admitted only inside an actual table, and only when they name themselves: in prose a
    // fact-less row would tie with the row it inherited its label from, and both would decline. D018 §5.2.
    const isTable = detectTableCandidate(passage.text) !== null;
    for (let i = 0; i < rows.length; i++) {
      const rowText = passage.text.slice(rows[i]!.start, rows[i + 1]?.start ?? passage.text.length);
      const facts = byRow.get(i) ?? [];
      if (facts.length === 0 && (!isTable || !rows[i]!.ownLabel || rowCells(rowText).length === 0)) continue;
      pool.push({ labelWords: rows[i]!.labelWords, passage, rowText, facts });
    }
  }
  if (pool.length === 0) return none;

  const best = pickBestRow(pool, claimWords, allRows);
  if (best === null) return none; // nothing identifies this claim's subject, or a genuine tie — don't guess
  const chosen = pool[best]!;

  // Subject settled, so the row is read as a table and narrowed to the claim's period. D018 §5.2/§5.11.
  const table = tableRowFacts(claim, claimFact, chosen.rowText, chosen.passage.text);
  const facts = table && table.periodCells.length > 0 ? table.periodCells : chosen.facts;
  return {
    candidates: facts.map((fact) => ({ fact, passageId: chosen.passage.passageId, passageText: chosen.passage.text })),
    rowSiblings: table?.allCells ?? [],
  };
}

/** The metric row's cells: those matching the claim's period, and all of them. D018 §5.11. */
function tableRowFacts(
  claim: Claim,
  claimFact: ExtractedNumericFact,
  rowText: string,
  passageText: string
): { periodCells: ExtractedNumericFact[]; allCells: ExtractedNumericFact[] } | null {
  const detected = detectTableCandidate(passageText);
  if (!detected) return null;
  const cells = rowCells(rowText);
  // The block's own column count is authoritative; a row that disagrees is not a clean table row.
  if (cells.length < 2 || cells.length !== detected.columnCount) return null;
  const columns = columnsForCells(passageText, cells.map((c) => c.unit));
  if (!columns) return null;

  // With row and column pinned, the table's stated scale governs its bare cells, so a claim carrying a
  // different scale word (or one the table never states) is not comparable.
  const tableScale = tableScaleOf(passageText);
  if (claimFact.unit === "USD" && claimFact.scale && claimFact.scale !== tableScale) return null;

  const sameUnit = cells.map((cell, i) => ({ cell, column: columns[i]! })).filter(({ cell }) => cell.unit === claimFact.unit);
  if (sameUnit.length === 0) return null;

  // Narrowing reads the claim's own text — `claim.period` is an inferred field and a wrong value used to
  // select the prior-year column and contradict true claims wholesale. D018 §5.11.
  const narrowed = narrowByPeriod(sameUnit, claim.claimText);
  // Scale carried from the claim: both sides are already in the table's units.
  const toFact = ({ cell }: { cell: { value: number } }) => ({ value: cell.value, unit: claimFact.unit, scale: claimFact.scale });
  return { periodCells: narrowed.map(toFact), allCells: sameUnit.map(toFact) };
}

/** Override notes must carry the scale word — a bare "123363" next to "97.8" reads as a 1000x gap when it's $123.4M vs $97.8M. D018 §5.2. */
function formatFact(fact: ExtractedNumericFact): string {
  if (fact.unit === "percent") return `${fact.value}%`;
  return fact.scale ? `${fact.value} ${fact.scale}` : `${fact.value}`;
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

  const compareTo = (fact: ExtractedNumericFact) =>
    compare(
      { value: claimFact.value, unit: claimFact.unit, scale: claimFact.scale, period: claim.period },
      { value: fact.value, unit: fact.unit, scale: fact.scale, period: claim.period }
    );

  // Primary path: VERIFY's own quoted evidence, if it yields an unambiguous comparable fact.
  const firstEvidence = result.evidence?.[0];
  const evidenceFactCandidate = firstEvidence ? pickEvidenceFact(claimFact, firstEvidence) : null;
  const evidenceFact = isUsableNumericFact(claimFact, evidenceFactCandidate) ? evidenceFactCandidate : null;

  let equal: boolean;
  let citedFacts: ExtractedNumericFact[];
  let evidenceOverride: { evidence: string[]; sourceRefs: string[] } | null = null;

  if (evidenceFact) {
    const comparison = compareTo(evidenceFact);
    if (!comparison.comparable || comparison.equal === null) {
      return { verdict: result.verdict, note: result.note, confidence };
    }
    equal = comparison.equal;
    citedFacts = [evidenceFact];
  } else {
    // Fallback when evidence is empty or not comparable: decide by unanimity across every
    // same-measure figure in the passages, never by picking one. D018 §5.2.
    const { candidates: passageFacts, rowSiblings } = collectPassageFacts(claim, claimFact, passages);
    if (passageFacts.length === 0) {
      return { verdict: result.verdict, note: result.note, confidence }; // nothing usable anywhere — trust the LLM
    }
    const comparisons = passageFacts.map((c) => compareTo(c.fact));
    if (comparisons.some((c) => !c.comparable || c.equal === null)) {
      return { verdict: result.verdict, note: result.note, confidence };
    }
    const allEqual = comparisons.every((c) => c.equal === true);
    const allDiffer = comparisons.every((c) => c.equal === false);
    if (!allEqual && !allDiffer) {
      return { verdict: result.verdict, note: result.note, confidence }; // split — can't decide without knowing which figure is the measure
    }
    // A figure that IS in the metric's row, just not in the claim's period column, is not a
    // contradiction — the source states it, for another period. Only a figure absent from the whole row
    // is contradicted, which is why period matching can never produce a false accusation. D018 §5.11.
    if (!allEqual && rowSiblings.some((sibling) => compareTo(sibling).equal === true)) {
      const byPassage = new Map(passageFacts.map((c) => [c.passageId, c.passageText]));
      return {
        verdict: "unsupported",
        note: buildOverrideNote(
          `[verdict set by code: ${formatFact(claimFact)} appears in this measure's row but not for the claimed period (that column holds ${passageFacts.map((c) => formatFact(c.fact)).join(", ")}) — D018 §2.3]`,
          result.note
        ),
        confidence: 1,
        evidence: [...byPassage.values()],
        sourceRefs: [...byPassage.keys()],
      };
    }
    equal = allEqual;
    citedFacts = passageFacts.map((c) => c.fact);
    // Cite EVERY passage the quoted figures came from — citing only the first leaves numbers in the
    // note that a reviewer can't find in the evidence. D018 §5.2.
    const byPassage = new Map(passageFacts.map((c) => [c.passageId, c.passageText]));
    evidenceOverride = { evidence: [...byPassage.values()], sourceRefs: [...byPassage.keys()] };
  }

  const citedLabel = citedFacts.map(formatFact).join(", ");

  if (equal && result.verdict !== "supported") {
    return {
      verdict: "supported",
      note: buildOverrideNote(
        `[verdict set by code: ${formatFact(claimFact)} and ${citedLabel} are within tolerance — compare.ts, D018 §2.3]`,
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
        `[verdict set by code: ${formatFact(claimFact)} disagrees beyond tolerance with every same-measure figure cited (${citedLabel}) — compare.ts, D018 §2.3]`,
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

  // Fallback when evidence is empty or ambiguous: scan passages, same shape as the numeric
  // reconciler's. Added preemptively, not after an incident. D018 §5.3.
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
// "the claim is contradicted" shipped as supported — \b after "contradict" can never match inside
// "contradicted" (Apple probe 2026-07-30). Past tense is only accepted in the passive ("is/was
// contradicted"), which asserts a contradiction; a bare "said contradicted" merely mentions one. D018 §5.5.
const CONTRADICTION_LANGUAGE_RE =
  /\b(contradict(?:s|ing)?|(?:is|are|was|were|be|being|been)\s+contradicted|conflict(?:s|ed|ing)?\s+with|differ(?:s|ed|ing)?\s+from|is\s+inconsistent\s+with)\b/i;
// Clause-scoped negation, not fixed char count; "n't" has no leading \b (contractions have no word boundary before 'n'). D018 §5.5.
// Widened in lockstep with CONTRADICTION_LANGUAGE_RE — widening only the positive side would let
// "does not contradicted"-shaped negations through as real contradictions. D018 §5.5.
const NEGATED_CONTRADICTION_RE =
  /(?:\bnot\b|n't|\bno\b|\bnever\b)[^.,;]{0,40}\b(contradict(?:s|ed|ing)?|conflict(?:s|ed|ing)?|differ(?:s|ed|ing)?|inconsistent)\b/i;

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

/**
 * Curated defined terms (one entry per confirmed incident). `topic` gates the downgrade: rule 3 means
 * "on-topic but not stated verbatim", so a passage set that never touches the subject must yield
 * unsupported, not half credit — a fabricated going-concern claim about Apple was granted
 * partially_supported against iPhone/Mac sales narratives. D018 §5.4.
 */
const DEFINED_TERMS: Array<{ term: RegExp; topic: RegExp }> = [
  {
    term: /substantial doubt[^.]{0,80}going concern|going concern[^.]{0,80}substantial doubt/i,
    topic: /going concern|substantial doubt|ability to continue|operating losses|net losses|additional (?:capital|financing)|raise additional|liquidity/i,
  },
];

// No 'g'/'y' flags on DEFINED_TERMS entries — this function reuses the same RegExp object repeatedly; a global flag would carry lastIndex state across calls.
function isDefinedTermNegatedInClaim(claimText: string, term: RegExp): boolean {
  const negated = new RegExp(`(?:\\bnot\\b|n't|\\bno\\b|\\bnever\\b)[^.,;]{0,40}(?:${term.source})`, term.flags.includes("i") ? "i" : "");
  return negated.test(claimText);
}

export function reconcileDefinedTermVerdict(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null; confidence?: number },
  passages: RetrievedPassage[] = []
): { verdict: string; note: string | null; confidence: number; evidence?: string[]; sourceRefs?: string[] } {
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

  const entry = DEFINED_TERMS.find((d) => d.term.test(claim.claimText));
  if (!entry) {
    return { verdict: result.verdict, note: result.note, confidence };
  }
  const { term, topic } = entry;
  if (isDefinedTermNegatedInClaim(claim.claimText, term)) {
    return { verdict: result.verdict, note: result.note, confidence }; // claim asserts the term's ABSENCE, not its presence
  }
  const termPresentVerbatim = Boolean(evidence?.some((e) => term.test(e))) || passages.some((p) => term.test(p.text));
  if (termPresentVerbatim) {
    return { verdict: result.verdict, note: result.note, confidence }; // term present verbatim — direct restatement, leave as-is
  }

  // Rule 3 is "on-topic but not verbatim" — with nothing on-topic there is no partial support to give.
  const onTopicEvidence = evidence?.filter((e) => topic.test(e)) ?? [];
  const onTopicPassages = passages.filter((p) => topic.test(p.text));
  if (onTopicEvidence.length === 0 && onTopicPassages.length === 0) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  // A partially_supported verdict the report can't back up is unusable — when the model cited
  // nothing, cite the on-topic passages this decision was actually made against. D018 §5.4.
  const evidenceOverride =
    !evidence?.length && onTopicPassages.length > 0
      ? { evidence: onTopicPassages.map((p) => p.text), sourceRefs: onTopicPassages.map((p) => p.passageId) }
      : {};

  return {
    verdict: "partially_supported",
    note: buildOverrideNote(
      "[verdict set by code: claim asserts a defined term not present verbatim in the cited evidence or retrieved passages — rule 3, D018 §2.3]",
      result.note
    ),
    // Forced to 1: this is a deterministic presence/negation check over fixed text, and passing the
    // model's confidence through meant GateService silently dropped the override whenever the model
    // happened to return 0 — which is what buried going-concern claims. D018 §5.8.
    confidence: 1,
    ...evidenceOverride,
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

/**
 * [current, prior] from a "$current $prior ..." table shape — narrow by design, not a general table
 * parser. Currency-only: matching bare numbers made a full-passage evidence blob yield the header's
 * "March 28, 2026" as the pair (ratio 2026/2025). D018 §5.9.
 */
export function extractCurrentPriorPair(evidenceText: string): [number, number] | null {
  const values = extractAllNumericFacts(evidenceText)
    .filter((f) => f.unit === "USD")
    .map((f) => f.value);
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
