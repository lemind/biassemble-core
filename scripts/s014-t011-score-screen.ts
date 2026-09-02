/**
 * spec 014 T011 — score the deployed negation-polarity screen from persisted telemetry.
 * Zero API cost. Reads grounnel_llm_calls where prompt_version LIKE 'neg-%'.
 *
 * Targets come from the fixture module, never from this file — they are pre-registered in
 * specs/014 plan.md § Fixture semantics and must not be edited to match a result.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t011-score-screen.ts
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { FIXTURES, VARIANTS } from "../src/jobs/eval-negation-polarity";

const RUNNABLE = FIXTURES.filter((f) => f.passages !== null);

async function main() {
  const db = getDb();
  const raw = (await db.execute(sql`
    SELECT prompt_version,
           parsed_output->'results'->0->>'id'       AS fixture,
           parsed_output->'results'->0->>'verdict'  AS verdict,
           parsed_output->'results'->0->>'reason'   AS reason
    FROM grounnel.grounnel_llm_calls
    WHERE prompt_version LIKE 'neg-%' AND status = 'success'
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const rows = (Array.isArray(raw) ? raw : raw.rows).map((r) => ({
    variant: String(r.prompt_version).replace(/^neg-/, ""),
    fixture: String(r.fixture),
    verdict: String(r.verdict),
    reason: (r.reason as string | null) ?? "",
  }));
  console.log(`scored cells: ${rows.length}\n`);

  const summary: Record<string, unknown>[] = [];
  for (const variant of VARIANTS) {
    const mine = rows.filter((r) => r.variant === variant.id);
    const per = RUNNABLE.map((f) => {
      const got = mine.filter((r) => r.fixture === f.id).map((r) => r.verdict);
      return { id: f.id, role: f.role, expect: f.expect, n: got.length, hits: got.filter((v) => v === f.expect).length, got };
    });
    const role = (r: string) => per.filter((f) => f.role === r);
    const missed = (rs: typeof per) => rs.filter((f) => f.hits < f.n || f.n === 0).map((f) => f.id);

    const n1 = per.find((f) => f.id === "n1-pentagon-investigating")!;
    const c5 = per.find((f) => f.id === "c5-narrower-same-predicate")!;
    const c5Split = n1.hits !== c5.hits;

    const verdict = missed(role("control")).length
      ? `FAIL — controls broken: ${missed(role("control")).join(", ")}`
      : missed(role("reporting")).length
        ? `FAIL — reporting broken: ${missed(role("reporting")).join(", ")}`
        : c5Split
          ? "FAIL — C5/n1 disagree (Block B ate Block A)"
          : missed(role("negation")).length
            ? `INCONCLUSIVE — negation missed: ${missed(role("negation")).join(", ")}`
            : missed(role("block-b")).length
              ? `WEAK — block-b missed: ${missed(role("block-b")).join(", ")}`
              : "PASS";

    const h = (r: string) => {
      const rs = role(r);
      return `${rs.reduce((a, f) => a + f.hits, 0)}/${rs.reduce((a, f) => a + f.n, 0)}`;
    };
    console.log(`${variant.id}  —  ${verdict}`);
    console.log(`   negation ${h("negation")}   reporting ${h("reporting")}   block-b ${h("block-b")}   control ${h("control")}`);
    for (const f of per.filter((x) => x.hits < x.n)) {
      console.log(`     MISS ${f.id.padEnd(32)} want=${f.expect.padEnd(20)} got=${f.got.join(",")}`);
    }
    console.log("");
    summary.push({ variant: variant.id, verdict, negation: h("negation"), reporting: h("reporting"), blockB: h("block-b"), control: h("control"), per });
  }
  writeFileSync("specs/014-verify-negated-claim-polarity/t011-screen-summary.json", JSON.stringify(summary, null, 2) + "\n");
  console.log("wrote specs/014-verify-negated-claim-polarity/t011-screen-summary.json");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
