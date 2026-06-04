// Persistence Record Types (camelCase store boundary)
// These map to/from Zod schemas in reasoning.schemas.ts at the API boundary.

export type RunStage = "initial_assessment" | "post_questions_assessment";
export type RunScope = "story_only" | "story_plus_answers";
export type Dataset = "golden" | "no_bias" | "all";

export interface SessionRecord {
  id: string;
  storyId: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  provider: string;
  modelName: string;
  stage: RunStage;
  scope: RunScope;
  promptVersion: string;
  inputHash: string;
  createdAt: string;
}

export interface TraceRecord {
  id: string;
  runId: string;
  trace: unknown;
  createdAt: string;
}

export interface EvalResultRecord {
  id: string;
  runId?: string;
  provider: string;
  modelName: string;
  promptVersion: string;
  dataset: Dataset;
  evaluationMetrics: Record<string, unknown>;
  systemMetrics: Record<string, unknown>;
  inputHash: string;
  passed: boolean;
  runAt: string;
}
