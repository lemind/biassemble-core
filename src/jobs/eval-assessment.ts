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
import { randomUUID } from "node:crypto";
import { inngest } from "./client";
import { GeminiProvider } from "../providers/gemini";
import { runEval } from "../evaluation/run-eval";
import { DrizzleEvalResultStore } from "../persistence/eval-result-store";
import { PromptRegistry } from "../prompts/registry";
import { logger } from "../observability/logger";
import { DrizzleRunStore } from "../persistence/run-store";

const MODULE = "eval-assessment";

export const evalAssessmentJob = inngest.createFunction(
  { id: "eval-assessment", name: "Evaluation Assessment" },
  { event: "eval/assessment" },
  async ({ event }) => {
    const triggerType: "gate" | "monitor" = event.data?.triggerType ?? "monitor";
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const runStore = new DrizzleRunStore();
    const evalResultStore = new DrizzleEvalResultStore();
    const modelName = "gemini-2.0-flash";

    logger.info({ module: MODULE, triggerType }, "Starting eval assessment");

    try {
      const result = await runEval(provider, modelName);

      // ── Create run record ──────────────────────────────────
      let runId: string | undefined;
      try {
        const run = await runStore.createRun(randomUUID(), {
          provider: "gemini",
          modelName,
          stage: "initial_assessment",
          scope: "story_plus_answers",
          promptVersion: prompts.getVersion(),
          inputHash: result.goldenResults[0]?.inputHash ?? "",
        });
        runId = run?.id;
      } catch (err) {
        logger.warn({ module: MODULE, error: err }, "Failed to create run for eval — continuing without runId");
      }

      // ── Determinism check ───────────────────────────────────
      for (const storyResult of [...result.goldenResults, ...result.noBiasResults]) {
        const existing = await evalResultStore.getByHash(storyResult.inputHash, prompts.getVersion());
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
        await evalResultStore.persistResult({
          runId,
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
          evalRunId: runId!,
          scenarioId: "aggregate",
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

      if (!result.overallPassed) {
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

/**
 * Inngest job — runs a single random golden story (questions + assessment).
 * Triggered by event: eval/golden-story
 */
export const evalGoldenStoryJob = inngest.createFunction(
  { id: "eval-golden-story", name: "Eval — Single Golden Story" },
  { event: "eval/golden-story" },
  async () => {
    const provider = new GeminiProvider();
    const modelName = "gemini-2.0-flash";
    const prompts = new PromptRegistry();
    const runStore = new DrizzleRunStore();
    const evalResultStore = new DrizzleEvalResultStore();

    logger.info({ module: MODULE }, "Starting single golden story eval");

    try {
      const result = await runEval(provider, modelName, undefined, "golden");
      const story = result.goldenResults[0];

      // ── Create run record ──────────────────────────────────
      let runId: string | undefined;
      try {
        const run = await runStore.createRun(randomUUID(), {
          provider: "gemini",
          modelName,
          stage: "initial_assessment",
          scope: "story_plus_answers",
          promptVersion: prompts.getVersion(),
          inputHash: story?.inputHash ?? "",
        });
        runId = run?.id;
      } catch (err) {
        logger.warn({ module: MODULE, error: err }, "Failed to create run for golden eval — continuing without runId");
      }

      // ── Persist to DB ───────────────────────────────────────
      try {
        await evalResultStore.persistResult({
          runId,
          provider: "gemini",
          modelName,
          promptVersion: prompts.getVersion(),
          dataset: "golden",
          evaluationMetrics: {
            evidenceGroundedRate: story?.evaluationMetrics?.evidenceGroundedRate ?? null,
            isFalsePositive: story?.evaluationMetrics?.isFalsePositive ?? null,
          },
          systemMetrics: {
            schemaParseRate: result.sysMetrics.schemaParseRate,
            repairRate: result.sysMetrics.repairRate,
            totalResponses: result.sysMetrics.totalResponses,
          },
          inputHash: story?.inputHash ?? "",
          passed: result.overallPassed,
          evalRunId: runId!,
          scenarioId: story?.id ?? "unknown",
        });
      } catch (dbError) {
        logger.error({ module: MODULE, error: dbError }, "Failed to persist golden eval result — continuing");
      }

      const output = {
        passed: result.overallPassed,
        storyId: story?.id ?? "unknown",
        questionCount: story?.questionCount ?? 0,
        biasCount: story?.biasCount ?? 0,
        evidenceGroundedRate: story?.evaluationMetrics?.evidenceGroundedRate ?? null,
      };

      if (!result.overallPassed) {
        logger.error({ module: MODULE, ...output, errors: story?.errors }, "Golden story eval failed");
      } else {
        logger.info({ module: MODULE, ...output }, "Golden story eval completed");
      }

      return output;
    } catch (error) {
      logger.error({ module: MODULE, error }, "Golden story eval failed with exception");
      return { passed: false, reason: "eval_error", error: String(error) };
    }
  },
);

/**
 * Inngest job — runs a single random no_bias story (assessment only).
 * Triggered by event: eval/no-bias-story
 */
export const evalNoBiasStoryJob = inngest.createFunction(
  { id: "eval-no-bias-story", name: "Eval — Single No-Bias Story" },
  { event: "eval/no-bias-story" },
  async () => {
    const provider = new GeminiProvider();
    const modelName = "gemini-2.0-flash";
    const prompts = new PromptRegistry();
    const runStore = new DrizzleRunStore();
    const evalResultStore = new DrizzleEvalResultStore();

    logger.info({ module: MODULE }, "Starting single no_bias story eval");

    try {
      const result = await runEval(provider, modelName, undefined, "no_bias");
      const story = result.noBiasResults[0];

      // ── Create run record ──────────────────────────────────
      let runId: string | undefined;
      try {
        const run = await runStore.createRun(randomUUID(), {
          provider: "gemini",
          modelName,
          stage: "initial_assessment",
          scope: "story_only",
          promptVersion: prompts.getVersion(),
          inputHash: story?.inputHash ?? "",
        });
        runId = run?.id;
      } catch (err) {
        logger.warn({ module: MODULE, error: err }, "Failed to create run for no-bias eval — continuing without runId");
      }

      // ── Persist to DB ───────────────────────────────────────
      try {
        await evalResultStore.persistResult({
          runId,
          provider: "gemini",
          modelName,
          promptVersion: prompts.getVersion(),
          dataset: "no_bias",
          evaluationMetrics: {
            isFalsePositive: story?.evaluationMetrics?.isFalsePositive ?? null,
          },
          systemMetrics: {
            schemaParseRate: result.sysMetrics.schemaParseRate,
            repairRate: result.sysMetrics.repairRate,
            totalResponses: result.sysMetrics.totalResponses,
          },
          inputHash: story?.inputHash ?? "",
          passed: result.overallPassed,
          evalRunId: runId!,
          scenarioId: story?.id ?? "unknown",
        });
      } catch (dbError) {
        logger.error({ module: MODULE, error: dbError }, "Failed to persist no-bias eval result — continuing");
      }

      const output = {
        passed: result.overallPassed,
        storyId: story?.id ?? "unknown",
        biasCount: story?.biasCount ?? 0,
        isFalsePositive: story?.evaluationMetrics?.isFalsePositive ?? null,
      };

      if (!result.overallPassed) {
        logger.error({ module: MODULE, ...output, errors: story?.errors }, "No-bias story eval failed");
      } else {
        logger.info({ module: MODULE, ...output }, "No-bias story eval completed");
      }

      return output;
    } catch (error) {
      logger.error({ module: MODULE, error }, "No-bias story eval failed with exception");
      return { passed: false, reason: "eval_error", error: String(error) };
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
