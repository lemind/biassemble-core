import type { EvalResultStore } from "./ports";
import type { EvalResultRecord } from "./types";
import {
  persistEvalResult,
  getEvalResultByHash,
  getLatestEvalResults,
  getEvalResultsByRunId,
  getEvalRunAggregates,
} from "../db/queries";

export class DrizzleEvalResultStore implements EvalResultStore {
  async persistResult(result: Omit<EvalResultRecord, "id" | "runAt">): Promise<EvalResultRecord> {
    return persistEvalResult(result);
  }

  async getByHash(inputHash: string, promptVersion: string): Promise<EvalResultRecord | null> {
    return getEvalResultByHash(inputHash, promptVersion);
  }

  async getLatest(promptVersion: string, limit: number): Promise<EvalResultRecord[]> {
    return getLatestEvalResults(promptVersion, limit);
  }

  async getResultsByEvalRunId(evalRunId: string): Promise<EvalResultRecord[]> {
    return getEvalResultsByRunId(evalRunId);
  }

  async getEvalRunAggregates(): Promise<Array<{ evalRunId: string; totalScenarios: number }>> {
    return getEvalRunAggregates();
  }
}
