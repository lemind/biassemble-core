/**
 * Trigger the Inngest no-bias-story eval job.
 *
 * Usage: pnpm eval:trigger:no-bias
 *
 * Requires: INNGEST_EVENT_KEY env var
 *
 * The actual eval logic is in src/jobs/eval-assessment.ts
 * as the "eval-no-bias-story" Inngest function.
 */

import { inngest } from "../src/jobs/client";

async function main() {
  const eventName = "eval/no-bias-story";

  console.log(`Sending ${eventName} event...`);

  const result = await inngest.send({
    name: eventName,
    data: {},
  });

  console.log(`✓ No-bias story eval triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger no-bias story eval:", err.message || err);
  process.exit(1);
});
