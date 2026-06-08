/**
 * Trigger the Inngest eval job, similar to the integration test trigger.
 *
 * Usage: pnpm eval:trigger
 *
 * Requires: INNGEST_EVENT_KEY env var
 *
 * The actual eval logic is in src/jobs/eval-assessment.ts
 * as the "eval-assessment" Inngest function.
 */

import { inngest } from "../src/jobs/client";

async function main() {
  const eventName = "eval/assessment";

  console.log(`Sending ${eventName} event...`);

  const result = await inngest.send({
    name: eventName,
    data: { triggerType: "gate" },
  });

  console.log(`✓ Eval evaluation triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger eval assessment:", err.message || err);
  process.exit(1);
});