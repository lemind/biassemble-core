/**
 * Table structure contract for column/period-aware comparison — D018 §5.
 *
 * Detection and validation here are deterministic. An LLM may TRANSCRIBE structure (which cell a number
 * occupies) between the two, never judge a claim; arithmetic and verdicts stay in code (D018 §2.3).
 * A block with no header carries no column identity and is ineligible — it falls back, never infers.
 */

export interface ParsedColumn {
  /** Verbatim duration token governing this column ("Three Months Ended"), or null when the block states none. */
  duration: string | null;
  /** Verbatim period token for this column ("March 28, 2026"). */
  period: string;
}

export interface ParsedRow {
  /** Verbatim row label as it appears in the block ("Europe"). */
  label: string;
  /** One entry per column, in the block's left-to-right order. `value` is the verbatim token. */
  values: Array<{ period: string; value: string }>;
}

export interface ParsedTable {
  columns: ParsedColumn[];
  rows: ParsedRow[];
}

export type ParseRejection =
  | "column_count_mismatch"
  | "period_not_in_block"
  | "period_order_mismatch"
  | "duration_not_in_block"
  | "row_label_not_in_block"
  | "row_value_count_mismatch"
  | "row_period_column_mismatch"
  | "duplicate_period_in_row"
  | "value_not_in_block"
  | "value_order_mismatch";

export type ValidationResult = { ok: true } | { ok: false; reason: ParseRejection; detail: string };

/** Duration and date tokens a filing table uses to identify its columns. */
const DURATION_RE = /(?:Three|Six|Nine|Twelve)\s+Months\s+Ended/gi;
const DATE_RE =
  /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|Q[1-4]\s+\d{4}/gi;
/** A run of consecutive numeric cells — the shape a table row makes. */
const NUMERIC_RUN_RE = /(?:[$(]?-?[\d,]+(?:\.\d+)?\)?%?[\s.]*){2,}/g;
const NUMERIC_CELL_RE = /-?[\d,]+(?:\.\d+)?/g;
const MIN_TABLE_ROWS = 3;

export interface TableCandidate {
  /** Authoritative column count, derived from the block itself — never taken from a transcriber. */
  columnCount: number;
  periodTokens: string[];
  durationTokens: string[];
}

/**
 * Deterministic gate: a block is column-aware only when it repeats equal-width numeric rows AND names at
 * least two periods. Headerless tabular text returns null — it is not eligible, and must fall back.
 */
export function detectTableCandidate(blockText: string): TableCandidate | null {
  const periodTokens = blockText.match(DATE_RE) ?? [];
  if (periodTokens.length < 2) return null;

  // Date tokens ("March 28, 2026") are numeric runs of their own and outvoted real data rows, so a
  // 4-row table reported columnCount 2. Strip them before measuring row width. D018 §5.
  const withoutDates = blockText.replace(DATE_RE, " ");
  const widths = new Map<number, number>();
  for (const run of withoutDates.match(NUMERIC_RUN_RE) ?? []) {
    const cells = run.match(NUMERIC_CELL_RE)?.length ?? 0;
    if (cells >= 2) widths.set(cells, (widths.get(cells) ?? 0) + 1);
  }
  let columnCount = 0;
  let best = 0;
  for (const [width, count] of widths) {
    if (count > best || (count === best && width > columnCount)) {
      best = count;
      columnCount = width;
    }
  }
  if (best < MIN_TABLE_ROWS || columnCount < 2) return null;

  return { columnCount, periodTokens, durationTokens: blockText.match(DURATION_RE) ?? [] };
}

/** Finds `needle` at or after `from`, so repeated header tokens are matched by occurrence, not by first hit. */
function indexOfFrom(haystack: string, needle: string, from: number): number {
  return needle.length === 0 ? -1 : haystack.indexOf(needle, from);
}

/**
 * Every rule must pass. The period-ORDER rule is the load-bearing one: a transposed parse (real values,
 * real labels, periods swapped between columns) reconstructs the value sequence perfectly and passes
 * verbatim checks, so only comparing the parsed period order against the block's own left-to-right header
 * order rejects it. D018 §5.
 */
