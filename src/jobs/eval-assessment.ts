/**
 * Inngest eval job — runs golden + no_bias datasets against real Gemini,
 * persists results to eval_results, and checks determinism.
 *
 * ── Triggers ──────────────────────────────────────────────────────────
 *   Gate mode:     triggered by PRs modifying src/prompts/** via CI
 *   Monitor mode:  triggered by weekly cron
 *
 * ── Determinism ───────────────────────────────────────────────────────
 *   Before running, checks getEvalResultByHash() for existing result.
 *   Same hash → same metrics expected. If different, non-determinism
 *   detected and CI fails.
 */
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { runEval } from "../evaluation/run-eval.js";
import { persistEvalResult, getEvalResultByHash } from "../db/queries.js";
import { PromptRegistry } from "../prompts/registry.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-assessment";

export const evalAssessmentJob = inngest.createFunction(
  { id: "eval-assessment", name: "Evaluation Assessment" },
  { event: "eval/assessment" },
  async ({ event }) => {
    const triggerType: "gate" | "monitor" = event.data?.triggerType ?? "monitor";
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const modelName = "gemini-2.0-flash";

    logger.info({ module: MODULE, triggerType }, "Starting eval assessment");

    try {
      const result = await runEval(provider, modelName);

      // ── Determinism check ───────────────────────────────────
      for (const storyResult of [...result.goldenResults, ...result.noBiasResults]) {
        const existing = await getEvalResultByHash(storyResult.inputHash, prompts.getVersion());
        if (existing && existing.passed !== result.overallPassed) {
          logger.error(
            { module: MODULE, hash: storyResult.inputHash, previousPassed: existing.passed, currentPassed: result.overallPassed },
            "Non-determinism detected: same input hash produced different outcome",
          );
          if (triggerType === "gate") {
            return { passed: false, reason: "non_determinism", hash: storyResult.inputHash };
          }
        }
      }

      // ── Persist to DB ───────────────────────────────────────
      try {
        await persistEvalResult({
          provider: "gemini",
          modelName,
          promptVersion: prompts.getVersion(),
          dataset: "all",
          evaluationMetrics: {
            evidenceGroundedRate: computeAggregateGroundedRate(result),
            falsePositiveRate: computeFalsePositiveRate(result),
          },
          systemMetrics: {
            schemaParseRate: result.sysMetrics.schemaParseRate,
            repairRate: result.sysMetrics.repairRate,
            totalResponses: result.sysMetrics.totalResponses,
          },
          inputHash: result.goldenResults[0]?.inputHash ?? "",
          passed: result.overallPassed,
        });
      } catch (dbError) {
        logger.error({ module: MODULE, error: dbError }, "Failed to persist eval result — continuing");
      }

      const output = {
        passed: result.overallPassed,
        goldenStories: result.goldenResults.length,
        noBiasStories: result.noBiasResults.length,
        falsePositiveCount: result.noBiasResults.filter(r => r.evaluationMetrics?.isFalsePositive === true).length,
      };

        logger.error({ module: MODULE, ...output }, "Eval gate failed");
      } else {
        logger.info({ module: MODULE, ...output }, "Eval completed");
      }

      return output;
    } catch (error) {
      logger.error({ module: MODULE, error }, "Eval assessment failed");
      if (triggerType === "gate") {
        return { passed: false, reason: "eval_error", error: String(error) };
      }
      return { passed: false };
    }
  },
);

function computeAggregateGroundedRate(result: Awaited<ReturnType<typeof runEval>>): number | null {
  const all = [...result.goldenResults, ...result.noBiasResults]
    .filter(r => r.errors.length === 0)
    .map(r => r.evaluationMetrics?.evidenceGroundedRate)
    .filter((v): v is number => v !== null && v !== undefined);
  return all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : null;
}

function computeFalsePositiveRate(result: Awaited<ReturnType<typeof runEval>>): number | null {
  const noBias = result.noBiasResults;
  if (noBias.length === 0) return null;
  const count = noBias.filter(r => r.evaluationMetrics?.isFalsePositive === true).length;
  return count / noBias.length;
}
