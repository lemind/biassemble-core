/**
 * Trigger the Inngest T22 VERIFY verdict/reason field-order A/B job (real Gemini + Tavily, no mocks).
 *
 * Usage:
 *   pnpm t22:trigger
 *   pnpm t22:trigger --repeats 2
 *   pnpm t22:trigger --cases g17-wright-brothers-ordinal,g20-apple-earnings-year-over-year
 *
 * Requires: INNGEST_EVENT_KEY env var. Job logic is in src/jobs/eval-t22-verify-order.ts.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);

function getArg(flag: string): number | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseFloat(args[idx + 1]!) : undefined;
}

function getListArg(flag: string): string[] | undefined {
  const idx = args.indexOf(flag);
  const raw = idx !== -1 ? args[idx + 1] : undefined;
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main() {
  const repeats = getArg("--repeats") ?? 2;
  const caseIds = getListArg("--cases");
  const eventName = "eval/t22-verify-order";

  const data: Record<string, unknown> = { repeats };
  if (caseIds !== undefined) data.caseIds = caseIds;

  const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "..", "evaluations", "golden", "grounnel", "live-eval-golden-set.json");
  const golden: { cases: Array<{ id: string; claims: unknown[] }> } = JSON.parse(readFileSync(goldenPath, "utf-8"));
  const unknown = caseIds?.filter((id) => !golden.cases.some((c) => c.id === id)) ?? [];
  if (unknown.length > 0) {
    console.error(`Unknown case id(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  const cases = caseIds?.length ?? golden.cases.length;
  const avgClaimsPerCase = golden.cases.reduce((s, c) => s + c.claims.length, 0) / golden.cases.length;
  // Fixtures: ~1 EXTRACT + ~1 eligibility/claim + ~1 search+rerank/claim, one-time (~7/case).
  const fixtureCalls = Math.round(cases * (2 + avgClaimsPerCase * 5));
  // A/B: cases × 2 schema arms × repeats × 1 batched VERIFY call.
  const verifyCalls = cases * 2 * repeats;
  // Consistency: same shape as VERIFY calls, one per arm-run.
  const consistencyCalls = verifyCalls;
  const total = fixtureCalls + verifyCalls + consistencyCalls;

  console.log(`Sending ${eventName} ${JSON.stringify(data)}...`);
  console.log(`  ${cases} case(s) × 2 schema arms × ${repeats} repeat(s)`);
  console.log(`  Estimated calls: ~${fixtureCalls} fixture + ${verifyCalls} VERIFY A/B + ${consistencyCalls} consistency-check ≈ ${total} total`);

  const result = await inngest.send({ name: eventName, data });

  console.log(`✓ T22 A/B triggered: ${result.ids.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to trigger T22 A/B:", err.message || err);
  process.exit(1);
});