export function validateTableParse(parse: ParsedTable, blockText: string, detected: TableCandidate): ValidationResult {
  const fail = (reason: ParseRejection, detail: string): ValidationResult => ({ ok: false, reason, detail });

  if (parse.columns.length !== detected.columnCount) {
    return fail("column_count_mismatch", `parse has ${parse.columns.length} columns, block has ${detected.columnCount}`);
  }

  for (const column of parse.columns) {
    if (!blockText.includes(column.period)) return fail("period_not_in_block", `"${column.period}" is not in the block`);
    if (column.duration !== null && !blockText.includes(column.duration)) {
      return fail("duration_not_in_block", `"${column.duration}" is not in the block`);
    }
  }

  // The parse's date columns must equal the block's TRAILING date-token run — the header itself. A
  // forward scan over the whole block is not enough: the intro sentence ("...periods ended March 28,
  // 2026 and March 29, 2025...") supplies extra tokens a transposed sequence can thread through and
  // pass. This comparison is what actually rejects a transposition. D018 §5.
  const parseDates = parse.columns.map((c) => c.period).filter((p) => new RegExp(DATE_RE.source, "i").test(p));
  const blockDates = blockText.match(DATE_RE) ?? [];
  const header = blockDates.slice(-parseDates.length);
  if (parseDates.length > 0 && (header.length !== parseDates.length || parseDates.some((p, i) => p !== header[i]))) {
    return fail("period_order_mismatch", `column periods [${parseDates}] do not match the block's header order [${header}]`);
  }

  const columnPeriods = parse.columns.map((c) => c.period);
  for (const row of parse.rows) {
    if (!blockText.includes(row.label)) {
      return fail("row_label_not_in_block", `row label "${row.label}" is not in the block`);
    }
    if (row.values.length !== parse.columns.length) {
      return fail("row_value_count_mismatch", `row "${row.label}" has ${row.values.length} values for ${parse.columns.length} columns`);
    }
    const seen = new Set<string>();
    for (let i = 0; i < row.values.length; i++) {
      const entry = row.values[i]!;
      if (entry.period !== columnPeriods[i]) {
        return fail("row_period_column_mismatch", `row "${row.label}" column ${i} is "${entry.period}", block order says "${columnPeriods[i]}"`);
      }
      const key = `${entry.period}|${parse.columns[i]!.duration ?? ""}`;
      if (seen.has(key)) return fail("duplicate_period_in_row", `row "${row.label}" assigns two values to ${key}`);
      seen.add(key);
    }

    // Values must appear in the block in the same left-to-right order the parse claims.
    let cursor = blockText.indexOf(row.label) + row.label.length;
    for (const entry of row.values) {
      const at = indexOfFrom(blockText, entry.value, cursor);
      if (at === -1) {
        return blockText.includes(entry.value)
          ? fail("value_order_mismatch", `value "${entry.value}" in row "${row.label}" is out of order`)
          : fail("value_not_in_block", `value "${entry.value}" is not in the block`);
      }
      cursor = at + entry.value.length;
    }
  }

  return { ok: true };
}

/** Currency | percent | bare, in column order. Bare last so "22%" is a percent; bare years are dates, not figures. D018 §5. */
const ROW_CELL_RE =
  /\$\s?(\()?\s*([\d,]+(?:\.\d+)?)\s*(\))?|\((-?[\d,]+(?:\.\d+)?)\)\s*%|(-?[\d,]+(?:\.\d+)?)\s*%|(?<![A-Za-z0-9.\-])([\d,]+(?:\.\d+)?)(?![A-Za-z])/g;

export interface RowCell {
  value: number;
  unit: "USD" | "percent";
}

