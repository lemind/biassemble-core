import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./config";
import {
  runs,
  reasoningTraces,
  evalResults,
  llmCalls,
} from "./schema";
import type { LlmCallStage, LlmCallType, LlmCallStatus, LlmCallFailureType } from "../persistence/types";

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
    evalRunId: string;
    scenarioId: string;
    rawOutput?: string;
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
  parsedOutput: Record<string, unknown>
): Promise<void> {
  await db()
    .update(llmCalls)
    .set({ parsedOutput })
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