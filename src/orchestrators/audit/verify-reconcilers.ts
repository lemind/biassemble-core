import { compare } from "../../numbers/compare.js";
import { detectTableCandidate, detectColumnConsistency, columnsForCells, narrowByPeriod, tableScaleOf, rowCells } from "./table-parse.js";
import type { RowCell, ParsedColumn, TableCandidate } from "./table-parse.js";
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

interface RowScore {
  idx: number;
  rarity: number;
  coverage: number;
}

/** Word → row-count frequency map that scoreRows needs; split out so two scoreRows calls over the same allRows (both sides of one comparison claim) can share one computation. D018 §5.14. */
function buildRowFreq(allRows: Array<{ labelWords: string[] }>): Map<string, number> {
  const rowFreq = new Map<string, number>();
  for (const row of allRows) for (const w of new Set(row.labelWords)) rowFreq.set(w, (rowFreq.get(w) ?? 0) + 1);
  return rowFreq;
}

/** Shared rarity+coverage scoring core for pickBestRow and pickBestRowWithMargin. D018 §5.2/§5.14. */
function scoreRows(
  rows: Array<{ labelWords: string[] }>,
  wordSet: Set<string>,
  allRows: Array<{ labelWords: string[] }>,
  rowFreq: Map<string, number> = buildRowFreq(allRows)
): RowScore[] {
  const scored: RowScore[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const label = new Set(rows[idx]!.labelWords);
    const matched = [...label].filter((w) => wordSet.has(w));
    if (matched.length === 0) continue;
    const coverage = matched.length / label.size;
    if (coverage < LABEL_COVERAGE_MIN) continue;
    const rarity = Math.max(...matched.map((w) => 1 / (rowFreq.get(w) ?? 1)));
    scored.push({ idx, rarity, coverage });
  }
  return scored;
}