/** Every cell of a row including the bare columns a `$`-anchored regex cannot see — SEC tables mark only the first and total rows. D018 §5. */
export function rowCells(rowText: string): RowCell[] {
  const out: RowCell[] = [];
  for (const m of rowText.matchAll(new RegExp(ROW_CELL_RE.source, "g"))) {
    if (m[2]) {
      let value = parseFloat(m[2].replace(/,/g, ""));
      if (Number.isNaN(value)) continue;
      if (m[1] === "(" || m[3] === ")") value = -Math.abs(value);
      out.push({ value, unit: "USD" });
    } else if (m[4]) {
      const value = parseFloat(m[4].replace(/,/g, ""));
      if (!Number.isNaN(value)) out.push({ value: -Math.abs(value), unit: "percent" });
    } else if (m[5]) {
      const value = parseFloat(m[5].replace(/,/g, ""));
      if (!Number.isNaN(value)) out.push({ value, unit: "percent" });
    } else if (m[6]) {
      if (/^(?:19|20)\d{2}$/.test(m[6])) continue;
      const value = parseFloat(m[6].replace(/,/g, ""));
      if (!Number.isNaN(value)) out.push({ value, unit: "USD" });
    }
  }
  return out;
}

/** Table-wide scale from the header ("dollars in millions") — real filing text, so bare cells get their unit. D018 §5. */
export function tableScaleOf(blockText: string): string | null {
  const m = blockText.match(/\b(?:dollars\s+in|amounts\s+in|in)\s+(million|billion|thousand)s?\b/i);
  const word = m?.[1]?.toLowerCase();
  return word === "million" || word === "billion" || word === "thousand" ? word : null;
}

/**
 * Maps a row's cells to columns using the block's own header. USD cells consume the header's trailing
 * date run in order; a percent ("Change") cell belongs to the period its group compares FROM, so it
 * inherits the first USD column of its run. Returns null when the header cannot cover the row — no
 * guessing. D018 §5.
 */
export function columnsForCells(blockText: string, cellUnits: Array<"USD" | "percent">): ParsedColumn[] | null {
  const dates = blockText.match(DATE_RE) ?? [];
  const durations = blockText.match(DURATION_RE) ?? [];
  const usdCount = cellUnits.filter((u) => u === "USD").length;
  if (usdCount === 0) return null;
  const headerDates = dates.slice(-usdCount);
  if (headerDates.length !== usdCount) return null;

  const perDuration = durations.length > 0 ? usdCount / durations.length : usdCount;
  const columns: ParsedColumn[] = [];
  let usdSeen = 0;
  let runStart = -1;
  for (const unit of cellUnits) {
    if (unit === "USD") {
      if (runStart === -1) runStart = columns.length;
      const duration = durations.length > 0 ? durations[Math.min(Math.floor(usdSeen / perDuration), durations.length - 1)] ?? null : null;
      columns.push({ duration, period: headerDates[usdSeen]! });
      usdSeen++;
    } else {
      const anchor = runStart === -1 ? null : columns[runStart];
      columns.push(anchor ? { ...anchor } : { duration: null, period: headerDates[0]! });
      runStart = -1;
    }
  }
  return columns;
}

/** The column satisfying a claim's period, or null. Deterministic: the transcriber never decides this. D018 §5. */
export function selectColumnForPeriod(columns: ParsedColumn[], claimPeriod: string | null): number | null {
  if (!claimPeriod) return null;
  const claimYear = claimPeriod.match(/(?<![\d.])(?:19|20)\d{2}(?![\d.])/)?.[0];
  if (!claimYear) return null;
  // Only filter on duration when the claim actually states one. "FY2026" names neither a quarter nor a
  // half, so it must not be read as "the six-month column" — it stays ambiguous and declines. D018 §5.
  const wantsQuarter = /\bQ[1-4]\b|quarterly|\bquarter\b/i.test(claimPeriod);
  const wantsHalf = /six[-\s]month|first six months|\bhalf\b/i.test(claimPeriod);

  const matches: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!;
    if (!column.period.includes(claimYear)) continue;
    if (column.duration && (wantsQuarter || wantsHalf)) {
      const isQuarter = /Three\s+Months/i.test(column.duration);
      if (wantsQuarter !== isQuarter) continue;
    }
    matches.push(i);
  }
  return matches.length === 1 ? matches[0]! : null;
}
