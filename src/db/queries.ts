import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./config";
import {
  runs,
  reasoningTraces,
  evalResults,
  llmCalls,
} from "./schema";
import type { LlmCallStage, LlmCallType, LlmCallStatus, LlmCallFailureType } from "../persistence/types";
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