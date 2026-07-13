import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "./config";
import {
  runs,
  reasoningTraces,
  evalResults,
  llmCalls,
  retrievalComparisons,
} from "./schema";
import type { LlmCallStage, LlmCallType, LlmCallStatus, LlmCallFailureType, RagStatus } from "../persistence/types";
import type { LlmCall } from "./schema";

function db() {
  return getDb();
}

// ── Runs ──

export async function createRun(
  sessionId: string,
  data: {
    provider: string;
    modelName: string;
    stage: "initial_assessment" | "post_questions_assessment";
    scope: "story_only" | "story_plus_answers";
    promptVersion: string;
    inputHash: string;
  }
) {
  const [row] = await db()
    .insert(runs)
    .values({
      sessionId,
      provider: data.provider,
      modelName: data.modelName,
      stage: data.stage,
      scope: data.scope,
      promptVersion: data.promptVersion,
      inputHash: data.inputHash,
    })
    .returning();
  return row;
}

export async function getRunsBySession(sessionId: string) {
  return await db()
    .select()
    .from(runs)
    .where(eq(runs.sessionId, sessionId))
    .orderBy(runs.createdAt);
}

// ── Reasoning Traces ──

export async function persistTrace(
  runId: string,
  trace: unknown,
) {
  const [row] = await db()
    .insert(reasoningTraces)
    .values({ runId, trace })
    .returning();
  return row;
}

export async function getTrace(runId: string) {
  const result = await db()
    .select()
    .from(reasoningTraces)
    .where(eq(reasoningTraces.runId, runId));
  return result[0] ?? null;
}

// ── Evaluation Results ──

export async function persistEvalResult(
  data: {
    runId?: string;
    provider: string;
    modelName: string;
    promptVersion: string;
    dataset: "golden" | "no_bias" | "all";
    evaluationMetrics: Record<string, unknown>;
    systemMetrics: Record<string, unknown>;
    inputHash: string;
    passed: boolean;
    evalRunId: string | null;
    scenarioId: string;
    rawOutput?: string | null;
  }
) {
  const [row] = await db()
    .insert(evalResults)
    .values(data)
    .returning();
  return row;
}

export async function getEvalResultByHash(
  inputHash: string,
  promptVersion: string
) {
  const result = await db()
    .select()
    .from(evalResults)
    .where(
      and(
        eq(evalResults.inputHash, inputHash),
        eq(evalResults.promptVersion, promptVersion)
      )
    );
  return result[0] ?? null;
}

export async function getLatestEvalResults(
  promptVersion: string,
  limit: number
) {
  return await db()
    .select()
    .from(evalResults)
    .where(eq(evalResults.promptVersion, promptVersion))
    .orderBy(desc(evalResults.runAt))
    .limit(limit);
}

// ── LLM Calls (Stage 003) ──

/**
 * Records an LLM call to the llm_calls table.
 * Note: durationMs is computed by the caller (typically executeAndRecordLlmCall),
 * not by this function.
 */
export async function recordLlmCall(
  data: {
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
  }
) {
  const [row] = await db()
    .insert(llmCalls)
    .values({
      ...data,
      startedAt: new Date(data.startedAt),
      endedAt: new Date(data.endedAt),
    })
    .returning();
  return row;
}

/**
 * Updates the parsed_output field for an LLM call record.
 * Called after successful parsing/repair to store the structured output.
 */
export async function updateLlmCallParsedOutput(
  id: string,
  parsedOutput: object
): Promise<void> {
  await db()
    .update(llmCalls)
    .set({ parsedOutput } as Partial<LlmCall>)
    .where(eq(llmCalls.id, id));
}

/**
 * Updates status and failure_type for an LLM call record.
 * Called when parsing/repair fails after the provider call succeeded.
 */
export async function updateLlmCallFailure(
  id: string,
  failureType: LlmCallFailureType,
  errorMessage: string | null
): Promise<void> {
  await db()
    .update(llmCalls)
    .set({
      status: "error",
      failureType,
      errorMessage
    } as Partial<LlmCall>)
    .where(eq(llmCalls.id, id));
}

export async function getCallsBySession(sessionId: string) {
  return await db()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.sessionId, sessionId))
    .orderBy(llmCalls.createdAt);
}

export async function getCallsByStage(stage: LlmCallStage) {
  return await db()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.stage, stage))
    .orderBy(llmCalls.createdAt);
}

export async function getCallsByProvider(provider: string) {
  return await db()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.provider, provider))
    .orderBy(llmCalls.createdAt);
}

export async function getCallsBySessionAndStage(
  sessionId: string,
  stage: LlmCallStage
) {
  return await db()
    .select()
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.sessionId, sessionId),
        eq(llmCalls.stage, stage)
      )
    )
    .orderBy(llmCalls.createdAt);
}

