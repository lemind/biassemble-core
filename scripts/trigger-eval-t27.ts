/**
 * Trigger the Inngest T27 resolvable-referent screen (real Gemini, no mocks).
 *
 * Usage:
 *   pnpm t27:trigger
 *   pnpm t27:trigger --repeats 10
 *
 * Requires: INNGEST_EVENT_KEY env var. Job logic is in src/jobs/eval-t27-referent-screen.ts.
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

async function main() {
  const repeats = getArg("--repeats") ?? 10;
  const eventName = "eval/t27-referent-screen";
  const data = { repeats };

  // 10 fixtures (5 contentless + 5 near-miss), one eligibility_check call each per repeat.
  console.log(`Sending ${eventName} ${JSON.stringify(data)}...`);
  console.log(`  10 fixtures × ${repeats} repeat(s) ≈ ${10 * repeats} calls`);

  const result = await inngest.send({ name: eventName, data });

  console.log(`✓ T27 screen triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger T27 screen:", err.message || err);
  process.exit(1);
});
