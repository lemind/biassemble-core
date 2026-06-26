import { randomUUID } from "node:crypto";
import type { AssessmentOutput } from "../contracts/reflection.schemas.js";
import type { EvalResultStore } from "../persistence/ports.js";
import { computeEvaluationMetrics } from "./compute-evaluation-metrics.js";
import { computeInputHash } from "../lib/hash.js";
import { logger } from "../observability/logger.js";
import type { StoryBase } from "./run-eval.js";

const MODULE = "eval-runner";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DatasetRunConfig {
  datasetName: "golden" | "no_bias" | "all";
  stories: StoryBase[];
  /** Provider name stored in eval_results, e.g. "gemini". */
  provider: string;
  modelName: string;
}

export interface DatasetRunDeps {
  assessmentService: {
    generate(story: string, questions: string[], answers: string[], requestId: string): Promise<AssessmentOutput>;
  };
  evalResultStore: Pick<EvalResultStore, "persistResult">;
  promptRegistry: {
    getVersion(): string;
  };
}

export interface DatasetRunResult {
  evalRunId: string;
  totalScenarios: number;
  successCount: number;
  errorCount: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function runDataset(
  config: DatasetRunConfig,
  deps: DatasetRunDeps,
): Promise<DatasetRunResult> {
  const { datasetName, stories, provider, modelName } = config;
  const { assessmentService, evalResultStore, promptRegistry } = deps;

  const evalRunId = randomUUID();
  const promptVersion = promptRegistry.getVersion();
  let successCount = 0;
  let errorCount = 0;

  for (const story of stories) {
    try {
      const assessmentOutput = await assessmentService.generate(
        story.story,
        [],
        [],
        `dataset-${story.id}`,
      );

      const metrics = computeEvaluationMetrics(
        {
          biases: assessmentOutput.biases.map((b) => ({
            name: b.name,
            evidence: b.evidence ?? [],
            confidence: (b as any).confidence,
          })),
        },
        { story: story.story, answers: [] },
      );

      await evalResultStore.persistResult({
        provider,
        modelName,
        promptVersion,
        dataset: datasetName,
        evaluationMetrics: {
          evidenceGroundedRate: metrics.evidenceGroundedRate,
          falsePositiveRate: metrics.isFalsePositive === null ? null : metrics.isFalsePositive ? 1 : 0,
        },
        systemMetrics: { schemaParseRate: null, repairRate: null },
        inputHash: computeInputHash(promptVersion, modelName, story.story, []),
        passed: false,
        evalRunId,
        scenarioId: story.id,
        rawOutput: JSON.stringify(assessmentOutput),
      });

      successCount++;
    } catch (error) {
      logger.error(
        { module: MODULE, storyId: story.id, error },
        "Story evaluation failed",
      );
      errorCount++;
    }
  }

  return { evalRunId, totalScenarios: stories.length, successCount, errorCount };
}
