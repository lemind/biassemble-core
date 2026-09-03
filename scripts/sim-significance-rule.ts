/**
 * Offline simulation of a SIGNIFICANCE-based detection gate. Zero API calls, ships nothing.
 *
 * Today's rule fails a case whenever observed detection < floor. At N=2-5 that is mostly a coin:
 * a p=0.64 process trips a 0.80 floor ~60% of the time no matter what the code does.
 *
 * Candidate: fail only when the observation is statistically inconsistent with being AT the floor —
 * one-sided binomial, P(X <= observed | n, p = floor) < alpha. The floor stays 0.80; what changes is
 * that the gate must have enough samples to tell 0.64 from 0.80 before it may cry.
 *
 * Replays both rules over every eval day to answer two questions:
 *   1. how many red case-days were sampling noise (flip to green)?
 *   2. does it still catch REAL collapses (g18 0.00, g22 0.14) — i.e. does it keep its teeth?
 *
 * Usage: npx tsx --env-file=.env scripts/sim-significance-rule.ts [alpha]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { binomCdf, DETECTION_RATE_INITIAL_FLOOR, MIN_VERDICT_REPETITIONS } from "../src/evaluation/grounnel-live-gate";

const ALPHA = Number(process.argv[2] ?? 0.05);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();


async function main() {
  const golden: any = JSON.parse(readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json", "utf8"));
  const db = getDb();
  const raw = (await db.execute(sql`
    SELECT r.created_at::date::text AS d, r.text, c.claim_text AS t, c.verdict AS v
    FROM grounnel.grounnel_runs r JOIN grounnel.grounnel_claims c ON c.run_id = r.run_id
    WHERE r.source = 'eval' AND r.text NOT LIKE '[%'
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const rows = Array.isArray(raw) ? raw : raw.rows;

  const days = [...new Set(rows.map((r) => String(r.d)))].sort();
  let redToday = 0, redSig = 0;
  const flipped: string[] = [], keptRed: string[] = [];

  for (const day of days) {
    for (const gc of golden.cases) {
      const floor = gc.detectionFloor ?? DETECTION_RATE_INITIAL_FLOOR;
      let n = 0, ok = 0;
      for (const exp of gc.claims) {
        if (exp.kind !== "false") continue;
        for (const r of rows) {
          if (String(r.d) !== day || norm(String(r.text)) !== norm(gc.text)) continue;
          if (!norm(String(r.t)).includes(norm(exp.match))) continue;
          n++; if (r.v === "contradicted") ok++;
        }
      }
      if (n === 0) continue;
      const rate = ok / n;
      const failsToday = rate < floor;
      const pValue = binomCdf(ok, n, floor);
      // Reviewer hole #1: the significance branch must not run below the binding-N threshold,
      // otherwise a 4-draw coin still fails the suite and Change 1 is theater.
      const binding = n >= MIN_VERDICT_REPETITIONS;
      const failsSig = binding && pValue < ALPHA;
      if (failsToday) redToday++;
      if (failsSig) redSig++;
      const label = `${day} ${gc.id.slice(0, 32).padEnd(32)} ${ok}/${n} = ${rate.toFixed(2)}  p=${pValue.toFixed(3)}${binding ? "" : "  [non-binding n<5]"}`;
      if (failsToday && !failsSig) flipped.push(label);
      if (failsSig) keptRed.push(label);
    }
  }

  console.log(`floor ${DETECTION_RATE_INITIAL_FLOOR}, alpha ${ALPHA}\n`);
  console.log(`case-days RED under today's rule       : ${redToday}`);
  console.log(`case-days RED under significance rule  : ${redSig}`);
  console.log(`\n--- flipped to GREEN (sampling noise, small N) ---`);
  for (const f of flipped) console.log(`  ${f}`);
  console.log(`\n--- STILL RED (real, statistically supported) ---`);
  for (const k of keptRed) console.log(`  ${k}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
