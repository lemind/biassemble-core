/**
 * Inngest eval job — real Gemini + Tavily live gate for Grounnel. Manual trigger only, no cron/CI
 * wiring — matches eval-reflection.ts's "real eval before prompt changes, never automatic" policy.
 *
 * Trigger: event "eval/grounnel-run" (scripts/trigger-eval-grounnel.ts sends it)
 * No Postgres (D019 §4) — nothing here is persisted beyond this run's Inngest step output.
 */
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { HybridSearchProvider } from "../providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../providers/search/tavily-provider.js";
import { runGrounnelEval, type GoldenCase } from "../evaluation/run-grounnel-eval.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-grounnel-run";

export const evalGrounnelRunJob = inngest.createFunction(
  { id: "eval-grounnel-run", name: "Eval — Grounnel Live Gate" },
  { event: "eval/grounnel-run" },
  async ({ event, step }) => {
    if (!env.TAVILY_API_KEY) {
      throw new Error("TAVILY_API_KEY is not set — required for a real Grounnel eval run.");
    }

    const golden: { cases: GoldenCase[] } = await step.run("load-golden-set", async () => {
      const { readFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const path = join(currentDir, "..", "..", "evaluations", "golden", "grounnel", "live-eval-golden-set.json");
      return JSON.parse(readFileSync(path, "utf-8"));
    });

    const minCorrectRateOverride: number | undefined = event.data?.minCorrectRate;
    logger.info({ module: MODULE, cases: golden.cases.length }, "Starting Grounnel live eval run");

    const summary = await step.run("run-live-gate", async () => {
      const provider = new GeminiProvider();
      const prompts = new PromptRegistry();
      const tavilyProvider = new TavilySearchProvider(env.TAVILY_API_KEY!);
      const searchProvider = new HybridSearchProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, tavilyProvider);
      return runGrounnelEval({ provider, prompts, searchProvider }, golden, minCorrectRateOverride);
    });

    logger.info(
      {
        module: MODULE,
        passed: summary.passed,
        correctRate: summary.totalMatched === 0 ? null : summary.totalCorrect / summary.totalMatched,
        totalMatched: summary.totalMatched,
        falseAccusations: summary.totalFalseAccusations,
      },
      summary.passed ? "Grounnel live eval passed" : "Grounnel live eval failed"
    );

    return summary;
  }
);
