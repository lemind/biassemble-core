import type { LlmCallStore } from "./ports";
import type { LlmCallRecord, LlmCallStage, LlmCallFailureType } from "./types";
import {
  recordLlmCall,
  updateLlmCallParsedOutput,
  updateLlmCallFailure,
  getCallsBySession,
  getCallsByStage,
  getCallsByProvider,
  getCallsBySessionAndStage,
  getCallsForMetrics as dbGetCallsForMetrics,
} from "../db/queries";

/**
 * Converts a database row to LlmCallRecord format.
 * Database returns Date objects for timestamps, but LlmCallRecord expects ISO strings.
 */
function toLlmCallRecord(row: any): LlmCallRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    stage: row.stage,
    callType: row.callType,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    rawResponse: row.rawResponse,
    parsedOutput: row.parsedOutput,
    status: row.status,
    failureType: row.failureType,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
    endedAt: row.endedAt instanceof Date ? row.endedAt.toISOString() : row.endedAt,
    durationMs: row.durationMs,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

/**
 * LlmCallStore adapter that wraps the existing query functions.
 * This bridges the port/adapter pattern with the existing DB implementation.
 */
export class DrizzleLlmCallStore implements LlmCallStore {
  async recordCall(data: Omit<LlmCallRecord, "id" | "createdAt">): Promise<LlmCallRecord> {
    const row = await recordLlmCall(data);
    if (!row) {
      throw new Error("recordLlmCall returned no row");
    }
    return toLlmCallRecord(row);
  }

  async getCallsBySession(sessionId: string): Promise<LlmCallRecord[]> {
    const rows = await getCallsBySession(sessionId);
    return rows.map(toLlmCallRecord);
  }

  async getCallsByStage(stage: LlmCallStage): Promise<LlmCallRecord[]> {
    const rows = await getCallsByStage(stage);
    return rows.map(toLlmCallRecord);
  }

  async getCallsByProvider(provider: string): Promise<LlmCallRecord[]> {
    const rows = await getCallsByProvider(provider);
    return rows.map(toLlmCallRecord);
  }

  async getCallsBySessionAndStage(sessionId: string, stage: LlmCallStage): Promise<LlmCallRecord[]> {
    const rows = await getCallsBySessionAndStage(sessionId, stage);
    return rows.map(toLlmCallRecord);
  }

  async updateParsedOutput(id: string, parsedOutput: object): Promise<void> {
    return updateLlmCallParsedOutput(id, parsedOutput);
  }

  async updateFailure(id: string, failureType: LlmCallFailureType, errorMessage: string | null): Promise<void> {
    return updateLlmCallFailure(id, failureType, errorMessage);
  }

  async getCallsForMetrics(filter?: {
    timeRange?: { start: Date; end: Date };
    provider?: string;
    model?: string;
    stage?: LlmCallStage;
    limit?: number;
  }): Promise<LlmCallRecord[]> {
    const rows = await dbGetCallsForMetrics(filter);
    return rows.map(toLlmCallRecord);
  }
}
