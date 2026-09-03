/**
 * When was the golden suite last green? Replays evaluateGrounnelRun's rules over every eval day.
 *
 * The eval job persists no scorecard, so a run's outcome is unreadable after the fact and "when did
 * this last pass" is otherwise unanswerable. Mirrors the real gate: the N=1 minCorrectRate floor vs
 * the N>1 safety+detection floors, and the matched===0 vacuous-green violation. Zero API cost.
 *
 * Usage: npx tsx --env-file=.env scripts/eval-last-green.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

const ACCEPTABLE: Record<string, string[]> = {
  true: ["supported", "partially_supported"],
  false: ["contradicted"],
  silence: ["unsupported", "unverifiable"],
  excluded: ["excluded"],
  not_excluded: ["supported", "partially_supported", "unsupported", "contradicted"],
};
const DETECTION_FLOOR = 0.8;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
interface GC { id: string; text: string; minCorrectRate?: number; detectionFloor?: number; claims: Array<{ match: string; kind: string }> }

async function main() {
  const golden: { cases: GC[] } = JSON.parse(readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json", "utf8"));
  const db = getDb();
  const raw = (await db.execute(sql`
    SELECT r.created_at::date::text AS d, r.run_id::text AS run_id, r.text,
           coalesce(json_agg(json_build_object('t', c.claim_text, 'v', c.verdict))
                    FILTER (WHERE c.claim_id IS NOT NULL), '[]'::json) AS claims
    FROM grounnel.grounnel_runs r
    LEFT JOIN grounnel.grounnel_claims c ON c.run_id = r.run_id
    WHERE r.source = 'eval' AND r.text NOT LIKE '[%'
    GROUP BY 1,2,3 ORDER BY 1`)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const allRuns = Array.isArray(raw) ? raw : raw.rows;
  const days = [...new Set(allRuns.map((x) => String(x.d)))].sort();

  console.log("day         cases  N    FA  vacuous  detFail  rateFail   VERDICT");
  for (const day of days) {
    const today = allRuns.filter((x) => String(x.d) === day);
    let seen = 0, fa = 0, vacuous = 0, detFail = 0, rateFail = 0; const bad: string[] = [];
    for (const gc of golden.cases) {
      const reps = today.filter((x) => norm(String(x.text)) === norm(gc.text));
      if (!reps.length) continue;
      seen++;
      let matched = 0, correct = 0, dObs = 0, dCor = 0, caseFA = 0;
      for (const gcl of gc.claims) {
        const acc = ACCEPTABLE[gcl.kind] ?? [];
        for (const run of reps) {
          const cl = run.claims as Array<{ t: string; v: string | null }>;
          const hit = cl.find((z) => norm(z.t).includes(norm(gcl.match)));
          if (!hit) continue;
          matched++;
          const v = hit.v ?? "null";
          const ok = acc.includes(v);
          if (ok) correct++;
          if (gcl.kind === "false") { dObs++; if (ok) dCor++; }
          if (gcl.kind !== "false" && gcl.kind !== "not_excluded" && v === "contradicted") caseFA++;
        }
      }
      fa += caseFA;
      const N = reps.length;
      const rate = matched === 0 ? 0 : correct / matched;
      const det = dObs === 0 ? null : dCor / dObs;
      let why = "";
      if (matched === 0) { vacuous++; why = "vacuous"; }
      else if (N === 1) { if (rate < (gc.minCorrectRate ?? 1)) { rateFail++; why = `rate ${rate.toFixed(2)}`; } }
      else if (det !== null && det < (gc.detectionFloor ?? DETECTION_FLOOR)) { detFail++; why = `det ${det.toFixed(2)}`; }
      if (caseFA > 0) why = why ? `${why}+FA${caseFA}` : `FA${caseFA}`;
      if (why) bad.push(`${gc.id}[N=${N}] ${why}`);
    }
    const verdict = bad.length === 0 ? (seen === golden.cases.length ? "GREEN (full)" : `green (${seen}/${golden.cases.length})`) : "RED";
    console.log(`${day}  ${String(seen).padStart(3)}/${golden.cases.length}       ${String(fa).padStart(3)}  ${String(vacuous).padStart(7)}  ${String(detFail).padStart(7)}  ${String(rateFail).padStart(8)}   ${verdict}`);
    if (bad.length) for (const b of bad) console.log(`               ${b}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
