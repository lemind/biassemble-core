/**
 * Trigger the Inngest T27b eligibility prompt-variant screen (real Gemini, no mocks).
 *
 * Usage: pnpm t27b:trigger [--repeats 3]
 * Requires: INNGEST_EVENT_KEY. Job logic is in src/jobs/eval-t27b-prompt-variants.ts.
 */
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

async function main() {
  const repeats = getArg("--repeats") ?? 3;
  const eventName = "eval/t27b-prompt-variants";

  console.log(`Sending ${eventName} {"repeats":${repeats}}...`);
  console.log(`  5 variants × 24 fixtures × ${repeats} repeat(s) ≈ ${5 * 24 * repeats} calls`);

  const result = await inngest.send({ name: eventName, data: { repeats } });
  console.log(`✓ T27b screen triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger T27b screen:", err.message || err);
  process.exit(1);
});
