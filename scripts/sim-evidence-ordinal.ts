/**
 * Offline simulation of an EVIDENCE-SIDE ordinal check. Zero API calls, ships nothing.
 *
 * D030 §3i shelved this idea on a 5-run / 13-claim prototype. This replays candidate rules against
 * the whole persisted corpus (~8.8k claims) instead, scoring against golden-set ground truth.
 * Reuses the gate's own validated regex/anchor machinery so the simulation matches production
 * semantics rather than approximating them.
 *
 * Bar: FALSE ACCUSATIONS INTRODUCED must be 0 (D030 §3d makes reason_ordinal contradictions
 * immune to reconciliation — a false positive here is unrecoverable).
 *
 * Usage: npx tsx --env-file=.env scripts/sim-evidence-ordinal.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { SELECTOR_RE_G, anchorWords, anchorsOverlap, firstClauseBoundaryForward, isSentenceTerminator } from "../src/lib/instance-selector";
import { NEGATION_CUE_RE } from "../src/orchestrators/grounnel/gates-shared";

const NEGATION_WINDOW = 60;

// Replicated from gates-reason-grounded.ts (both are module-private there). Kept byte-faithful so a
// flag here means the same thing it would mean in the gate.
function lastClauseBoundary(window: string): number {
  let last = -1;
  for (let i = 0; i < window.length; i++) {
    const ch = window[i]!;
    if (ch === ";" || ch === "," || ch === "!" || ch === "?") last = i;
    else if (ch === "." && isSentenceTerminator(window, i)) last = i;
  }
  return last;
}
function isNegatedAtPosition(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - NEGATION_WINDOW);
  const window = text.slice(windowStart, matchIndex);
  const clauseStart = lastClauseBoundary(window);
  return NEGATION_CUE_RE.test(clauseStart === -1 ? window : window.slice(clauseStart + 1));
}
function isClaimTokenNegated(claimText: string, matchIndex: number, matchLength: number): boolean {
  if (isNegatedAtPosition(claimText, matchIndex)) return true;
  const afterStart = matchIndex + matchLength;
  const clauseEndAbs = firstClauseBoundaryForward(claimText, afterStart);
  const windowEnd = Math.min(afterStart + NEGATION_WINDOW, clauseEndAbs === -1 ? claimText.length : clauseEndAbs);
  return NEGATION_CUE_RE.test(claimText.slice(afterStart, windowEnd));
}

// P3's two documented false-positive classes (D030 §3i), the prerequisites the ADR named.
const TEMPORAL_IDIOM_RE = /\b(last|next|this|same)\s+(year|quarter|month|week|day|season)\b/i;
const DIMENSION_ALIAS_RE = /\b(fiscal|calendar|financial)\b/i;

// The claim's own number+unit ("852 feet"), the fact the ordinal is being asserted about.
const NUMBER_UNIT_RE = /(\d[\d,.]*)\s*([a-zA-Z]+)/g;
const UNIT_ALIASES: Record<string, string> = { ft: "feet", foot: "feet" };
function valuesOf(text: string): string[] {
  return [...text.matchAll(NUMBER_UNIT_RE)].map((m) => {
    const u = m[2]!.toLowerCase();
    return `${m[1]!.replace(/[,.]$/, "")} ${UNIT_ALIASES[u] ?? u}`;
  });
}

interface Variant { name: string; anchor: boolean; negation: boolean; temporal: boolean; dimension: boolean; valueScoped?: boolean }
const VARIANTS: Variant[] = [
  { name: "V0 naive (ordinal mismatch only)", anchor: false, negation: false, temporal: false, dimension: false },
  { name: "V1 + anchor overlap",              anchor: true,  negation: false, temporal: false, dimension: false },
  { name: "V2 + claim-negation guard",        anchor: true,  negation: true,  temporal: false, dimension: false },
  { name: "V3 + temporal-idiom guard",        anchor: true,  negation: true,  temporal: true,  dimension: false },
  { name: "V4 + dimension-alias guard",       anchor: true,  negation: true,  temporal: true,  dimension: true },
  { name: "V5 + value-scoped (ordinal's clause must carry the claim's own value)", anchor: true, negation: true, temporal: true, dimension: true, valueScoped: true },
];

const AFFIRMATIVE = new Set(["supported", "partially_supported"]);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Would this rule flag the claim as an ordinal mismatch against its own cited evidence? */
function flags(v: Variant, claimText: string, evidence: string): { hit: boolean; claimOrd?: string; evOrd?: string } {
  const claimValues = v.valueScoped ? valuesOf(claimText) : [];
  if (v.valueScoped && claimValues.length === 0) return { hit: false };
  const claimMatches = [...claimText.matchAll(SELECTOR_RE_G)];
  if (claimMatches.length !== 1) return { hit: false };
  const cm = claimMatches[0]!;
  if (v.negation && isClaimTokenNegated(claimText, cm.index!, cm[0].length)) return { hit: false };
  const claimOrd = cm[1]!.toLowerCase();
  const claimAnchor = anchorWords(claimText, cm.index!, cm.index! + cm[0].length);
  if (v.anchor && claimAnchor.size === 0) return { hit: false };

  for (const em of evidence.matchAll(SELECTOR_RE_G)) {
    const evOrd = em[1]!.toLowerCase();
    if (evOrd === claimOrd) continue;
    if (v.negation && isNegatedAtPosition(evidence, em.index!)) continue;
    if (v.anchor && !anchorsOverlap(claimAnchor, anchorWords(evidence, em.index!, em.index! + em[0].length))) continue;
    const clauseEnd = firstClauseBoundaryForward(evidence, em.index!);
    const clause = evidence.slice(Math.max(0, em.index! - 80), clauseEnd === -1 ? em.index! + 80 : clauseEnd);
    if (v.temporal && TEMPORAL_IDIOM_RE.test(clause)) continue;
    if (v.dimension && DIMENSION_ALIAS_RE.test(clause)) continue;
    // The evidence ordinal must be asserted about the SAME fact the claim is: evidence describing a
    // sequence names every member, so anchor overlap alone flags "fourth" against a stray "second".
    if (v.valueScoped) {
      const evClause = evidence.slice(Math.max(0, em.index! - 160), clauseEnd === -1 ? em.index! + 160 : clauseEnd);
      const evValues = valuesOf(evClause);
      if (!claimValues.some((cv) => evValues.includes(cv))) continue;
    }
    return { hit: true, claimOrd, evOrd };
  }
  return { hit: false };
}

