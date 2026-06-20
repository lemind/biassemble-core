// Persistence Record Types (camelCase store boundary)
// These map to/from Zod schemas in reasoning.schemas.ts at the API boundary.
// Enums are imported from reasoning.schemas.ts to avoid duplication.

import type {
  ReasoningTrace,
  EvaluationMetrics,
  SystemMetrics,
} from "../contracts/reasoning.schemas";

export type { RunStage, RunScope, Dataset } from "../contracts/reasoning.schemas";

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
  stage: string;
  scope: string;
  promptVersion: string;
  inputHash: string;
  createdAt: string;
}

export interface TraceRecord {
  id: string;
  runId: string;
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
  // Stage 003 extensions
  evalRunId: string | null;
  scenarioId: string;
  rawOutput: string | null;
}

// ── LLM Call Record (Stage 003) ──
export type LlmCallStatus = "success" | "timeout" | "error";
export type LlmCallFailureType = "schema_validation" | "parse_error" | "provider_error" | "timeout" | "other";
export type LlmCallStage = "assessment" | "question";
export type LlmCallType = "primary" | "fallback";

export interface LlmCallRecord {
  id: string;
  sessionId: string | null;
  stage: LlmCallStage;
  callType: LlmCallType;
  provider: string;
  model: string;
  promptVersion: string;
  rawResponse: string | null;
  parsedOutput: Record<string, unknown> | null;
  status: LlmCallStatus;
  failureType: LlmCallFailureType | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
}
