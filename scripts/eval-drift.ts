/**
 * Why did a golden case change behaviour between two dates? Diffs everything the DB records for
 * one case across two days — config, retrieval, gates, escalation, verdicts. Zero API cost.
 *
 * The eval writes no scorecard, so a regression can only be investigated by re-deriving it from
 * grounnel_* rows. This is that derivation, kept as a tool instead of a one-off script.
 *
 * Usage: npx tsx --env-file=.env scripts/eval-drift.ts --case g17-wright-brothers-ordinal \
 *          --from 2026-08-28 --to 2026-09-03 [--claim "852 feet"]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i !== -1 ? args[i + 1] : undefined; };
const caseId = arg("case");
const from = arg("from");
const to = arg("to");
if (!caseId || !from || !to) {
  console.error("usage: --case <golden id> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--claim <substring>]");
  process.exit(1);
}

interface GoldenCase { id: string; text: string; claims: Array<{ match: string; kind: string }> }

/** Prints a two-column A/B diff, marking rows that differ. Silence means nothing changed. */
function diff(label: string, a: Map<string, string>, b: Map<string, string>): void {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows = keys.map((k) => ({ key: k, [from!]: a.get(k) ?? "—", [to!]: b.get(k) ?? "—", changed: a.get(k) !== b.get(k) ? "<<<" : "" }));
  console.log(`\n=== ${label} ===`);
  console.table(rows);
}