async function main() {
  const golden: any = JSON.parse(readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json", "utf8"));
  const db = getDb();
  const raw = (await db.execute(sql`
    SELECT r.source, r.text AS runtext, c.claim_text AS ct, c.evidence AS ev, c.verdict AS v
    FROM grounnel.grounnel_claims c JOIN grounnel.grounnel_runs r ON r.run_id = c.run_id
    WHERE c.evidence IS NOT NULL AND c.verdict IN ('supported','partially_supported')
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const rows = Array.isArray(raw) ? raw : raw.rows;

  // Ground truth: for eval claims, the golden set says what the answer should have been.
  const truth = (runtext: string, ct: string): string | null => {
    for (const gc of golden.cases) {
      if (norm(runtext) !== norm(gc.text)) continue;
      for (const exp of gc.claims) if (norm(ct).includes(norm(exp.match))) return exp.kind;
    }
    return null;
  };

  console.log(`corpus: ${rows.length} affirmative claims with cited evidence\n`);
  const table: any[] = [];
  const faSamples: Record<string, string[]> = {};
  const catchSamples: string[] = [];

  for (const v of VARIANTS) {
    let flagged = 0, fa = 0, caught = 0, unknown = 0;
    for (const r of rows) {
      const ct = String(r.ct), ev = String(r.ev);
      const res = flags(v, ct, ev);
      if (!res.hit) continue;
      flagged++;
      const kind = String(r.source) === "eval" ? truth(String(r.runtext), ct) : null;
      if (kind === null) { unknown++; continue; }
      if (kind === "false") {
        caught++;
        if (v.name.startsWith("V4") && catchSamples.length < 4) catchSamples.push(`${ct.slice(0, 80)}  [ev says "${res.evOrd}"]`);
      } else {
        fa++;
        (faSamples[v.name] ??= []).length < 4 && faSamples[v.name]!.push(`(${kind}) ${ct.slice(0, 88)}  [ev "${res.evOrd}"]`);
      }
    }
    table.push({ variant: v.name, flagged, "REAL CATCHES": caught, "FALSE ACCUSATIONS": fa, "prod (no truth)": unknown });
  }
  console.table(table);
  for (const [name, s] of Object.entries(faSamples)) {
    console.log(`\nfalse accusations under ${name}:`);
    for (const x of s) console.log(`   ${x}`);
  }
  if (catchSamples.length) { console.log("\nreal catches under V4:"); for (const x of catchSamples) console.log(`   ${x}`); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
