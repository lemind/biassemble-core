/**
 * spec 014 T014 — run the POOLED-fixture screen. Fixtures travel in the event payload, so this
 * needs no redeploy once the data-driven job is live.
 *
 * Pass condition: the CONTROL variant reproduces the live verdict (`contradicted`). If it does not,
 * the harness still is not testing the live defect and no variant result is interpretable.
 *
 * Usage: pnpm tsx --env-file=.env scripts/s014-t014-trigger-pooled.ts [--repeats 3] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const repeats = (() => { const i = args.indexOf("--repeats"); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : 3; })();

const pooled = JSON.parse(readFileSync("specs/014-verify-negated-claim-polarity/pooled-fixtures.json", "utf8")) as Array<{
  key: string; claim: string; live_verdict: string; passage_sentences: Record<string, unknown>;
}>;

// expect = the LIVE verdict. We are testing whether the harness reproduces production, not whether
// production is right — so the target here is deliberately the observed defect, not the ideal.
const fixtures = pooled.map((p) => ({
  id: p.key, role: "negation" as const, claim: p.claim,
  passages: p.passage_sentences, expect: p.live_verdict, relationship: "CONFLICT" as const,
}));

const variants = [
  { id: `pooled-v0-control-${Date.now().toString().slice(-4)}`, strategy: "live 4.6.0, no block", blocks: [] as string[] },
];

async function main() {
  console.log(`pooled screen: ${variants.length} variant x ${fixtures.length} fixtures x ${repeats} = ${variants.length * fixtures.length * repeats} calls`);
  for (const f of fixtures) {
    console.log(`  ${f.id}  expect=${f.expect} (the live verdict)  sources=${Object.keys(f.passages).join(",")}`);
  }
  if (args.includes("--dry-run")) { console.log("--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, fixtures, variants } });
  console.log(`✓ triggered: ${r.ids.join(", ")}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
