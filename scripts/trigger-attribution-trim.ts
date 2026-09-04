/**
 * Trigger the Addendum 10 attribution-trim experiment on the deployed app.
 *
 * Retrieves once, then runs every trim variant against the SAME passages, so the trim is the only
 * variable. Variants travel in the event payload — trying another needs no redeploy.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/trigger-attribution-trim.ts [--repeats 3] [--trims a,b] [--dry-run]
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i !== -1 ? args[i + 1] : undefined; };
const repeats = Number(arg("repeats") ?? 3);
const trims = arg("trims")?.split(",").map((s) => s.trim()).filter(Boolean);

const ALL = ["full", "s20-claim", "s20-anyselector", "s40-claim", "s60-claim"];
const selected = trims?.length ? trims : ALL;

async function main() {
  console.log(`Addendum 10 trim experiment — ${selected.length} trims x ${repeats} repeats = ${selected.length * repeats} Gemini calls`);
  console.log(`  trims: ${selected.join(", ")}`);
  console.log("  baseline to beat: `full` = 63,915 avg input tokens, 24 `different` + 9 `conflict` historically");
  console.log("  PASS: recovers `different` at a rate near `full` AND stays under 10,000 input tokens.\n");
  if (args.includes("--dry-run")) { console.log("--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/attribution-trim", data: { repeats, trims: selected } });
  console.log(`✓ triggered: ${r.ids.join(", ")}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
