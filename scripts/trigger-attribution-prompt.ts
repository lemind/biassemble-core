/**
 * Trigger the Addendum 11 attribution-prompt experiment on the deployed app.
 *
 * Varies ONLY the spliced prompt block: the passages are PINNED, so retrieval variance cannot
 * masquerade as a prompt effect. Blocks and fixtures travel in the event payload.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/trigger-attribution-prompt.ts [--repeats 3] [--dry-run]
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i !== -1 ? args[i + 1] : undefined; };
const repeats = Number(arg("repeats") ?? 3);



const variants = arg("variants")?.split(",").map((s) => s.trim()).filter(Boolean);
const fixtures = arg("fixtures")?.split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  const nV = variants?.length ?? 4, nF = fixtures?.length ?? 8;
  const calls = nV * nF * repeats;
  console.log(`Addendum 11 prompt experiment — ${nV} variants x ${nF} fixtures x ${repeats} = ${calls} Gemini calls`);
  console.log(`  ~1,100 input tokens each => ~${(calls * 1100 / 1000).toFixed(0)}k input tokens total`);
  console.log("  PASS: the target moves to `different` AND every t-* control holds its answer.");
  console.log("  A block that moves a control is refuted — a reason_ordinal false positive is unrecoverable.\n");
  if (args.includes("--dry-run")) { console.log("--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/attribution-prompt", data: { repeats, variantIds: variants, fixtureIds: fixtures } });
  console.log(`✓ triggered: ${r.ids.join(", ")}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
