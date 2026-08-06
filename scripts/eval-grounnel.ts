/**
 * Real, live-network eval for Grounnel — no mocks, hits real Gemini/Tavily/web fetch. Requires GEMINI_API_KEY + TAVILY_API_KEY; not run in CI (real eval before prompt changes, per eval-reflection.ts).
 *
 * Usage: pnpm eval:grounnel [--min-correct-rate 1.0]
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GeminiProvider } from "../src/providers/gemini.js";
import { PromptRegistry } from "../src/prompts/registry.js";
import { HybridSearchProvider } from "../src/providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../src/providers/search/tavily-provider.js";
import { runGrounnelEval, type GoldenCase } from "../src/evaluation/run-grounnel-eval.js";
import { env } from "../src/lib/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_SET_PATH = join(__dirname, "..", "evaluations", "golden", "grounnel", "live-eval-golden-set.json");
const FIXTURES_DIR = join(__dirname, "..", "evaluations", "golden", "grounnel", "live-eval-fixtures");

function parseArgs(): { minCorrectRateOverride?: number } {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--min-correct-rate");
  return idx >= 0 && args[idx + 1] ? { minCorrectRateOverride: parseFloat(args[idx + 1]!) } : {};
}

async function main() {
  if (!env.TAVILY_API_KEY) {
    console.error("TAVILY_API_KEY is not set — required for a real Grounnel eval run (SearchProvider fallback).");
    process.exit(1);
  }

  const { minCorrectRateOverride } = parseArgs();
  const golden: { cases: GoldenCase[] } = JSON.parse(readFileSync(GOLDEN_SET_PATH, "utf-8"));

  const provider = new GeminiProvider();
  const prompts = new PromptRegistry();
  const tavilyProvider = new TavilySearchProvider(env.TAVILY_API_KEY);
  const searchProvider = new HybridSearchProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, tavilyProvider);

  const summary = await runGrounnelEval({ provider, prompts, searchProvider }, golden, minCorrectRateOverride);

  for (const c of summary.cases) {
    if (c.run) writeFileSync(join(FIXTURES_DIR, `${c.id}-run.json`), JSON.stringify(c.run, null, 2) + "\n");
    if (c.error) {
      console.log(`${c.id} ... FAILED (real-run error, not a scoring failure): ${c.error}`);
      continue;
    }
    console.log(`${c.id} ... ${c.ok ? "PASS" : `FAIL (${c.violations.map((v) => v.rule).join(", ")})`}`);
    if (!c.ok) for (const v of c.violations) console.log(`    - ${v.rule}: ${v.detail}`);
  }

  console.log("\n─── Grounnel live eval summary ───");
  console.log(`Aggregate correct rate: ${summary.totalMatched === 0 ? "n/a" : (summary.totalCorrect / summary.totalMatched).toFixed(2)} (${summary.totalCorrect}/${summary.totalMatched})`);
  console.log(`False positives (true/silent claim marked contradicted): ${summary.totalFalseAccusations}`);

  if (!summary.passed) {
    console.error("\nFAILED");
    process.exit(1);
  }
  console.log("\nPASSED");
}

main();
