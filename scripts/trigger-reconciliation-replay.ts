/**
 * TEMPORARY (D030 §3c investigation) — triggers the reconciliation-replay Inngest job.
 * Delete alongside src/jobs/reconciliation-replay.ts once the investigation concludes.
 *
 * Usage: pnpm tsx --env-file=.env scripts/trigger-reconciliation-replay.ts
 * Requires: INNGEST_EVENT_KEY env var.
 */
import { inngest } from "../src/jobs/client.js";

async function main() {
  const eventName = "investigation/reconciliation-replay";
  console.log(`Sending ${eventName} event...`);
  const result = await inngest.send({ name: eventName, data: {} });
  console.log(`✓ Reconciliation replay triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger reconciliation replay:", err.message || err);
  process.exit(1);
});
