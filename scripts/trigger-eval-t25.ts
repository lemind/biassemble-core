/**
 * Trigger the Inngest T25 contentless-claim eligibility experiment (real Gemini, no mocks).
 *
 * Usage:
 *   pnpm t25:trigger
 *   pnpm t25:trigger --repeats 5
 *
 * Requires: INNGEST_EVENT_KEY env var. Job logic is in src/jobs/eval-t25-contentless-eligibility.ts.
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

async function main() {
  const repeats = getArg("--repeats") ?? 5;
  const eventName = "eval/t25-contentless-eligibility";
  const data = { repeats };

  // 5 fixtures x N repeats, one eligibility_check call each.
  console.log(`Sending ${eventName} ${JSON.stringify(data)}...`);
  console.log(`  5 fixtures × ${repeats} repeat(s) ≈ ${5 * repeats} calls`);

  const result = await inngest.send({ name: eventName, data });

  console.log(`✓ T25 experiment triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger T25 experiment:", err.message || err);
  process.exit(1);
});
