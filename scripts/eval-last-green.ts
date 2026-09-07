/**
 * When was the golden suite last green? Re-scores every eval day from persisted claims.
 *
 * The eval job writes no scorecard, so a run's outcome is unreadable after the fact and "when did
 * this last pass" is otherwise unanswerable. This calls the REAL gate (`evaluateGrounnelRun`) rather
 * than reimplementing its rules — an earlier hand-synced copy reported 2026-08-31 as green when 27
 * of 28 cases had produced no scoreable claim at all. Zero API cost.
 *
 * Usage: npx tsx --env-file=.env scripts/eval-last-green.ts [--since YYYY-MM-DD]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { evaluateGrounnelRun, MIN_VERDICT_REPETITIONS, type GrounnelRun } from "../src/evaluation/grounnel-live-gate";

const args = process.argv.slice(2);
const since = (() => { const i = args.indexOf("--since"); return i !== -1 && args[i + 1] ? args[i + 1]! : "2026-08-01"; })();
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

interface GoldenCase { id: string; text: string; minCorrectRate: number; detectionFloor?: number; claims: Array<{ match: string; kind: string }> }

async function main() {
  const golden: { cases: GoldenCase[] } = JSON.parse(
    readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json", "utf8"),
  );
  const db = getDb();
  const raw = (await db.execute(sql`
    SELECT r.created_at::date::text AS d, r.run_id::text AS id, r.text,
           coalesce(json_agg(json_build_object('text', c.claim_text, 'verdict', c.verdict))
                    FILTER (WHERE c.claim_id IS NOT NULL), '[]'::json) AS claims
    FROM grounnel.grounnel_runs r
    LEFT JOIN grounnel.grounnel_claims c ON c.run_id = r.run_id
    WHERE r.source = 'eval' AND r.text NOT LIKE '[%' AND r.created_at::date >= ${since}
    GROUP BY 1, 2, 3 ORDER BY 1
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const allRuns = Array.isArray(raw) ? raw : raw.rows;
  const days = [...new Set(allRuns.map((r) => String(r.d)))].sort();

  console.log("day          cases  binding  FA  failing   verdict");
  for (const day of days) {
    const today = allRuns.filter((r) => String(r.d) === day);
    let seen = 0, fa = 0, nonBinding = 0;
    const failing: Array<{ label: string; binding: boolean }> = [];
    for (const gc of golden.cases) {
      const reps = today.filter((r) => norm(String(r.text)) === norm(gc.text));
      if (!reps.length) continue;
      seen++;
      const runs: GrounnelRun[] = reps.map((r) => ({ id: String(r.id), claims: r.claims as GrounnelRun["claims"] }));
      const res = evaluateGrounnelRun(runs, {
        id: gc.id, claims: gc.claims as never, minCorrectRate: gc.minCorrectRate, detectionFloor: gc.detectionFloor,
      });
      if (!res.verdictIsBinding) nonBinding++;
      fa += res.violations.filter((v) => v.rule === "no_false_accusation").length;
      if (!res.ok) failing.push({
        label: `${gc.id} [N=${res.runs}${res.verdictIsBinding ? "" : ", indicative"}] ${res.violations.map((v) => v.rule).join(",")}`,
        binding: res.verdictIsBinding,
      });
    }
    // Ask the gate, never the rendered string — re-deriving from display text is how a hand-synced
    // copy of these rules once reported 2026-08-31 as green.
    const bindingFailures = failing.filter((f) => f.binding);
    const indicativeFailures = failing.length - bindingFailures.length;
    const verdict = fa > 0 ? "RED (false accusation)"
      : bindingFailures.length ? "RED"
      // A failure nobody has the samples to stand behind is not a pass either — say inconclusive
      // rather than green, or this tool reproduces the misleading-green bug it exists to avoid.
      : indicativeFailures > 0 ? `INCONCLUSIVE (${indicativeFailures} case(s) failed at N<${MIN_VERDICT_REPETITIONS})`
      : nonBinding === seen ? `indicative only (all cases N<${MIN_VERDICT_REPETITIONS})`
      : seen === golden.cases.length ? "GREEN (full suite)" : `green (partial ${seen}/${golden.cases.length})`;
    console.log(`${day}   ${String(seen).padStart(2)}/${golden.cases.length}  ${String(seen - nonBinding).padStart(3)}/${String(seen).padEnd(2)}  ${String(fa).padStart(2)}  ${String(failing.length).padStart(7)}   ${verdict}`);
    for (const f of failing) console.log(`               ${f.label}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
