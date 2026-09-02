/**
 * Trigger the Inngest 014 negation-polarity / asserted-predicate screen (real Gemini, no mocks).
 *
 * Usage: pnpm negation:trigger [--repeats 3]
 * Requires: INNGEST_EVENT_KEY. Job logic is in src/jobs/eval-negation-polarity.ts.
 */
import { inngest } from "../src/jobs/client.js";
import { VARIANTS, FIXTURES, dryRunCallCount } from "../src/jobs/eval-negation-polarity.js";

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

async function main() {
  const repeats = getArg("--repeats") ?? 3;
  const runnable = FIXTURES.filter((f) => f.passages !== null).length;
  const pending = FIXTURES.length - runnable;
  const eventName = "eval/negation-polarity";

  // Spec 014 T011 requires the exact call count be stated before any spend.
  console.log(`Sending ${eventName} {"repeats":${repeats}}...`);
  console.log(`  ${VARIANTS.length} variants x ${runnable} runnable fixtures x ${repeats} repeat(s) = ${dryRunCallCount(repeats)} calls`);
  console.log(`  ${pending} C4 fixtures skipped — golden cases carry no passages until the capture run happens`);
  if (args.includes("--dry-run")) {
    console.log("--dry-run: nothing sent.");
    return;
  }

  const result = await inngest.send({ name: eventName, data: { repeats } });
  console.log(`✓ negation-polarity screen triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger negation-polarity screen:", err.message || err);
  process.exit(1);
});
