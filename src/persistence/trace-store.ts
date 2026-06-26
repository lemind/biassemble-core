import type { TraceStore } from "./ports";
import type { TraceRecord } from "./types";
import type { ReasoningTrace } from "../contracts/reasoning.schemas";
import { persistTrace as dbPersistTrace, getTrace as dbGetTrace } from "../db/queries";

export class DrizzleTraceStore implements TraceStore {
  async persistTrace(runId: string, trace: ReasoningTrace): Promise<TraceRecord> {
    const result = await dbPersistTrace(runId, trace);
    if (!result) {
      throw new Error("Failed to persist trace");
    }
    return {
      id: result.id,
      runId: result.runId,
      trace: result.trace as ReasoningTrace,
      createdAt: result.createdAt.toISOString(),
    };
  }

  async getTrace(runId: string): Promise<TraceRecord | null> {
    const result = await dbGetTrace(runId);
    if (!result) {
      return null;
    }
    return {
      id: result.id,
      runId: result.runId,
      trace: result.trace as ReasoningTrace,
      createdAt: result.createdAt.toISOString(),
    };
  }
}
