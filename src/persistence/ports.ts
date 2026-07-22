// Persistence Ports (interfaces only)
// Implementations live in biassemble/backend/src/lib/db/queries.ts using Drizzle + Supabase.

import type {
  RunRecord,
  TraceRecord,
  EvalResultRecord,
  LlmCallRecord,
  LlmCallStage,
  LlmCallFailureType,
  RetrievalComparisonRecord,
} from "./types";
import type { ReasoningTrace } from "../contracts/reasoning.schemas";

export interface RunStore {
  createRun(
    sessionId: string,
    data: Omit<RunRecord, "id" | "createdAt" | "sessionId">,
  ): Promise<RunRecord>;
  getRunsBySession(sessionId: string): Promise<RunRecord[]>;
  // Stage 004: RAG result bridging between story-only and full assessment requests
  storeRagResult(runId: string, result: unknown): Promise<void>;
  getRagResultForSession(sessionId: string): Promise<unknown | null>;
  // Stage 005: async RAG timing
  recordRagStarted(runId: string, startedAt: Date): Promise<void>;
  getRagStartedAtForSession(sessionId: string): Promise<Date | null>;
  recordRagCompleted(runId: string, completedAt: Date): Promise<void>;
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

// ── Retrieval Comparison Store (Stage 004) ──
export interface RetrievalComparisonStore {
  record(data: Omit<RetrievalComparisonRecord, "id" | "createdAt">): Promise<void>;
  /**
   * Rows for this session still stuck at rag_status="unavailable" with no source_breakdown —
   * candidates for backfill once a late-arriving RAG result shows up (D017 backfill). Returns
   * only the fields needed to recompute stats (llmList/finalList are frozen at record time and
   * don't change on backfill — only the RAG-derived fields do).
   */
  findUnbackfilledBySession(sessionId: string): Promise<Array<{ id: string; llmList: string[]; finalList: string[] }>>;
  /**
   * Patches a single row's RAG-derived fields in place once retrieval data becomes available.
   * overlap/ragOnly/llmOnly/ragHitFinal/normalizationAdditions ALL depend on ragList, so all
   * five get recomputed and rewritten here — not just the ones that look "RAG-only" at a
   * glance (llmOnly and normalizationAdditions are easy to miss since they're llm*-named but
   * both subtract/reference ragList too). llmHitFinal is the only aggregate count that
   * genuinely doesn't depend on ragList, so it's the only one NOT rewritten.
   */
  backfillSourceData(id: string, data: {
    ragList: string[];
    ragStatus: RetrievalComparisonRecord["ragStatus"];
    ragOnly: number;
    llmOnly: number;
    overlap: number;
    ragHitFinal: number;
    normalizationAdditions: number;
    sourceBreakdown: RetrievalComparisonRecord["sourceBreakdown"];
    selectionStrategy: string | null;
    llmModel: string | null;
  }): Promise<void>;
}

// ── LLM Call Store (Stage 003) ──
export interface LlmCallStore {
  recordCall(data: Omit<LlmCallRecord, "id" | "createdAt">): Promise<LlmCallRecord>;
  getCallsBySession(sessionId: string): Promise<LlmCallRecord[]>;
  /**
   * Token/call-count aggregate for one session, without fetching full rows
   * (rawResponse/parsedOutput blobs) — optional so existing implementations
   * and test doubles that only need getCallsBySession aren't forced to add
   * it; callers that want the efficient path (e.g. audit.service.ts's
   * logCostSummary, T040) fall back to summing getCallsBySession's full
   * rows when this isn't provided.
   */
  getCallCostsBySession?(
    sessionId: string
  ): Promise<{ count: number; inputTokens: number; outputTokens: number; totalTokens: number }>;
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
