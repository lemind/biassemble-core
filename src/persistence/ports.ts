// Persistence Ports (interfaces only)
// Implementations live in biassemble/backend/src/lib/db/queries.ts using Drizzle + Supabase.

import type {
  RunRecord,
  SessionRecord,
  TraceRecord,
  EvalResultRecord,
  LlmCallRecord,
} from "./types";

export interface SessionStore {
  createSession(storyId: string): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
}

export interface RunStore {
  createRun(
    sessionId: string,
    data: Omit<RunRecord, "id" | "createdAt">,
  ): Promise<RunRecord>;
  getRunsBySession(sessionId: string): Promise<RunRecord[]>;
}

export interface TraceStore {
  persistTrace(runId: string, trace: unknown): Promise<TraceRecord>;
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
  getCallsByStage(stage: "assessment" | "question"): Promise<LlmCallRecord[]>;
  getCallsByProvider(provider: string): Promise<LlmCallRecord[]>;
  getCallsBySessionAndStage(sessionId: string, stage: "assessment" | "question"): Promise<LlmCallRecord[]>;
}