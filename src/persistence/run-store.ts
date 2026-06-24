import type { RunStore } from "./ports";
import type { RunRecord } from "./types";
import { createRun as dbCreateRun, getRunsBySession as dbGetRunsBySession } from "../db/queries";

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
}
