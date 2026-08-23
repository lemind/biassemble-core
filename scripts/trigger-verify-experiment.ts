/**
 * Trigger the one-off VERIFY evidence-formatting experiment (g17) on the deployed app.
 * Throwaway — see src/jobs/verify-experiment.ts for what it actually runs.
 *
 * Usage: pnpm tsx --env-file=.env scripts/trigger-verify-experiment.ts
 * Requires: INNGEST_EVENT_KEY env var.
 */
import { inngest } from "../src/jobs/client.js";

async function main() {
  const eventName = "eval/verify-experiment";
  console.log(`Sending ${eventName} event...`);
  const result = await inngest.send({ name: eventName, data: {} });
  console.log(`✓ Verify experiment triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger verify experiment:", err.message || err);
  process.exit(1);
});
