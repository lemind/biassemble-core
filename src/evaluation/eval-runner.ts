import type { AssessmentOutput } from "../contracts/reflection.schemas.js";
import type { EvalResultStore } from "../persistence/ports.js";
import type { StoryBase } from "./run-eval.js";

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
  _config: DatasetRunConfig,
  _deps: DatasetRunDeps,
): Promise<DatasetRunResult> {
  throw new Error("Not implemented — see T405");
}
