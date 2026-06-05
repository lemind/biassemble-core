// Persistence Record Types (camelCase store boundary)
// These map to/from Zod schemas in reasoning.schemas.ts at the API boundary.
// Enums are imported from reasoning.schemas.ts to avoid duplication.

import type {
  ReasoningTrace,
  EvaluationMetrics,
  SystemMetrics,
} from "../contracts/reasoning.schemas";

export type { RunStage, RunScope, Dataset } from "../contracts/reasoning.schemas";

export interface RunRecord {
  id: string;
  sessionId: string;
  provider: string;
  modelName: string;
  stage: string;
  scope: string;
  promptVersion: string;
  inputHash: string;
  createdAt: string;
}

export interface TraceRecord {
  id: string;
  runId: string;
  traceType: "story_only" | "full";
  trace: ReasoningTrace;
  createdAt: string;
}

export interface EvalResultRecord {
  id: string;
  runId?: string;
  provider: string;
  modelName: string;
  promptVersion: string;
  dataset: string;
  evaluationMetrics: EvaluationMetrics;
  systemMetrics: SystemMetrics;
  inputHash: string;
  passed: boolean;
  runAt: string;
}
