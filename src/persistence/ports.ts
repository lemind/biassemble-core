// Persistence Ports (interfaces only)
// Implementations live in biassemble/backend/src/lib/db/queries.ts using Drizzle + Supabase.

import type {
  RunRecord,
  SessionRecord,
  TraceRecord,
  EvalResultRecord,
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
}