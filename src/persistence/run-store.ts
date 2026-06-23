import type { RunStore } from "./ports";
import type { RunRecord } from "./types";
import { createRun, getRunsBySession } from "../db/queries";

export class DrizzleRunStore implements RunStore {
  async createRun(
    sessionId: string,
    data: Omit<RunRecord, "id" | "createdAt">
  ): Promise<RunRecord> {
    return createRun(sessionId, data);
  }

  async getRunsBySession(sessionId: string): Promise<RunRecord[]> {
    return getRunsBySession(sessionId);
  }
}
