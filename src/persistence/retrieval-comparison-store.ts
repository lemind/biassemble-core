import {
  insertRetrievalComparison,
  findUnbackfilledRetrievalComparisonsBySession,
  backfillRetrievalComparisonSourceData,
} from "../db/queries";
import type { RetrievalComparisonStore } from "./ports";
import type { RetrievalComparisonRecord } from "./types";

export class DrizzleRetrievalComparisonStore implements RetrievalComparisonStore {
  async record(data: Omit<RetrievalComparisonRecord, "id" | "createdAt">): Promise<void> {
    await insertRetrievalComparison({
      sessionId: data.sessionId,
      runId: data.runId,
      ragList: data.ragList,
      llmList: data.llmList,
      finalList: data.finalList,
      overlap: data.overlap,
      ragOnly: data.ragOnly,
      llmOnly: data.llmOnly,
      ragHitFinal: data.ragHitFinal,
      llmHitFinal: data.llmHitFinal,
      normalizationAdditions: data.normalizationAdditions,
      ragStatus: data.ragStatus,
      sourceBreakdown: data.sourceBreakdown,
      selectionStrategy: data.selectionStrategy,
      llmModel: data.llmModel,
    });
  }

  async findUnbackfilledBySession(sessionId: string): Promise<Array<{ id: string; llmList: string[]; finalList: string[] }>> {
    const rows = await findUnbackfilledRetrievalComparisonsBySession(sessionId);
    // llmList/finalList are jsonb columns we only ever write as string[] ourselves — safe cast.
    return rows.map((r) => ({ id: r.id, llmList: r.llmList as string[], finalList: r.finalList as string[] }));
  }

  async backfillSourceData(id: string, data: Parameters<RetrievalComparisonStore["backfillSourceData"]>[1]): Promise<void> {
    await backfillRetrievalComparisonSourceData(id, data);
  }
}
