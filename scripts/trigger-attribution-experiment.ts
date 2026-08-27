/**
 * Fires the instance-attribution prompt-variant experiment (spec 013 T20/T21).
 *
 * Usage: pnpm tsx --env-file=.env scripts/trigger-attribution-experiment.ts [--repeats 3]
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const idx = args.indexOf("--repeats");
const repeats = idx !== -1 && args[idx + 1] ? Number(args[idx + 1]) : 3;

async function main() {
  // 4 variants x N repeats, one batched call each — the fixture set rides in a single request.
  console.log(`Sending eval/attribution-experiment {"repeats":${repeats}} — ~${4 * repeats} Gemini calls`);
  const result = await inngest.send({ name: "eval/attribution-experiment", data: { repeats } });
  console.log(`✓ triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger:", err.message || err);
  process.exit(1);
});