/** Picks the one row whose label identifies the claim's subject; a genuine tie declines. Lexicographic decision, distinct from pickBestRowWithMargin's combined-score one. D018 §5.2. */
function pickBestRow(rows: Array<{ labelWords: string[] }>, claimWords: Set<string>, allRows: Array<{ labelWords: string[] }>): number | null {
  let best: RowScore | null = null;
  let tied = false;
  for (const candidate of scoreRows(rows, claimWords, allRows)) {
    if (!best || candidate.rarity > best.rarity || (candidate.rarity === best.rarity && candidate.coverage > best.coverage)) {
      best = candidate;
      tied = false;
    } else if (candidate.rarity === best.rarity && candidate.coverage === best.coverage) {
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

interface RowPoolEntry {
  labelWords: string[];
  passage: RetrievedPassage;
  rowText: string;
  facts: ExtractedNumericFact[];
  /** Computed once per passage here, reused by parseCleanTableRow's callers instead of re-detecting. */
  tableCandidate: TableCandidate | null;
}

/** Shared row-pooling scaffold for collectPassageFacts/resolveComparisonSide. `factFilter` and `admitHeaderlessBareRows` are the two divergences — see call sites and D018 §5.14 addendum. */
function buildRowPool(
  claim: Claim,
  passages: RetrievedPassage[],
  factFilter: (fact: ExtractedNumericFact) => boolean = () => true,
  admitHeaderlessBareRows = false
): { pool: RowPoolEntry[]; allRows: PassageRow[] } {
  const pool: RowPoolEntry[] = [];
  const allRows: PassageRow[] = [];
  for (const passage of passages) {
    if (passagePeriodConflicts(claim.period, passage.text)) continue;
    const rows = segmentRows(passage.text);
    allRows.push(...rows);
    const byRow = new Map<number, ExtractedNumericFact[]>();
    for (const { fact, index } of extractNumericFactsWithIndex(passage.text)) {
      if (!factFilter(fact)) continue;
      const idx = rowIndexFor(rows, index);
      byRow.set(idx, [...(byRow.get(idx) ?? []), fact]);
    }
    const tableCandidate = detectTableCandidate(passage.text);
    const bareRowsAdmissible = tableCandidate !== null || (admitHeaderlessBareRows && detectColumnConsistency(passage.text) !== null);
    for (let i = 0; i < rows.length; i++) {
      const rowText = passage.text.slice(rows[i]!.start, rows[i + 1]?.start ?? passage.text.length);
      const facts = byRow.get(i) ?? [];
      if (facts.length === 0 && (!bareRowsAdmissible || !rows[i]!.ownLabel || rowCells(rowText).length === 0)) continue;
      pool.push({ labelWords: rows[i]!.labelWords, passage, rowText, facts, tableCandidate });
    }
  }
  return { pool, allRows };
}

/** Same-unit figures from the ONE row whose label names the claim's subject. Callers decide by unanimity, never by picking one. D018 §5.2. */
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
  const { pool, allRows } = buildRowPool(claim, passages, (fact) => isUsableNumericFact(claimFact, fact));
  if (pool.length === 0) return none;

  const best = pickBestRow(pool, claimWords, allRows);
  if (best === null) return none; // nothing identifies this claim's subject, or a genuine tie — don't guess
  const chosen = pool[best]!;

  // Subject settled, so the row is read as a table and narrowed to the claim's period. D018 §5.2/§5.11.
  const table = tableRowFacts(claim, claimFact, chosen.rowText, chosen.passage.text, chosen.tableCandidate);
  const facts = table && table.periodCells.length > 0 ? table.periodCells : chosen.facts;
  return {
    candidates: facts.map((fact) => ({ fact, passageId: chosen.passage.passageId, passageText: chosen.passage.text })),
    rowSiblings: table?.allCells ?? [],
  };
}

/** Shared "is this a clean, parseable table row" gate for tableRowFacts/firstUsableTableFact. `tableCandidate`, if the caller already has one, skips redetection. D018 §5.2/§5.14. */
function parseCleanTableRow(
  rowText: string,
  passageText: string,
  tableCandidate?: TableCandidate | null
): { cells: RowCell[]; columns: ParsedColumn[]; tableScale: string | null } | null {
  const detected = tableCandidate !== undefined ? tableCandidate : detectTableCandidate(passageText);
  if (!detected) return null;
  const cells = rowCells(rowText);
  if (cells.length < 2 || cells.length !== detected.columnCount) return null;
  const columns = columnsForCells(passageText, cells.map((c) => c.unit));
  if (!columns) return null;
  return { cells, columns, tableScale: tableScaleOf(passageText) };
}

/** The metric row's cells: those matching the claim's period, and all of them. D018 §5.11. */
function tableRowFacts(
  claim: Claim,
  claimFact: ExtractedNumericFact,
  rowText: string,
  passageText: string,
  tableCandidate?: TableCandidate | null
): { periodCells: ExtractedNumericFact[]; allCells: ExtractedNumericFact[] } | null {
  const clean = parseCleanTableRow(rowText, passageText, tableCandidate);
  if (!clean) return null;
  const { cells, columns, tableScale } = clean;

  // With row and column pinned, the table's stated scale governs its bare cells, so a claim carrying a
  // different scale word (or one the table never states) is not comparable.
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

// ─── Cross-row/cross-metric comparison claims (D018 §5.14) ──────────────────
// A claim like "iPhone net sales were higher than Services net sales" has NO number in the claim text
// at all — just two subjects and a comparator verb — so extractNumericFact(claim.claimText), which
// every reconciler above depends on, returns nothing. This needs its own resolution path per side.

type ComparisonOperator = "gt" | "lt" | "eq";

interface ComparisonClaim {
  leftSubject: string;
  rightSubject: string;
  operator: ComparisonOperator;
}

/** One entry per confirmed comparator phrase; extend only as real claim text justifies it. D018 §5.14. */
// was/were collapsed into one alternation per phrase (matches CONTRADICTION_LANGUAGE_RE's own
// (?:is|are|was|were) convention a few hundred lines below) rather than a separate entry per tense. D018 §5.14.
const COMPARISON_PATTERNS: Array<{ re: RegExp; operator: ComparisonOperator }> = [
  { re: /\bexceeded\b/gi, operator: "gt" },
  { re: /\bsurpassed\b/gi, operator: "gt" },
  { re: /\boutperformed\b/gi, operator: "gt" },
  { re: /\btopped\b/gi, operator: "gt" },
  { re: /\b(?:was|were)\s+higher\s+than\b/gi, operator: "gt" },
  { re: /\b(?:was|were)\s+greater\s+than\b/gi, operator: "gt" },
  { re: /\b(?:was|were)\s+more\s+than\b/gi, operator: "gt" },
  { re: /\b(?:was|were)\s+larger\s+than\b/gi, operator: "gt" },
  { re: /\b(?:was|were)\s+bigger\s+than\b/gi, operator: "gt" },
  { re: /\boutpaced\b/gi, operator: "gt" },
  { re: /\b(?:was|were)\s+lower\s+than\b/gi, operator: "lt" },
  { re: /\b(?:was|were)\s+less\s+than\b/gi, operator: "lt" },
  { re: /\b(?:was|were)\s+smaller\s+than\b/gi, operator: "lt" },
  { re: /\b(?:was|were)\s+fewer\s+than\b/gi, operator: "lt" },
  { re: /\btrailed\b/gi, operator: "lt" },
  { re: /\bfell\s+short\s+of\b/gi, operator: "lt" },
  { re: /\bmatched\b/gi, operator: "eq" },
  { re: /\bequaled\b/gi, operator: "eq" },
  { re: /\b(?:was|were)\s+equal\s+to\b/gi, operator: "eq" },
];

// extractNumericFact/extractAllNumericFacts only ever read USD or percent — a subject naming a count
// measure these regexes can't represent must decline, not silently resolve against a dollar row that
// merely mentions the same product name. Found live (2026-08-03): "iPhone unit sales exceeded Mac unit
// sales" resolved supported off the two rows' NET SALES dollar figures — a measure mismatch, not a
// period or scale one. D018 §5.14.
const NON_MONETARY_MEASURE_RE = /\b(units?|shipments?|activations?|subscribers?|downloads?|installs?|headcount|employees?|users?)\b/i;

/** Splits a claim into its two compared subjects and the operator. Declines on zero or 2+ comparator phrases. D018 §5.14. */
export function extractComparisonClaim(claimText: string): ComparisonClaim | null {
  const matches: Array<{ start: number; end: number; operator: ComparisonOperator }> = [];
  for (const { re, operator } of COMPARISON_PATTERNS) {
    for (const m of claimText.matchAll(re)) {
      matches.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, operator });
    }
  }
  if (matches.length !== 1) return null;
  const { start, end, operator } = matches[0]!;
  const leftSubject = claimText.slice(0, start).trim();
  const rightSubject = claimText.slice(end).trim().replace(/^[.,;:]+|[.,;:]+$/g, "");
  if (leftSubject.length < 3 || rightSubject.length < 3) return null;
  return { leftSubject, rightSubject, operator };
}

/** Same scoring as pickBestRow, but requires a genuine MARGIN over the second-best candidate, not just "no exact tie" — no target value to fall back on if the row match is close. D018 §5.14. */
const ROW_MATCH_MARGIN_MIN = 0.15;

// A margin over the second-best candidate protects against ambiguity between two matches, but not a
// single weak one (no competing candidate to be ambiguous against) — this floor closes that gap. D018 §5.14.
const MIN_ROW_SCORE = 0.3;

function pickBestRowWithMargin(
  rows: Array<{ labelWords: string[] }>,
  subjectWords: Set<string>,
  allRows: Array<{ labelWords: string[] }>,
  rowFreq?: Map<string, number>
): number | null {
  const scored = scoreRows(rows, subjectWords, allRows, rowFreq)
    .map(({ idx, rarity, coverage }) => ({ idx, score: rarity * coverage }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const top = scored[0]!;
  if (top.score < MIN_ROW_SCORE) return null;
  const second = scored[1];
  if (second && top.score - second.score < ROW_MATCH_MARGIN_MIN) return null;
  return top.idx;
}

/** A table cell tagged by its column's (duration, period) — period alone isn't unique across a quarter/six-month pair. D018 §5.14. */
interface PeriodTaggedFact {
  fact: ExtractedNumericFact;
  periodKey: string;
}

function periodKeyOf(column: ParsedColumn): string {
  return `${column.duration ?? ""}|${column.period}`;
}

interface TableFactResolution {
  /** Narrowed to exactly one candidate — the confident, no-ambiguity answer. Null when narrowing left 2+. */
  resolved: ExtractedNumericFact | null;
  /** Every same-unit cell in the row, tagged by column — lets the caller check cross-period unanimity when `resolved` is null instead of declining outright. D018 §5.14. */
  candidates: PeriodTaggedFact[];
}

/** Reads a table row's period columns, USD then percent; falls back to position-tagged candidates (namespaced by passageId) when there's no header. D018 §5.14 addendum. */
function firstUsableTableFact(
  rowText: string,
  passageText: string,
  periodText: string,
  passageId: string,
  tableCandidate?: TableCandidate | null
): TableFactResolution | null {
  const detected = tableCandidate !== undefined ? tableCandidate : detectTableCandidate(passageText);
  // detectTableCandidate requires 2+ header dates by design (D018 §5's "not a tunable" rule) — correct
  // for named-period resolution, but positional alignment never claims a real period, only "same column
  // structure, same passage." detectColumnConsistency is the weaker, date-free version of that same
  // column-count check, used ONLY to gate positional candidates. Found live (2026-08-03): the real
  // income-statement excerpt has zero header dates, so detectTableCandidate itself never fired at all —
  // not just columnsForCells. D018 §5.14 addendum.
  const columnCount = detected?.columnCount ?? detectColumnConsistency(passageText);
  if (columnCount === null) return null;
  const cells = rowCells(rowText);
  if (cells.length < 2 || cells.length !== columnCount) return null;
  const tableScale = tableScaleOf(passageText);
  const columns = detected ? columnsForCells(passageText, cells.map((c) => c.unit)) : null;

  let fallback: PeriodTaggedFact[] | null = null;
  for (const unit of ["USD", "percent"] as const) {
    const sameUnitIdx = cells.map((cell, i) => ({ cell, i })).filter(({ cell }) => cell.unit === unit);
    if (sameUnitIdx.length === 0) continue;
    const toFact = (cell: RowCell) => ({ value: cell.value, unit, scale: unit === "USD" ? tableScale : null });

    if (columns) {
      const sameUnit = sameUnitIdx.map(({ cell, i }) => ({ cell, column: columns[i]! }));
      const tagged = sameUnit.map((c) => ({ fact: toFact(c.cell), periodKey: periodKeyOf(c.column) }));
      const narrowed = narrowByPeriod(sameUnit, periodText);
      if (narrowed.length === 1) return { resolved: toFact(narrowed[0]!.cell), candidates: tagged };
      if (!fallback) fallback = tagged; // remember USD's candidates even if percent narrows later
    } else if (!fallback) {
      // No header to name periods — positional alignment only, namespaced to this passage.
      fallback = sameUnitIdx.map(({ cell, i }) => ({ fact: toFact(cell), periodKey: `pos:${passageId}:${i}` }));
    }
  }
  return fallback ? { resolved: null, candidates: fallback } : null;
}

interface ComparisonSideResolution {
  /** Set only when the row/period resolved to exactly one fact — the fast, unambiguous path. */
  fact: ExtractedNumericFact | null;
  passageId: string;
  passageText: string;
  /** Every same-unit candidate this row offers, tagged by period — used for cross-period unanimity when `fact` is null. Empty for prose rows (no period tagging is possible there). */
  periodCandidates: PeriodTaggedFact[];
}

/** Resolves one side of a comparison claim, or declines (null) if the row itself can't be identified. Takes an already-built pool, not `passages` — see buildRowPool's caller. D018 §5.14. */
function resolveComparisonSide(
  subjectWords: Set<string>,
  pool: RowPoolEntry[],
  allRows: PassageRow[],
  periodText: string,
  rowFreq?: Map<string, number>
): ComparisonSideResolution | null {
  if (subjectWords.size === 0 || pool.length === 0) return null;

  const bestIdx = pickBestRowWithMargin(pool, subjectWords, allRows, rowFreq);
  if (bestIdx === null) return null;
  const chosen = pool[bestIdx]!;

  const table = firstUsableTableFact(chosen.rowText, chosen.passage.text, periodText, chosen.passage.passageId, chosen.tableCandidate);
  if (table) {
    return { fact: table.resolved, passageId: chosen.passage.passageId, passageText: chosen.passage.text, periodCandidates: table.candidates };
  }
  // Prose fallback: no column/period tagging is available in free text, so there is no unanimity path —
  // the row's own facts must resolve to exactly one figure, or this side declines. D018 §5.2/§5.14.
  if (chosen.facts.length === 1) {
    return { fact: chosen.facts[0]!, passageId: chosen.passage.passageId, passageText: chosen.passage.text, periodCandidates: [] };
  }
  return null;
}

/** Resolves by unanimity across every shared period instead of picking one — same discipline as collectPassageFacts. Unshared periods are skipped; genuine disagreement declines. D018 §5.14. */
function unanimousComparisonAcrossPeriods(
  left: PeriodTaggedFact[],
  right: PeriodTaggedFact[],
  operator: ComparisonOperator
): { holds: boolean; leftFact: ExtractedNumericFact; rightFact: ExtractedNumericFact } | null {
  const rightByPeriod = new Map(right.map((r) => [r.periodKey, r.fact]));
  let holds: boolean | null = null;
  let citedLeft: ExtractedNumericFact | null = null;
  let citedRight: ExtractedNumericFact | null = null;

  for (const l of left) {
    const r = rightByPeriod.get(l.periodKey);
    if (!r || !isUsableNumericFact(l.fact, r)) continue;
    const cmp = compare(
      { value: l.fact.value, unit: l.fact.unit, scale: l.fact.scale, period: null },
      { value: r.value, unit: r.unit, scale: r.scale, period: null }
    );
    if (!cmp.comparable || cmp.equal === null) continue;
    const pairHolds = cmp.equal ? operator === "eq" : operator === "gt" ? cmp.direction > 0 : operator === "lt" ? cmp.direction < 0 : false;
    if (holds === null) {
      holds = pairHolds;
      citedLeft = l.fact;
      citedRight = r;
    } else if (holds !== pairHolds) {
      return null; // genuinely period-dependent — decline rather than guess which period the claim means
    }
  }
  return holds === null ? null : { holds, leftFact: citedLeft!, rightFact: citedRight! };
}

/** Two-metric comparison claims ("X exceeded Y") — no number in the claim text for any reconciler above to extract. Resolves each side independently; declines unless BOTH resolve. D018 §5.14. */
export function reconcileComparisonVerdict(
  claim: Claim,
  result: { verdict: string; evidence: string[] | null; note: string | null; confidence?: number },
  passages: RetrievedPassage[] = []
): { verdict: string; note: string | null; confidence: number; evidence?: string[]; sourceRefs?: string[] } {
  const confidence = result.confidence ?? 1;
  if (result.note && CODE_OVERRIDE_TAG_RE.test(result.note)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const comparison = extractComparisonClaim(claim.claimText);
  if (!comparison) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  if (NON_MONETARY_MEASURE_RE.test(comparison.leftSubject) || NON_MONETARY_MEASURE_RE.test(comparison.rightSubject)) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  // Both subjects, without the comparator word itself — feeds narrowByPeriod without tripping its own
  // "than" baseline-marker heuristic (see firstUsableTableFact). D018 §5.14.
  const periodText = `${comparison.leftSubject} ${comparison.rightSubject}`;
  // Built once, reused for both sides — the pool depends only on passages/claim.period, never on which
  // side is being resolved. D018 §5.14.
  const { pool, allRows } = buildRowPool(claim, passages, undefined, true);
  const rowFreq = buildRowFreq(allRows);
  const left = resolveComparisonSide(new Set(contentWords(comparison.leftSubject)), pool, allRows, periodText, rowFreq);
  const right = resolveComparisonSide(new Set(contentWords(comparison.rightSubject)), pool, allRows, periodText, rowFreq);
  if (!left || !right) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  let holds: boolean;
  let citedLeft: ExtractedNumericFact;
  let citedRight: ExtractedNumericFact;

  if (left.fact && right.fact) {
    // Fast path: both sides narrowed to exactly one fact. isUsableNumericFact is already symmetric
    // (compares its two args to each other) — reused directly rather than duplicated. D018 §5.14 addendum.
    if (!isUsableNumericFact(left.fact, right.fact)) {
      return { verdict: result.verdict, note: result.note, confidence };
    }
    const cmp = compare(
      { value: left.fact.value, unit: left.fact.unit, scale: left.fact.scale, period: claim.period },
      { value: right.fact.value, unit: right.fact.unit, scale: right.fact.scale, period: claim.period }
    );
    if (!cmp.comparable || cmp.equal === null) {
      return { verdict: result.verdict, note: result.note, confidence };
    }
    // direction reuses compare()'s own already-canonicalized values — no separate normalize() call here,
    // so this can never disagree with cmp.equal. D018 §5.14 addendum.
    holds = cmp.equal ? comparison.operator === "eq" : comparison.operator === "gt" ? cmp.direction > 0 : comparison.operator === "lt" ? cmp.direction < 0 : false;
    citedLeft = left.fact;
    citedRight = right.fact;
  } else {
    // At least one side didn't narrow to a single period. If both are still clean table rows with
    // period-tagged candidates, resolve by cross-period unanimity instead of guessing which period the
    // claim means — found live (2026-08-03): a claim naming no period at all ("SG&A exceeded R&D") got
    // raw-LLM-guessed `supported` although R&D exceeded SG&A in every period the table showed. D018 §5.14.
    const unanimous = unanimousComparisonAcrossPeriods(left.periodCandidates, right.periodCandidates, comparison.operator);
    if (!unanimous) {
      return { verdict: result.verdict, note: result.note, confidence };
    }
    holds = unanimous.holds;
    citedLeft = unanimous.leftFact;
    citedRight = unanimous.rightFact;
  }

  const targetVerdict = holds ? "supported" : "contradicted";
  if (result.verdict === targetVerdict) {
    return { verdict: result.verdict, note: result.note, confidence };
  }

  const byPassage = new Map([
    [left.passageId, left.passageText],
    [right.passageId, right.passageText],
  ]);
  return {
    verdict: targetVerdict,
    note: buildOverrideNote(
      `[verdict set by code: ${formatFact(citedLeft)} vs ${formatFact(citedRight)} ${holds ? "confirms" : "contradicts"} the claimed comparison — D018 §5.14]`,
      result.note
    ),
    confidence: 1,
    evidence: [...byPassage.values()],
    sourceRefs: [...byPassage.keys()],
  };
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
// Inequality vocabulary for comparison claims — a cheap safety net, the real fix is the comparator.
// Every added phrase MUST be a negated form (no `claim` param here to tell a direction apart). D018 §5.14.
// Kept in sync with COMPARISON_PATTERNS' vocabulary (gt/lt/eq verbs below) — found on review
// (2026-08-03): "match" was grouped with exceed/surpass (a gt concept) even though it's the eq verb
// COMPARISON_PATTERNS itself uses; moved to its own eq-negation group. D018 §5.14.
// Exported — reused by Grounnel's own reason-consistency gate (gates.ts), not reimplemented there.
// This is the hardened, incident-tuned version; a fresh regex for the same problem would repeat
// mistakes this one already paid for (see the comment history above each incident date).
export const CONTRADICTION_LANGUAGE_RE =
  /\b(contradict(?:s|ing)?|(?:is|are|was|were|be|being|been)\s+contradicted|conflict(?:s|ed|ing)?\s+with|differ(?:s|ed|ing)?\s+from|is\s+inconsistent\s+with|(?:did|does)\s+not\s+(?:exceed|surpass|outpace|outperform|top)|(?:is|are|was|were)\s+not\s+(?:higher|greater|more|larger|bigger)\s+than|(?:is|are|was|were)\s+not\s+(?:lower|less|smaller|fewer)\s+than|(?:did|does)\s+not\s+fall\s+(?:short\s+of|below)|(?:did|does)\s+not\s+(?:match|equal))\b/i;
// Clause-scoped negation, not fixed char count; "n't" has no leading \b (contractions have no word boundary before 'n'). D018 §5.5.
// Widened in lockstep with CONTRADICTION_LANGUAGE_RE — widening only the positive side would let
// "does not contradicted"-shaped negations through as real contradictions. D018 §5.5.
export const NEGATED_CONTRADICTION_RE =
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
