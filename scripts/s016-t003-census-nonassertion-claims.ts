/**
 * spec 016 T003 — is eligibility already catching caption/bio non-assertions? Zero API cost.
 *
 * T003 is a GATE: if eligibility already excludes most of these, E2 is a prompt-screening problem
 * for hasResolvableReferent, not a new detector. The marker regex below is triage only — T001
 * measured it at 5/13 wrong, so every number keyed on it is reported with that caveat attached.
 *
 * Usage: npx tsx --env-file=.env scripts/s016-t003-census-nonassertion-claims.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

// Caption / credit / byline / bio surface markers. NOT a detector — see the header.
const MARKER =
  "(was photographed|photo by|photograph by|image:|credit:|can be found|loves |enjoys |in her spare time|in his spare time|in their spare time|hopes to pursue|is a student|staff writer|majoring in)";

async function main() {
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>) => {
    const r = (await db.execute(s)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(r) ? r : r.rows;
  };

  // Eligibility coverage first — an exclusion rate is meaningless if most claims never got checked.
  const coverage = await q(sql`
    SELECT count(*)::int AS claims,
           count(*) FILTER (WHERE e.claim_id IS NOT NULL)::int AS with_eligibility,
           count(*) FILTER (WHERE c.verdict = 'excluded')::int AS excluded
    FROM grounnel.grounnel_claims c
    LEFT JOIN LATERAL (
      SELECT 1 AS claim_id FROM grounnel.grounnel_llm_calls l
      WHERE l.claim_id = c.claim_id AND l.call_type = 'eligibility_check' LIMIT 1
    ) e ON true
  `);
  const cov = coverage[0]!;
  console.log("=== ELIGIBILITY COVERAGE (whole corpus) ===");
  console.log(`  claims                       : ${cov.claims}`);
  console.log(`  with an eligibility_check row: ${cov.with_eligibility}`);
  console.log(`  verdict = 'excluded'         : ${cov.excluded}`);

  // The marker-shortlisted population, split by what actually happened to it.
  const shortlist = await q(sql`
    SELECT c.claim_id::text AS claim_id, substring(c.run_id::text,1,8) AS run,
           c.claim_text, c.verdict,
           l.parsed_output->>'category' AS category,
           l.parsed_output->>'certainty' AS certainty,
           l.parsed_output->>'hasResolvableReferent' AS has_referent
    FROM grounnel.grounnel_claims c
    LEFT JOIN LATERAL (
      SELECT parsed_output FROM grounnel.grounnel_llm_calls l2
      WHERE l2.claim_id = c.claim_id AND l2.call_type = 'eligibility_check'
      ORDER BY l2.created_at DESC LIMIT 1
    ) l ON true
    WHERE c.claim_text ~* ${MARKER} OR c.source_excerpt ~* ${MARKER}
  `);

  const excluded = shortlist.filter((r) => r.verdict === "excluded");
  const shipped = shortlist.filter((r) => r.verdict !== "excluded");
  const affirmed = shipped.filter((r) => r.verdict === "supported" || r.verdict === "partially_supported");

  console.log("\n=== MARKER SHORTLIST (triage only — known ~38% false-positive rate, T001) ===");
  console.log(`  shortlisted claims        : ${shortlist.length}`);
  console.log(`  already excluded          : ${excluded.length}  (${((excluded.length / (shortlist.length || 1)) * 100).toFixed(0)}%)`);
  console.log(`  let through               : ${shipped.length}`);
  console.log(`  ... of which AFFIRMED     : ${affirmed.length}  <- the only rows E2 could still fix`);

  const bucket = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.category ?? "(no check)"}/${r.certainty ?? "-"}/referent=${r.has_referent ?? "-"}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log("\n  eligibility verdicts on the EXCLUDED rows:");
  for (const [k, n] of bucket(excluded)) console.log(`    ${String(n).padStart(3)}  ${k}`);
  console.log("\n  eligibility verdicts on the LET-THROUGH rows:");
  for (const [k, n] of bucket(shipped)) console.log(`    ${String(n).padStart(3)}  ${k}`);

  console.log("\n=== EVERY AFFIRMED LET-THROUGH ROW (hand-label these; they are E2's real population) ===");
  for (const r of affirmed) {
    console.log(`  ${r.run} ${String(r.claim_id).slice(0, 8)} [${r.verdict}] cat=${r.category ?? "-"} ref=${r.has_referent ?? "-"}`);
    console.log(`     ${String(r.claim_text).slice(0, 105)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
