import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./config";
import {
  runs,
  reasoningTraces,
  evalResults,
} from "./schema";

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
  trace: unknown
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