export async function getCallsForMetrics(filter: {
  timeRange?: { start: Date; end: Date };
  provider?: string;
  model?: string;
  stage?: LlmCallStage;
  limit?: number;
} = {}) {
  const conditions = [];

  // Default to last 30 days if no timeRange provided to prevent full table scans
  const timeRange = filter.timeRange ?? {
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    end: new Date()
  };

  conditions.push(
    and(
      gte(llmCalls.createdAt, timeRange.start),
      lte(llmCalls.createdAt, timeRange.end)
    )
  );

  if (filter.provider) {
    conditions.push(eq(llmCalls.provider, filter.provider));
  }

  if (filter.model) {
    conditions.push(eq(llmCalls.model, filter.model));
  }

  if (filter.stage) {
    conditions.push(eq(llmCalls.stage, filter.stage));
  }

  const limit = filter.limit ?? 10000;

  return await db()
    .select()
    .from(llmCalls)
    .where(and(...conditions))
    .limit(limit)
    .orderBy(llmCalls.createdAt);
}

// ── Eval Results Extensions (Stage 003) ──

export async function getEvalResultsByRunId(evalRunId: string) {
  return await db()
    .select()
    .from(evalResults)
    .where(eq(evalResults.evalRunId, evalRunId))
    .orderBy(evalResults.runAt);
}

export async function getEvalRunAggregates() {
  const results = await db()
    .select({
      evalRunId: evalResults.evalRunId,
      totalScenarios: sql<number>`count(*)::int`,
    })
    .from(evalResults)
    .groupBy(evalResults.evalRunId)
    .orderBy(desc(evalResults.runAt));
  return results;
}

// ── RAG Result (Stage 004) ──

export async function updateRunRagResult(runId: string, ragResult: unknown): Promise<void> {
  await db().execute(
    sql`UPDATE "core"."runs" SET "rag_result" = ${ragResult === null ? null : JSON.stringify(ragResult)}::jsonb WHERE "id" = ${runId}::uuid`
  );
}

export async function getRagResultBySession(sessionId: string): Promise<unknown | null> {
  const result = await db()
    .select({ ragResult: runs.ragResult })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), eq(runs.stage, "initial_assessment")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return result[0]?.ragResult ?? null;
}

// ── RAG Started At (Stage 005) ──

export async function updateRagStartedAt(runId: string, startedAt: Date): Promise<void> {
  await db()
    .update(runs)
    .set({ ragStartedAt: startedAt })
    .where(eq(runs.id, runId));
}

export async function getRagStartedAtBySession(sessionId: string): Promise<Date | null> {
  const result = await db()
    .select({ ragStartedAt: runs.ragStartedAt })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), eq(runs.stage, "initial_assessment")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return result[0]?.ragStartedAt ?? null;
}

// ── RAG Completed At (Stage 005) ──

export async function updateRagCompletedAt(runId: string, completedAt: Date): Promise<void> {
  await db()
    .update(runs)
    .set({ ragCompletedAt: completedAt })
    .where(eq(runs.id, runId));
}

// ── Retrieval Comparisons (Stage 004) ──

export async function insertRetrievalComparison(data: {
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
  sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> | null;
  selectionStrategy: string | null;
  llmModel: string | null;
}): Promise<void> {
  await db()
    .insert(retrievalComparisons)
    .values(data);
}

/**
 * Rows for this session still stuck at rag_status="unavailable" with no source_breakdown —
 * candidates for the D017 backfill once a late-arriving RAG result becomes available.
 */
export async function findUnbackfilledRetrievalComparisonsBySession(
  sessionId: string
): Promise<Array<{ id: string; llmList: unknown; finalList: unknown }>> {
  return db()
    .select({
      id: retrievalComparisons.id,
      llmList: retrievalComparisons.llmList,
      finalList: retrievalComparisons.finalList,
    })
    .from(retrievalComparisons)
    .where(
      and(
        eq(retrievalComparisons.sessionId, sessionId),
        eq(retrievalComparisons.ragStatus, "unavailable"),
        isNull(retrievalComparisons.sourceBreakdown),
      )
    );
}

/** Patches a single retrieval_comparisons row's RAG-derived fields once retrieval data lands late. */
export async function backfillRetrievalComparisonSourceData(
  id: string,
  data: {
    ragList: string[];
    ragStatus: RagStatus;
    ragOnly: number;
    llmOnly: number;
    overlap: number;
    ragHitFinal: number;
    normalizationAdditions: number;
    sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> | null;
    selectionStrategy: string | null;
    llmModel: string | null;
  }
): Promise<void> {
  await db()
    .update(retrievalComparisons)
    .set(data)
    .where(eq(retrievalComparisons.id, id));
}