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

const VARIANTS = 4, FIXTURES = 4;

async function main() {
  const calls = VARIANTS * FIXTURES * repeats;
  console.log(`Addendum 11 prompt experiment — ${VARIANTS} variants x ${FIXTURES} fixtures x ${repeats} = ${calls} Gemini calls`);
  console.log(`  ~1,100 input tokens each => ~${(calls * 1100 / 1000).toFixed(0)}k input tokens total`);
  console.log("  PASS: raises `different` on f-ordinal-evidence AND holds all three t-* controls.");
  console.log("  A block that moves a control is refuted — a reason_ordinal false positive is unrecoverable.\n");
  if (args.includes("--dry-run")) { console.log("--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/attribution-prompt", data: { repeats } });
  console.log(`✓ triggered: ${r.ids.join(", ")}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
