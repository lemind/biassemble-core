import { logger } from "../observability/logger";
import type { RunStore } from "./ports";
import type { RunRecord } from "./types";
import {
  createRun as dbCreateRun,
  getRunsBySession as dbGetRunsBySession,
  updateRunRagResult,
  getRagResultBySession,
  updateRagStartedAt,
  getRagStartedAtBySession,
  updateRagCompletedAt,
} from "../db/queries";

export class DrizzleRunStore implements RunStore {
  async createRun(
    sessionId: string,
    data: Omit<RunRecord, "id" | "createdAt" | "sessionId">
  ): Promise<RunRecord> {
    const result = await dbCreateRun(sessionId, {
      provider: data.provider,
      modelName: data.modelName,
      stage: data.stage as "initial_assessment" | "post_questions_assessment",
      scope: data.scope as "story_only" | "story_plus_answers",
      promptVersion: data.promptVersion,
      inputHash: data.inputHash,
    });
    if (!result) {
      throw new Error("Failed to create run");
    }
    return {
      ...result,
      sessionId,
      createdAt: result.createdAt.toISOString(),
    };
  }

  async getRunsBySession(sessionId: string): Promise<RunRecord[]> {
    const results = await dbGetRunsBySession(sessionId);
    return results.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async storeRagResult(runId: string, result: unknown): Promise<void> {
    try {
      await updateRunRagResult(runId, result);
    } catch (err) {
      logger.warn({ err, runId }, "rag_store_failed");
    }
  }

  async getRagResultForSession(sessionId: string): Promise<unknown | null> {
    return getRagResultBySession(sessionId);
  }

  async recordRagStarted(runId: string, startedAt: Date): Promise<void> {
    try {
      await updateRagStartedAt(runId, startedAt);
    } catch (err) {
      logger.warn({ err, runId }, "rag_started_at_store_failed");
    }
  }

  async getRagStartedAtForSession(sessionId: string): Promise<Date | null> {
    try {
      return await getRagStartedAtBySession(sessionId);
    } catch (err) {
      logger.warn({ err, sessionId }, "rag_started_at_fetch_failed");
      return null;
    }
  }

  async recordRagCompleted(runId: string, completedAt: Date): Promise<void> {
    try {
      await updateRagCompletedAt(runId, completedAt);
    } catch (err) {
      logger.warn({ err, runId }, "rag_completed_at_store_failed");
    }
  }
}
