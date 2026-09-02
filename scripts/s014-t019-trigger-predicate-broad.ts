/**
 * spec 014 T019 — does `predicate-first` hold up beyond the 4 rows of T018?
 * Runs the full built-in fixture set (19 rows: negation, reporting, block-b, controls) under the
 * production schema and the predicate-first schema, same prompt, same fixtures.
 *
 * Baseline to beat, from T011 on `verdict-first`:
 *   negation 12/24  reporting 0/12  block-b 6/6  control 9/15
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t019-trigger-predicate-broad.ts [--repeats 3] [--dry-run]
 */
import { inngest } from "../src/jobs/client.js";
import { FIXTURES } from "../src/jobs/eval-negation-polarity.js";

const args = process.argv.slice(2);
const repeats = (() => { const i = args.indexOf("--repeats"); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : 3; })();
const runnable = FIXTURES.filter((f) => f.passages !== null);
const SCHEMAS = ["verdict-first", "predicate-first"] as const;

async function main() {
  console.log(`014 T019 — ${SCHEMAS.length} schemas x ${runnable.length} fixtures x ${repeats} = ${SCHEMAS.length * runnable.length * repeats} calls`);
  if (args.includes("--dry-run")) { console.log("--dry-run: nothing sent."); return; }
  for (const schemaVariant of SCHEMAS) {
    const variants = [{ id: `broad-${schemaVariant}-${Date.now().toString().slice(-4)}`, strategy: `schema=${schemaVariant}`, blocks: [] as string[] }];
    const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, variants, schemaVariant } });
    console.log(`✓ ${schemaVariant.padEnd(16)} ${r.ids.join(", ")}  variant=${variants[0]!.id}`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
