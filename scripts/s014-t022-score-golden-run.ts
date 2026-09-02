/**
 * Score a golden-set run from persisted claims. Zero API cost.
 *
 * The eval job reports only to the logger, so a run's outcome is otherwise unreadable after the
 * fact. This reproduces evaluateGrounnelRun's rules against grounnel_claims: same ACCEPTABLE map,
 * same substring matching, same false-accusation definition (a non-`false` claim marked
 * `contradicted`).
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t022-score-golden-run.ts [--minutes 30]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

const args = process.argv.slice(2);
const minutes = (() => { const i = args.indexOf("--minutes"); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : 30; })();

// Mirrors ACCEPTABLE in src/evaluation/grounnel-live-gate.ts — kept in sync by hand, deliberately
// not imported, so a change there shows up here as a disagreement rather than silently propagating.
const ACCEPTABLE: Record<string, string[]> = {
  true: ["supported", "partially_supported"],
  false: ["contradicted"],
  silence: ["unsupported", "unverifiable"],
  excluded: ["excluded"],
  not_excluded: ["supported", "partially_supported", "unsupported", "contradicted"],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

interface GoldenCase { id: string; text: string; minCorrectRate?: number; claims: Array<{ match: string; kind: string }> }

async function main() {
  const golden: { cases: GoldenCase[] } = JSON.parse(
    readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json", "utf8"),
  );
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>) => {
    const r = (await db.execute(s)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(r) ? r : r.rows;
  };

  const runs = await q(sql`
    SELECT r.run_id::text AS run_id, r.text, r.status,
           coalesce(json_agg(json_build_object('t', c.claim_text, 'v', c.verdict))
                    FILTER (WHERE c.claim_id IS NOT NULL), '[]'::json) AS claims
    FROM grounnel.grounnel_runs r
    LEFT JOIN grounnel.grounnel_claims c ON c.run_id = r.run_id
    WHERE r.source = 'eval' AND r.created_at > now() - (${minutes} || ' minutes')::interval
      AND r.text NOT LIKE '[%'
    GROUP BY r.run_id, r.text, r.status
  `);

  let totalMatched = 0, totalCorrect = 0, falseAccusations = 0, casesSeen = 0, casesFailed = 0;
  const failures: string[] = [];
  const fa: string[] = [];

  for (const gc of golden.cases) {
    const mine = runs.filter((r) => norm(String(r.text)) === norm(gc.text));
    if (!mine.length) continue;
    casesSeen++;
    let matched = 0, correct = 0, caseFA = 0;
    for (const run of mine) {
      const claims = run.claims as Array<{ t: string; v: string | null }>;
      for (const exp of gc.claims) {
        const hit = claims.find((c) => norm(c.t).includes(norm(exp.match)));
        if (!hit) continue;
        matched++;
        const v = hit.v ?? "null";
        if ((ACCEPTABLE[exp.kind] ?? []).includes(v)) correct++;
        if (exp.kind !== "false" && exp.kind !== "not_excluded" && v === "contradicted") {
          caseFA++;
          fa.push(`${gc.id}: "${exp.match}" (${exp.kind}) -> contradicted`);
        }
      }
    }
    totalMatched += matched; totalCorrect += correct; falseAccusations += caseFA;
    const rate = matched ? correct / matched : null;
    const floor = gc.minCorrectRate ?? 1.0;
    const failed = caseFA > 0 || (rate !== null && rate < floor);
    if (failed) { casesFailed++; failures.push(`${gc.id}  rate=${rate === null ? "n/a" : rate.toFixed(2)} (floor ${floor})  FA=${caseFA}`); }
  }

  console.log("=== GOLDEN RUN SCORECARD ===");
  console.log(`  cases observed        : ${casesSeen}/${golden.cases.length}`);
  console.log(`  claims matched        : ${totalMatched}`);
  console.log(`  correct               : ${totalCorrect}  (${totalMatched ? ((totalCorrect / totalMatched) * 100).toFixed(1) : "n/a"}%)`);
  console.log(`  FALSE ACCUSATIONS     : ${falseAccusations}   <- the number that decides`);
  console.log(`  cases failing         : ${casesFailed}`);
  if (failures.length) { console.log("\n  failing cases:"); for (const f of failures) console.log(`    ${f}`); }
  if (fa.length) { console.log("\n  false accusations:"); for (const f of fa) console.log(`    ${f}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
