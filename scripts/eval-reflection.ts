/**
 * Evaluation script for reflection orchestrators.
 *
 * ── Modes ──────────────────────────────────────────────────────────────
 *   pnpm eval                     Full suite — all golden + no_bias
 *   pnpm eval --story             Single random golden story (questions + assessment)
 *   pnpm eval --no-bias           Single random no_bias story (assessment only)
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

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MockProvider } from "../tests/mocks/mock-provider.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { runEval } from "../src/evaluation/run-eval.js";
import type { Provider } from "../src/providers/types.js";

interface ParsedArgs {
  provider: string;
  thresholds: Record<string, number>;
  /** undefined = full suite, "golden" = --story, "no_bias" = --no-bias */
  mode?: "golden" | "no_bias";
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let provider = "mock";
  let mode: "golden" | "no_bias" | undefined;
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
    else if (arg === "--story") { mode = "golden"; }
    else if (arg === "--no-bias") { mode = "no_bias"; }
    else if (arg === "--min-evidence-grounded" && next) { thresholds.minEvidenceGrounded = parseFloat(next); i++; }
    else if (arg === "--max-false-positive" && next) { thresholds.maxFalsePositive = parseFloat(next); i++; }
    else if (arg === "--min-schema-parse" && next) { thresholds.minSchemaParse = parseFloat(next); i++; }
    else if (arg === "--max-repair-rate" && next) { thresholds.maxRepairRate = parseFloat(next); i++; }
  }

  return { provider, thresholds, mode };
}

/**
 * Pick a random story from a specific dataset.
 */
function pickRandomStory(dataset: "golden" | "no_bias"): { story: string; id: string } {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "evaluations",
    dataset === "golden" ? "golden" : "no_bias",
    "reflection",
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const all: { id: string; story: string }[] = files.map((file) => {
    const raw = readFileSync(join(dir, file), "utf-8");
    const data = JSON.parse(raw);
    return { id: data.id ?? file, story: data.story };
  });
  return all[Math.floor(Math.random() * all.length)];
}

function createProvider(mode: string): Provider {
  if (mode === "real") return new GeminiProvider();
  const mock = new MockProvider();

  // Question response — matched by unique phrase from question-batch prompt (line 2)
  // Assessment prompt has same first line, so use "your goal is to help a user reflect"
  mock.setResponse("Your goal is to help a user reflect", {
    questions: [
      "What makes you feel this way?",
      "How has this situation affected your daily life?",
      "What evidence contradicts your current view?",
    ],
    isComplete: true,
    prompt_version: "1.0.0",
    schema_version: "1.0.0",
  });

  // Assessment response — default for all assessment calls (both golden and no_bias)
  mock.setDefault({
    biases: [
      {
        name: "confirmation bias",
        explanation: "The tendency to search for, interpret, favor, and recall information that confirms preexisting beliefs.",
        storyConnection: "You described filtering news to match your views, which aligns with this pattern.",
        evidence: [
          {
            source: "story" as const,
            excerpt: "Only read news that confirms my political views",
            relevance: "Direct statement of selective exposure",
          },
        ],
        confidence: 0.3,
        alternativePerspective: "Consider seeking out sources that challenge your existing views.",
      },
    ],
    reflectionPrompt: "Consider whether you might be dismissing contradictory evidence.",
    prompt_version: "1.0.0",
    schema_version: "1.0.0",
    noBiasDetected: false,
    inputContext: "full" as const,
    modelName: "mock-eval",
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
  const { provider: providerMode, thresholds, mode } = parseArgs();
  const isMock = providerMode !== "real";

  let storyText: string | undefined;
  let evalMode: "golden" | "no_bias" | undefined;

  if (mode === "golden") {
    const picked = pickRandomStory("golden");
    storyText = picked.story;
    evalMode = "golden";
    console.log(`\n📖 GOLDEN STORY — picked "${picked.id}" (questions + assessment)`);
  } else if (mode === "no_bias") {
    const picked = pickRandomStory("no_bias");
    storyText = picked.story;
    evalMode = "no_bias";
    console.log(`\n📖 NO_BIAS STORY — picked "${picked.id}" (assessment only, no questions)`);
  }

  console.log(`\n🔬 BIASSEMBLE EVALUATION`);
  console.log(`Provider: ${providerMode}${isMock ? " (repair tracking n/a — mock returns clean JSON)" : ""}`);
  if (storyText) {
    console.log(`Story:    "${storyText.slice(0, 80)}${storyText.length > 80 ? "..." : ""}"`);
  }
  console.log(`Thresholds:`);
  console.log(`  min-evidence-grounded: ${thresholds.minEvidenceGrounded}`);
  console.log(`  max-false-positive:    ${thresholds.maxFalsePositive}`);
  console.log(`  min-schema-parse:      ${thresholds.minSchemaParse}`);
  console.log(`  max-repair-rate:       ${thresholds.maxRepairRate}`);

  const provider = createProvider(providerMode);
  const modelName = isMock ? "mock-eval" : "gemini-2.0-flash";
  const result = await runEval(provider, modelName, storyText, evalMode, thresholds);

  printResults(result, thresholds, isMock);
  process.exit(result.exitCode);
}

main().catch((error) => {
  console.error("Evaluation script failed:", error);
  process.exit(1);
});