async function main() {
  const golden: { cases: GoldenCase[] } = JSON.parse(
    readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json", "utf8"),
  );
  const gc = golden.cases.find((c) => c.id === caseId);
  if (!gc) { console.error(`no golden case "${caseId}"`); process.exit(1); }
  const claimLike = `%${arg("claim") ?? ""}%`;

  const db = getDb();
  const q = async (s: ReturnType<typeof sql>) => {
    const r = (await db.execute(s)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(r) ? r : r.rows;
  };
  // Run volume differs wildly between days (a --repeats 5 pass vs a single draw), so raw counts are
  // not comparable. Everything volume-dependent is divided by the day's run count.
  const runCount = new Map<string, number>();
  for (const r of await q(sql`
    SELECT r.created_at::date::text AS d, count(*)::int AS n FROM grounnel.grounnel_runs r
    WHERE r.source='eval' AND lower(r.text)=lower(${gc.text}) AND r.created_at::date::text IN (${from}, ${to})
    GROUP BY 1`)) runCount.set(String(r.d), Number(r.n));
  const perRun = (day: string, n: number) => `${n} (${(n / (runCount.get(day) || 1)).toFixed(1)}/run)`;

  const bucket = (rows: Record<string, unknown>[], k: string, v: string) => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(String(r[k]), String(r[v]));
    return m;
  };
  const split = (rows: Record<string, unknown>[], k: string, v: string) =>
    [bucket(rows.filter((r) => String(r.d) === from), k, v), bucket(rows.filter((r) => String(r.d) === to), k, v)] as const;

  const days = sql`r.created_at::date::text IN (${from}, ${to})`;
  const scope = sql`r.source='eval' AND lower(r.text)=lower(${gc.text}) AND ${days}`;

  // 1. Config — the thing that changes only when someone ships.
  const cfg = await q(sql`
    SELECT l.created_at::date::text AS d, l.stage || '/' || l.call_type AS k,
           l.model || ' @ ' || l.prompt_version AS v
    FROM grounnel.grounnel_runs r JOIN grounnel.grounnel_llm_calls l ON l.run_id=r.run_id
    WHERE ${scope} AND l.call_type IN ('primary','eligibility_check','passage_rerank','url_discovery','url_discovery_uncapped')
    GROUP BY 1,2,3`);
  diff("model + prompt version", ...split(cfg, "k", "v"));

  // 2. Retrieval — same questions asked, same pages chosen?
  const queries = await q(sql`
    SELECT r.created_at::date::text AS d, s.query AS k, count(*)::int AS n
    FROM grounnel.grounnel_runs r JOIN grounnel.grounnel_search_calls s ON s.run_id=r.run_id
    WHERE ${scope} GROUP BY 1,2`);
  for (const r of queries) r.v = perRun(String(r.d), Number(r.n));
  diff("search queries issued", ...split(queries, "k", "v"));

  const hosts = await q(sql`
    SELECT r.created_at::date::text AS d,
           split_part(split_part(d.url,'//',2),'/',1) AS k, count(*)::int AS n
    FROM grounnel.grounnel_runs r
    JOIN grounnel.grounnel_claims c ON c.run_id=r.run_id AND c.claim_text LIKE ${claimLike}
    JOIN grounnel.grounnel_rerank_decisions d ON d.run_id=r.run_id AND d.claim_id=c.claim_id
    WHERE ${scope} AND d.selected GROUP BY 1,2`);
  for (const r of hosts) r.v = perRun(String(r.d), Number(r.n));
  diff("selected source hosts", ...split(hosts, "k", "v"));

  // 3. Evidence volume — how much actually reached VERIFY, per run.
  console.log("\n=== sources reaching VERIFY, per run ===");
  console.table(await q(sql`
    SELECT d AS day, round(avg(k)::numeric,2) AS avg_sources, min(k) AS min, max(k) AS max, count(*)::int AS runs
    FROM (SELECT r.created_at::date::text AS d, r.run_id, count(*)::int AS k
          FROM grounnel.grounnel_runs r
          JOIN grounnel.grounnel_claims c ON c.run_id=r.run_id AND c.claim_text LIKE ${claimLike}
          JOIN grounnel.grounnel_rerank_decisions d ON d.run_id=r.run_id AND d.claim_id=c.claim_id
          WHERE ${scope} AND d.selected GROUP BY 1,2) t
    GROUP BY 1 ORDER BY 1`));

  // 4. Escalation — extra VERIFY calls are the pipeline working harder for the same claim.
  const calls = await q(sql`
    SELECT r.created_at::date::text AS d, l.call_type AS k, count(*)::int AS n
    FROM grounnel.grounnel_runs r
    JOIN grounnel.grounnel_claims c ON c.run_id=r.run_id AND c.claim_text LIKE ${claimLike}
    JOIN grounnel.grounnel_llm_calls l ON l.run_id=r.run_id AND l.claim_id=c.claim_id AND l.stage='verify'
    WHERE ${scope} GROUP BY 1,2`);
  for (const r of calls) r.v = perRun(String(r.d), Number(r.n));
  diff("VERIFY call types (escalation depth)", ...split(calls, "k", "v"));

  // 5. Gates — a gate that stops appearing was disabled; one that stops overriding lost its trigger.
  const gates = await q(sql`
    SELECT r.created_at::date::text AS d, g.gate AS k,
           count(*) FILTER (WHERE g.overridden)::int AS fired, count(*)::int AS n
    FROM grounnel.grounnel_runs r
    JOIN grounnel.grounnel_gate_events g ON g.run_id=r.run_id
    WHERE ${scope} GROUP BY 1,2`);
  for (const r of gates) {
    const seen = Number(r.n), fired = Number(r.fired);
    r.v = `${fired}/${seen} = ${((fired / seen) * 100).toFixed(0)}% (${(seen / (runCount.get(String(r.d)) || 1)).toFixed(1)} seen/run)`;
  }
  diff("gate events, overridden/seen", ...split(gates, "k", "v"));

  // 6. The outcome the gate is judged on.
  console.log("\n=== verdict distribution per expected claim ===");
  const verdicts = await q(sql`
    SELECT r.created_at::date::text AS d, c.claim_text AS t, c.verdict AS v, count(*)::int AS n
    FROM grounnel.grounnel_runs r JOIN grounnel.grounnel_claims c ON c.run_id=r.run_id
    WHERE ${scope} GROUP BY 1,2,3`);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const exp of gc.claims) {
    const mine = verdicts.filter((r) => norm(String(r.t)).includes(norm(exp.match)));
    const fmt = (day: string) => mine.filter((r) => String(r.d) === day)
      .map((r) => `${r.v}=${r.n}`).join("  ") || "—";
    console.log(`  [${exp.kind}] "${exp.match}"`);
    console.log(`      ${from}: ${fmt(from!)}`);
    console.log(`      ${to}: ${fmt(to!)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
