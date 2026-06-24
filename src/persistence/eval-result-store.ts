import type { EvalResultStore } from "./ports";
import type { EvalResultRecord } from "./types";
import {
  persistEvalResult as dbPersistEvalResult,
  getEvalResultByHash as dbGetEvalResultByHash,
  getLatestEvalResults as dbGetLatestEvalResults,
  getEvalResultsByRunId as dbGetEvalResultsByRunId,
  getEvalRunAggregates as dbGetEvalRunAggregates,
} from "../db/queries";
import { EvaluationMetricsSchema, SystemMetricsSchema } from "../contracts/reasoning.schemas";

/**
 * Maps a database row to an EvalResultRecord domain object.
 * Validates jsonb fields using Zod schemas to ensure type safety.
 */
function mapDbEvalResult(row: any): EvalResultRecord {
  return {
    id: row.id,
    runId: row.runId ?? undefined,
    provider: row.provider,
    modelName: row.modelName,
    promptVersion: row.promptVersion,
    dataset: row.dataset,
    evaluationMetrics: EvaluationMetricsSchema.parse(row.evaluationMetrics),
    systemMetrics: SystemMetricsSchema.parse(row.systemMetrics),
    inputHash: row.inputHash,
    passed: row.passed,
    runAt: row.runAt.toISOString(),
    evalRunId: row.evalRunId,
    scenarioId: row.scenarioId,
    rawOutput: row.rawOutput,
  };
}

export class DrizzleEvalResultStore implements EvalResultStore {
  async persistResult(result: Omit<EvalResultRecord, "id" | "runAt">): Promise<EvalResultRecord> {
    const dbResult = await dbPersistEvalResult({
      runId: result.runId,
      provider: result.provider,
      modelName: result.modelName,
      promptVersion: result.promptVersion,
      dataset: result.dataset as "golden" | "no_bias" | "all",
      evaluationMetrics: result.evaluationMetrics as Record<string, unknown>,
      systemMetrics: result.systemMetrics as Record<string, unknown>,
      inputHash: result.inputHash,
      passed: result.passed,
      evalRunId: result.evalRunId,
      scenarioId: result.scenarioId,
      rawOutput: result.rawOutput,
    });
    
    if (!dbResult) {
      throw new Error("Failed to persist eval result");
    }
    
    return mapDbEvalResult(dbResult);
  }

  async getByHash(inputHash: string, promptVersion: string): Promise<EvalResultRecord | null> {
    const result = await dbGetEvalResultByHash(inputHash, promptVersion);
    if (!result) return null;
    return mapDbEvalResult(result);
  }

  async getLatest(promptVersion: string, limit: number): Promise<EvalResultRecord[]> {
    const results = await dbGetLatestEvalResults(promptVersion, limit);
    return results.map(mapDbEvalResult);
  }

  async getResultsByEvalRunId(evalRunId: string): Promise<EvalResultRecord[]> {
    const results = await dbGetEvalResultsByRunId(evalRunId);
    return results.map(mapDbEvalResult);
  }

  async getEvalRunAggregates(): Promise<Array<{ evalRunId: string; totalScenarios: number }>> {
    const results = await dbGetEvalRunAggregates();
    return results
      .filter(r => r.evalRunId !== null)
      .map(r => ({
        evalRunId: r.evalRunId!,
        totalScenarios: r.totalScenarios,
      }));
  }
}
