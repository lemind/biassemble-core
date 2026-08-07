/**
 * Inngest eval job — real Gemini + Tavily live gate for Grounnel. Manual trigger only, no cron/CI
 * wiring — matches eval-reflection.ts's "real eval before prompt changes, never automatic" policy.
 *
 * Trigger: event "eval/grounnel-run" (scripts/trigger-eval-grounnel.ts sends it)
 * No Postgres (D019 §4) — nothing here is persisted beyond this run's Inngest step output.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { HybridSearchProvider } from "../providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../providers/search/tavily-provider.js";
import { runGrounnelEvalCase, summarizeGrounnelEvalCases, type GoldenCase } from "../evaluation/run-grounnel-eval.js";
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
      // Same dual-path resolution as eval-run.ts: local dev vs. pnpm build's bundled api/ layout.
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const vercelEvalDir = join(currentDir, "evaluations");
      const localEvalDir = join(currentDir, "..", "..", "evaluations");
      const evalRoot = existsSync(vercelEvalDir) ? vercelEvalDir : localEvalDir;
      const path = join(evalRoot, "golden", "grounnel", "live-eval-golden-set.json");
      return JSON.parse(readFileSync(path, "utf-8"));
    });

    const minCorrectRateOverride: number | undefined = event.data?.minCorrectRate;
    logger.info({ module: MODULE, cases: golden.cases.length }, "Starting Grounnel live eval run");

    // One step per case, not one step for the whole golden set — a transient failure on case N
    // shouldn't force Inngest to re-run (and re-spend real API quota on) cases 1..N-1 that already
    // succeeded; step.run's own memoization skips a case that's already completed on retry.
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const tavilyProvider = new TavilySearchProvider(env.TAVILY_API_KEY);
    const searchProvider = new HybridSearchProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, tavilyProvider);

    const cases = [];
    for (const goldenCase of golden.cases) {
      const caseResult = await step.run(`case-${goldenCase.id}`, () =>
        runGrounnelEvalCase({ provider, prompts, searchProvider }, goldenCase, minCorrectRateOverride)
      );
      cases.push(caseResult);
    }

    const summary = summarizeGrounnelEvalCases(cases);

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

    // Inngest's run status (green/red) reflects only whether this handler threw, not what it
    // returned — without this, a real failure (e.g. below_correct_rate) still shows green.
    // Full failed-case detail (claims/reasons/verdicts/violations) is embedded in the thrown
    // message itself, not just referenced — step.run output isn't always where this gets read
    // from (e.g. Vercel/Inngest error capture only shows the thrown message).
    if (!summary.passed) {
      const failed = summary.cases.filter((c) => !c.ok);
      throw new Error(
        `Grounnel live eval failed (${summary.totalCorrect}/${summary.totalMatched} correct, ` +
          `${summary.totalFalseAccusations} false accusations):\n${JSON.stringify(failed, null, 2)}`
      );
    }

    return summary;
  }
);
