// Persistence Ports (interfaces only)
// Implementations live in biassemble/backend/src/lib/db/queries.ts using Drizzle + Supabase.

import type {
  RunRecord,
  TraceRecord,
  EvalResultRecord,
  LlmCallRecord,
  LlmCallStage,
  LlmCallFailureType,
} from "./types";
import type { ReasoningTrace } from "../contracts/reasoning.schemas";

export interface RunStore {
  createRun(
    sessionId: string,
    data: Omit<RunRecord, "id" | "createdAt" | "sessionId">,
  ): Promise<RunRecord>;
  getRunsBySession(sessionId: string): Promise<RunRecord[]>;
}

export interface TraceStore {
  persistTrace(runId: string, trace: ReasoningTrace): Promise<TraceRecord>;
  getTrace(runId: string): Promise<TraceRecord | null>;
}

export interface EvalResultStore {
  persistResult(
    result: Omit<EvalResultRecord, "id" | "runAt">,
  ): Promise<EvalResultRecord>;
  getByHash(inputHash: string, promptVersion: string): Promise<EvalResultRecord | null>;
  getLatest(promptVersion: string, limit: number): Promise<EvalResultRecord[]>;
  // Stage 003 extensions
  getResultsByEvalRunId(evalRunId: string): Promise<EvalResultRecord[]>;
  getEvalRunAggregates(): Promise<Array<{ evalRunId: string; totalScenarios: number }>>;
}

// ── LLM Call Store (Stage 003) ──
export interface LlmCallStore {
  recordCall(data: Omit<LlmCallRecord, "id" | "createdAt">): Promise<LlmCallRecord>;
  getCallsBySession(sessionId: string): Promise<LlmCallRecord[]>;
  getCallsByStage(stage: LlmCallStage): Promise<LlmCallRecord[]>;
  getCallsByProvider(provider: string): Promise<LlmCallRecord[]>;
  getCallsBySessionAndStage(sessionId: string, stage: LlmCallStage): Promise<LlmCallRecord[]>;
  updateParsedOutput(id: string, parsedOutput: object): Promise<void>;
  updateFailure(id: string, failureType: LlmCallFailureType, errorMessage: string | null): Promise<void>;
  getCallsForMetrics(filter?: {
    timeRange?: { start: Date; end: Date };
    provider?: string;
    model?: string;
    stage?: LlmCallStage;
    limit?: number;
  }): Promise<LlmCallRecord[]>;
}
