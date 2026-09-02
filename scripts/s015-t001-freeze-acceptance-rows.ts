/**
 * spec 015 T001 — freeze G1's must-fire / must-not-fire acceptance rows. Zero API cost.
 * Writes specs/015-evidence-provenance-floors/acceptance-rows.json.
 *
 * Unit is a CLAIM with its resolved `evidence` span plus its cited domains. grounnel_search_pages
 * cannot be the unit: it stores DIY fetches only, and set A's circular host has zero rows there
 * (43 of 213 cited URLs in fddb57fa have a stored page at all). Page excerpts are attached where
 * they exist so the page-level half of the predicate can still be scored on set B.
 *
 * Usage: npx tsx --env-file=.env scripts/s015-t001-freeze-acceptance-rows.ts
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

// Set A — the input essay retrieved from its own journal host (no page text persisted, span only).
const CIRCULAR_A = { run: "fddb57fa", hosts: ["jps.library.utoronto.ca"] };
// Set B — the same essay-mill text syndicated across mills, so the corroborating host differs.
const CIRCULAR_B = { run: "9ec37df1", hosts: ["ivypanda.com", "studycorgi.com", "gradesfixer.com"] };
// Must-not-fire — news runs. Their inputs are news articles, so other outlets legitimately repeat
// the same quoted sentences: this is the set that catches a predicate keyed on a shared quotation.
const CONTROL_RUNS = ["9a784003", "be72361c", "5b8005cc"];

const ALL_RUNS = [CIRCULAR_A.run, CIRCULAR_B.run, ...CONTROL_RUNS];

interface ClaimRow {
  run_prefix: string;
  claim_id: string;
  claim_text: string;
  verdict: string;
  evidence: string;
  domains: string[];
  page_excerpts: { url: string; excerpt: string }[];
}

async function main() {
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>) => {
    const r = (await db.execute(s)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(r) ? r : r.rows;
  };
  const runList = sql.join(ALL_RUNS.map((r) => sql`${r}`), sql`, `);

  const runRows = await q(sql`
    SELECT substring(run_id::text, 1, 8) AS prefix, text
    FROM grounnel.grounnel_runs WHERE substring(run_id::text, 1, 8) IN (${runList})
  `);
  const inputText = new Map(runRows.map((r) => [String(r.prefix), String(r.text)]));

  // Affirmative claims only — G1 exists to stop a false `supported`, so a non-affirmative row is
  // neither a must-fire nor a meaningful control.
  const claims = (await q(sql`
    SELECT substring(c.run_id::text, 1, 8) AS run_prefix,
           c.claim_id::text AS claim_id, c.claim_text, c.verdict, c.evidence,
           (SELECT coalesce(array_agg(DISTINCT s->>'domain'), '{}')
              FROM jsonb_array_elements(c.sources) s) AS domains,
           (SELECT coalesce(json_agg(json_build_object('url', p.url, 'excerpt', p.excerpt)), '[]'::json)
              FROM grounnel.grounnel_search_pages p
             WHERE p.claim_id = c.claim_id) AS page_excerpts
    FROM grounnel.grounnel_claims c
    WHERE substring(c.run_id::text, 1, 8) IN (${runList})
      AND c.verdict IN ('supported', 'partially_supported')
      AND c.evidence IS NOT NULL AND btrim(c.evidence) <> ''
  `)) as unknown as ClaimRow[];

  const cites = (c: ClaimRow, hosts: string[]) => (c.domains ?? []).some((d) => hosts.includes(d));

  const setA = claims.filter((c) => c.run_prefix === CIRCULAR_A.run && cites(c, CIRCULAR_A.hosts));
  const setB = claims.filter((c) => c.run_prefix === CIRCULAR_B.run && cites(c, CIRCULAR_B.hosts));
  const controlNews = claims.filter((c) => CONTROL_RUNS.includes(c.run_prefix));
  // Strictest control: same run, same genre, but a genuine third-party source.
  const controlSameRun = claims.filter(
    (c) =>
      (c.run_prefix === CIRCULAR_A.run && !cites(c, CIRCULAR_A.hosts)) ||
      (c.run_prefix === CIRCULAR_B.run && !cites(c, CIRCULAR_B.hosts)),
  );

  const frozen = {
    frozen_at: new Date().toISOString(),
    spec: "015-evidence-provenance-floors",
    task: "T001",
    note:
      "Unit is a claim + its resolved evidence span. grounnel_search_pages is DIY-only and holds ZERO rows for set A's host, so page-level scoring is available for set B and the controls but not for set A.",
    inputs: [...inputText.entries()].map(([run_prefix, text]) => ({ run_prefix, text_len: text.length, text })),
    must_fire_A_same_host: { run: CIRCULAR_A.run, hosts: CIRCULAR_A.hosts, claims: setA },
    must_fire_B_syndicated: { run: CIRCULAR_B.run, hosts: CIRCULAR_B.hosts, claims: setB },
    must_not_fire_news: { runs: CONTROL_RUNS, claims: controlNews },
    must_not_fire_same_run_third_party: { runs: [CIRCULAR_A.run, CIRCULAR_B.run], claims: controlSameRun },
  };

  writeFileSync(
    "specs/015-evidence-provenance-floors/acceptance-rows.json",
    JSON.stringify(frozen, null, 2) + "\n",
  );

  const pageCount = (rows: ClaimRow[]) => rows.filter((c) => (c.page_excerpts ?? []).length > 0).length;
  console.log("wrote specs/015-evidence-provenance-floors/acceptance-rows.json\n");
  const line = (label: string, rows: ClaimRow[]) =>
    console.log(`  ${label.padEnd(38)} claims=${String(rows.length).padStart(3)}  with page text=${pageCount(rows)}`);
  line("MUST FIRE A (fddb57fa, own host)", setA);
  line("MUST FIRE B (9ec37df1, syndicated)", setB);
  line("must NOT fire (news runs)", controlNews);
  line("must NOT fire (same run, third party)", controlSameRun);

  console.log("\n=== MUST FIRE A — sample evidence spans ===");
  for (const c of setA.slice(0, 6)) console.log(`  ${c.claim_id.slice(0, 8)} ${c.evidence.slice(0, 110)}`);
  console.log("\n=== MUST FIRE B — sample evidence spans ===");
  for (const c of setB.slice(0, 6)) console.log(`  ${c.claim_id.slice(0, 8)} ${c.evidence.slice(0, 110)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
