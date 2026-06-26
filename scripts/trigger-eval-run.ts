/**
 * Trigger the Inngest dataset eval run job.
 *
 * Usage:
 *   pnpm tsx scripts/trigger-eval-run.ts                    # golden (default)
 *   pnpm tsx scripts/trigger-eval-run.ts --dataset no_bias
 *   pnpm tsx scripts/trigger-eval-run.ts --dataset all
 *   pnpm tsx scripts/trigger-eval-run.ts --dataset golden --model gemini-2.5-flash
 *
 * Requires: INNGEST_EVENT_KEY env var
 *
 * The actual eval logic is in src/jobs/eval-run.ts
 * as the "eval-dataset-run" Inngest function.
 */

import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);

function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const dataset = getArg("--dataset", "golden") as "golden" | "no_bias" | "all";
const modelName = getArg("--model", "gemini-2.5-flash");

if (!["golden", "no_bias", "all"].includes(dataset)) {
  console.error(`Invalid --dataset value: "${dataset}". Must be golden, no_bias, or all.`);
  process.exit(1);
}

async function main() {
  const eventName = "eval/dataset-run";

  console.log(`Sending ${eventName} event (dataset=${dataset}, model=${modelName})...`);

  const result = await inngest.send({
    name: eventName,
    data: { dataset, modelName },
  });

  console.log(`✓ Dataset eval run triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger dataset eval run:", err.message || err);
  process.exit(1);
});
