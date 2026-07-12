import { insertRetrievalComparison } from "../db/queries";
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
}
