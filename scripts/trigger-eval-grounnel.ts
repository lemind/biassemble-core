/**
 * Trigger the Inngest Grounnel live-eval job (real Gemini + Tavily, no mocks) on the deployed app.
 *
 * Usage:
 *   pnpm eval:grounnel:trigger
 *   pnpm eval:grounnel:trigger --min-correct-rate 0.9
 *
 * Requires: INNGEST_EVENT_KEY env var. The actual eval logic is in
 * src/jobs/eval-grounnel-run.ts (the "eval-grounnel-run" Inngest function).
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

async function main() {
  const minCorrectRate = getArg("--min-correct-rate");
  const eventName = "eval/grounnel-run";

  console.log(`Sending ${eventName} event${minCorrectRate !== undefined ? ` (minCorrectRate=${minCorrectRate})` : ""}...`);

  const result = await inngest.send({
    name: eventName,
    data: minCorrectRate !== undefined ? { minCorrectRate } : {},
  });

  console.log(`✓ Grounnel live eval triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger Grounnel live eval:", err.message || err);
  process.exit(1);
});
