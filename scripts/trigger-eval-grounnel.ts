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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inngest } from "../src/jobs/client.js";

/** Measured from real runs (D030 §3k): ~226 Gemini calls per full 19-case pass. */
const CALLS_PER_CASE_RUN = 12;

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

/** Comma-separated case ids, e.g. --cases g17-wright-brothers-ordinal,g20-apple-earnings-year-over-year */
function getListArg(flag: string): string[] | undefined {
  const idx = args.indexOf(flag);
  const raw = idx !== -1 ? args[idx + 1] : undefined;
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main() {
  const minCorrectRate = getArg("--min-correct-rate");
  const repeats = getArg("--repeats");
  const caseIds = getListArg("--cases");
  const eventName = "eval/grounnel-run";

  const data: Record<string, unknown> = {};
  if (minCorrectRate !== undefined) data.minCorrectRate = minCorrectRate;
  if (repeats !== undefined) data.repeats = repeats;
  if (caseIds !== undefined) data.caseIds = caseIds;

  // Cost is the reason this is opt-in per invocation: one repetition over the full golden set is
  // ~226 Gemini calls, so N=5 over the whole set is ~1130 — roughly a full day's quota (D030 §3k).
  // Case count is read from the golden set itself, never hardcoded, so the estimate can't go stale
  // as cases are added — this line exists to get exactly one number right.
  const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "..", "evaluations", "golden", "grounnel", "live-eval-golden-set.json");
  const golden: { cases: Array<{ id: string }> } = JSON.parse(readFileSync(goldenPath, "utf-8"));
  const unknown = caseIds?.filter((id) => !golden.cases.some((c) => c.id === id)) ?? [];
  if (unknown.length > 0) {
    console.error(`Unknown case id(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  const cases = caseIds?.length ?? golden.cases.length;
  console.log(`Sending ${eventName}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""}...`);
  if (repeats === undefined) {
    // Screen-then-escalate: every case once, then 5 fresh runs for each QUALITY failure (max 8).
    const screen = cases * CALLS_PER_CASE_RUN;
    console.log(`  MODE screen+escalate — ${cases} case(s) × 1, then 5 more per failing case (max 8)`);
    console.log(`  ≈ ${screen} calls if clean, ${screen + 3 * 5 * CALLS_PER_CASE_RUN} with 3 failures, ${screen + 8 * 5 * CALLS_PER_CASE_RUN} at the cap`);
    console.log(`  (pass --repeats N to force a flat N-repetition pass instead)`);
  } else {
    const n = Math.max(1, Math.min(20, Math.trunc(repeats)));
    console.log(`  MODE flat — ${cases} case(s) × ${n} repetition(s) ≈ ${cases * n * CALLS_PER_CASE_RUN} Gemini calls`);
  }

  // --dry-run prints the cost and sends nothing: this script spends real quota the moment it runs,
  // so estimating the cost must not require firing the eval.
  if (args.includes("--dry-run")) { console.log("--dry-run: nothing sent."); return; }

  const result = await inngest.send({ name: eventName, data });

  console.log(`✓ Grounnel live eval triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger Grounnel live eval:", err.message || err);
  process.exit(1);
});
