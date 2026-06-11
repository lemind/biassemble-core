/**
 * Trigger the Inngest golden-story eval job.
 *
 * Usage: pnpm eval:trigger:golden
 *
 * Requires: INNGEST_EVENT_KEY env var
 *
 * The actual eval logic is in src/jobs/eval-assessment.ts
 * as the "eval-golden-story" Inngest function.
 */

import { inngest } from "../src/jobs/client";

async function main() {
  const eventName = "eval/golden-story";

  console.log(`Sending ${eventName} event...`);

  const result = await inngest.send({
    name: eventName,
    data: {},
  });

  console.log(`✓ Golden story eval triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger golden story eval:", err.message || err);
  process.exit(1);
});
