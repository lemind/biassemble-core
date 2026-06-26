/**
 * Inngest eval job — runs a dataset of stories through the pipeline and
 * persists per-scenario results to eval_results with a shared eval_run_id.
 *
 * ── Trigger ────────────────────────────────────────────────────────────
 *   Event: eval/dataset-run
 *   Payload: { dataset?: "golden" | "no_bias" | "all", modelName?: string }
 *
 * ── Datasets ───────────────────────────────────────────────────────────
 *   golden:  evaluations/golden/reflection/  (5 stories)
 *   no_bias: evaluations/no_bias/reflection/ (13 stories)
 *   all:     both combined
 *
 * ── No pass/fail gating ────────────────────────────────────────────────
 *   Phase 4 stores raw outputs only. Pass/fail scoring is future work.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { BiasCatalogService } from "../catalog/bias-catalog.js";
import { AssessmentService } from "../orchestrators/reflection/assessment.service.js";
import { DrizzleEvalResultStore } from "../persistence/eval-result-store.js";
import { DrizzleLlmCallStore } from "../persistence/llm-call-store.js";
import { DrizzleRunStore } from "../persistence/run-store.js";
import { DrizzleTraceStore } from "../persistence/trace-store.js";
import { runDataset } from "../evaluation/eval-runner.js";
import { loadStories } from "../evaluation/run-eval.js";
import type { GoldenStory, NoBiasStory, StoryBase } from "../evaluation/run-eval.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-run";

export const evalDatasetRunJob = inngest.createFunction(
  { id: "eval-dataset-run", name: "Eval — Dataset Run" },
  { event: "eval/dataset-run" },
  async ({ event }) => {
    const dataset: "golden" | "no_bias" | "all" = event.data?.dataset ?? "golden";
    const modelName: string = event.data?.modelName ?? "gemini-2.5-flash";

    logger.info({ module: MODULE, dataset, modelName }, "Starting dataset eval run");

    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const catalog = new BiasCatalogService();
    const llmCallStore = new DrizzleLlmCallStore();
    const runStore = new DrizzleRunStore();
    const traceStore = new DrizzleTraceStore();
    const evalResultStore = new DrizzleEvalResultStore();

    const assessmentService = new AssessmentService(
      provider,
      prompts,
      catalog,
      modelName,
      llmCallStore,
      runStore,
      traceStore,
    );

    // ── Resolve evaluations directory (works locally and in Vercel serverless) ──
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const vercelEvalDir = join(currentDir, "evaluations");
    const localEvalDir = join(currentDir, "..", "..", "evaluations");
    const evalRoot = existsSync(vercelEvalDir) ? vercelEvalDir : localEvalDir;

    const GOLDEN_DIR = join(evalRoot, "golden", "reflection");
    const NO_BIAS_DIR = join(evalRoot, "no_bias", "reflection");

    let stories: StoryBase[] = [];
    if (dataset === "golden" || dataset === "all") {
      stories = [...stories, ...loadStories<GoldenStory>(GOLDEN_DIR)];
    }
    if (dataset === "no_bias" || dataset === "all") {
      stories = [...stories, ...loadStories<NoBiasStory>(NO_BIAS_DIR)];
    }

    logger.info({ module: MODULE, dataset, storyCount: stories.length }, "Stories loaded");

    try {
      const result = await runDataset(
        { datasetName: dataset, stories, provider: "gemini", modelName },
        { assessmentService, evalResultStore, promptRegistry: prompts },
      );

      const output = {
        evalRunId: result.evalRunId,
        dataset,
        totalScenarios: result.totalScenarios,
        successCount: result.successCount,
        errorCount: result.errorCount,
      };

      if (result.errorCount > 0) {
        logger.warn({ module: MODULE, ...output }, "Dataset run completed with errors");
      } else {
        logger.info({ module: MODULE, ...output }, "Dataset run completed");
      }

      return output;
    } catch (error) {
      logger.error({ module: MODULE, dataset, error }, "Dataset run failed");
      return { evalRunId: null, dataset, totalScenarios: stories.length, successCount: 0, errorCount: stories.length };
    }
  },
);
