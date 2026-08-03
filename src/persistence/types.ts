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

// ── Retrieval Comparison Record (Stage 004) ──
// "retrieved": RAG was available synchronously when the assessment ran — it could
// have informed the output. "backfilled": RAG arrived late; the D017 backfill patched
// this row's RAG-derived fields in afterward, for retrospective analysis only — the
// assessment output itself was already decided without RAG. Conflating these two under
// one "retrieved" value was misleading (caught 2026-07-13: every "retrieved" row in a
// live spot-check turned out to be backfilled, none synchronous).
export type RagStatus = "retrieved" | "roster_fallback" | "unavailable" | "backfilled";

export interface RetrievalComparisonRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  ragList: string[];
  llmList: string[];
  finalList: string[];
  overlap: number;
  ragOnly: number;
  llmOnly: number;
  ragHitFinal: number;
  llmHitFinal: number;
  normalizationAdditions: number;
  ragStatus: RagStatus;
  // D017: generic per-source breakdown (no fixed set of source names) + per-run engine metadata.
  sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> | null;
  selectionStrategy: string | null;
  llmModel: string | null;
  createdAt: string;
}

// ── LLM Call Record (Stage 003) ──
export type LlmCallStatus = "success" | "timeout" | "error";
export type LlmCallFailureType = "schema_validation" | "parse_error" | "provider_error" | "timeout" | "other";
// "extract"/"verify" added for specs/008-b2b — llm_calls.stage is a plain
// text column with no DB-level CHECK constraint (same pattern D017 already
// used to add "backfilled" to RagStatus without a migration), so widening
// this TypeScript-level enum needs no schema change.
export type LlmCallStage = "assessment" | "question" | "extract" | "verify";
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
