/**
 * Evaluation script for reflection orchestrators.
 *
 * ── Modes ──────────────────────────────────────────────────────────────
 *   pnpm eval                     MockProvider — fast CI sanity check
 *   pnpm eval --provider real     Real Gemini — actual quality gate
 *
 * ── Eval Policy ────────────────────────────────────────────────────────
 *   Mock eval:  every commit, every PR (automated)
 *   Real eval:  before prompt file changes merge
 *               before provider changes
 *               weekly scheduled Inngest job (T305)
 *               never on every commit
 *
 * ── API call count (real mode) ─────────────────────────────────────────
 *   5 golden × 2 calls (questions + assessment) = 10
 *   13 no_bias × 1 call (assessment only, skip questions) = 13
 *   Total: 23 calls
 *
 * Usage: pnpm eval [--provider real] [--min-evidence-grounded 0.85] ...
 */

import { MockProvider } from "../tests/mocks/mock-provider.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { runEval } from "../src/evaluation/run-eval.js";
import type { Provider } from "../src/providers/types.js";

function parseArgs(): { provider: string; thresholds: Record<string, number> } {
  const args = process.argv.slice(2);
  let provider = "mock";
  const thresholds: Record<string, number> = {
    minEvidenceGrounded: 0.9,
    maxFalsePositive: 0.1,
    minSchemaParse: 0.95,
    maxRepairRate: 0.05,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--provider" && next) { provider = next; i++; }
    else if (arg === "--min-evidence-grounded" && next) { thresholds.minEvidenceGrounded = parseFloat(next); i++; }
    else if (arg === "--max-false-positive" && next) { thresholds.maxFalsePositive = parseFloat(next); i++; }
    else if (arg === "--min-schema-parse" && next) { thresholds.minSchemaParse = parseFloat(next); i++; }
    else if (arg === "--max-repair-rate" && next) { thresholds.maxRepairRate = parseFloat(next); i++; }
  }

  return { provider, thresholds };
}

function createProvider(mode: string): Provider {
  if (mode === "real") return new GeminiProvider();
  const mock = new MockProvider();
  mock.setDefault({
    biases: [
      {
        name: "confirmation bias",
        explanation: "Mock explanation for eval.",
        storyConnection: "Mock story connection.",
        alternativePerspective: "Mock alternative perspective.",
      },
    ],
    reflectionPrompt: "Mock reflection prompt.",
  });
  return mock;
}

function printResults(
  results: import("../src/evaluation/run-eval.js").EvalRunResult,
  thresholds: Record<string, number>,
  isMock: boolean,
): void {
  const { goldenResults, noBiasResults, sysMetrics } = results;

  const printDataset = (label: string, stories: typeof goldenResults) => {
    const total = stories.length;
    const groundedRates = stories
      .filter((r) => r.errors.length === 0)
      .map((r) => r.evaluationMetrics?.evidenceGroundedRate)
      .filter((v): v is number => v !== null && v !== undefined);
    const groundedRate = groundedRates.length > 0
      ? groundedRates.reduce((a, b) => a + b, 0) / groundedRates.length
      : null;

    const noBiasList = stories.filter((r) => r.dataset === "no_bias");
    const fpCount = noBiasList.filter((r) => r.evaluationMetrics?.isFalsePositive === true).length;
    const fpRate = noBiasList.length > 0 ? fpCount / noBiasList.length : null;

    console.log(`\n📊 EVALUATION — ${label} (${total} stories)`);
    console.log("─────────────────────────────────────");

    if (groundedRate !== null) {
      const pass = groundedRate >= thresholds.minEvidenceGrounded;
      console.log(`  evidence_grounded_rate:  ${groundedRate.toFixed(3)} ${pass ? "✅" : "❌"}  min ${thresholds.minEvidenceGrounded}`);
    } else {
      console.log(`  evidence_grounded_rate:  N/A`);
    }

    if (fpRate !== null) {
      const pass = fpRate <= thresholds.maxFalsePositive;
      console.log(`  false_positive_rate:     ${fpRate.toFixed(3)} ${pass ? "✅" : "❌"}  max ${thresholds.maxFalsePositive}`);
    }

    const schemaNote = isMock
      ? `1.000 ✅  min ${thresholds.minSchemaParse}  (mock — n/a)`
      : `${sysMetrics.schemaParseRate?.toFixed(3) ?? "N/A"} ${(sysMetrics.schemaParseRate ?? 0) >= thresholds.minSchemaParse ? "✅" : "❌"}  min ${thresholds.minSchemaParse}`;
    console.log(`  schema_parse_rate:       ${schemaNote}`);

    const failedStories = stories.filter((r) => r.failed);
    if (failedStories.length > 0) {
      console.log(`\n  Failed stories:`);
      for (const s of failedStories) {
        console.log(`    ${s.id.padEnd(22)} — ${s.failureReasons.join("; ")}`);
      }
    }
  };

  printDataset("GOLDEN", goldenResults);
  printDataset("NO_BIAS", noBiasResults);

  console.log(`\n📊 SYSTEM METRICS`);
  console.log("─────────────────────────────────────");
  console.log(`  schema_parse_rate:  ${sysMetrics.schemaParseRate?.toFixed(3) ?? "N/A"}  (${sysMetrics.schemaParsePassCount}/${sysMetrics.totalResponses})`);
  console.log(`  repair_rate:        ${sysMetrics.repairRate?.toFixed(3) ?? "N/A"}  (${sysMetrics.repairSuccessCount}/${sysMetrics.repairAttemptCount} repaired)`);

  console.log(`\n📋 DETERMINISM HASHES`);
  for (const r of [...goldenResults, ...noBiasResults]) {
    console.log(`  ${r.id.padEnd(22)} ${r.inputHash}`);
  }

  if (results.overallPassed) {
    console.log("\n🎉 All evaluation criteria passed!\n");
  } else {
    console.log(`\n❌ Evaluation failed\n`);
  }
}

async function main(): Promise<void> {
  const { provider: providerMode, thresholds } = parseArgs();
  const isMock = providerMode !== "real";

  console.log(`\n🔬 BIASSEMBLE EVALUATION`);
  console.log(`Provider: ${providerMode}${isMock ? " (repair tracking n/a — mock returns clean JSON)" : ""}`);
  console.log(`Thresholds:`);
  console.log(`  min-evidence-grounded: ${thresholds.minEvidenceGrounded}`);
  console.log(`  max-false-positive:    ${thresholds.maxFalsePositive}`);
  console.log(`  min-schema-parse:      ${thresholds.minSchemaParse}`);
  console.log(`  max-repair-rate:       ${thresholds.maxRepairRate}`);

  const provider = createProvider(providerMode);
  const modelName = isMock ? "mock-eval" : "gemini-2.0-flash";
  const result = await runEval(provider, modelName);

  printResults(result, thresholds, isMock);
  process.exit(result.exitCode);
}

main().catch((error) => {
  console.error("Evaluation script failed:", error);
  process.exit(1);
});