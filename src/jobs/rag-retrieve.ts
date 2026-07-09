/**
 * Inngest background job — performs RAG retrieval fired at story submission
 * (Stage 005: async RAG). Decouples retrieval latency from the story_only
 * response path; result is written to the run record for the full
 * assessment to pick up later.
 *
 * ── Trigger ────────────────────────────────────────────────────────────
 *   Event: rag/retrieve.requested
 *   Payload: { story: string; sessionId: string; runId: string; startedAt: string }
 */
import { inngest } from "./client";
import { logger } from "../observability/logger";
import type { RagEngineClient } from "../rag/engine-client";
import type { RunStore } from "../persistence/ports";

const MODULE = "rag-retrieve-job";

export function createRagRetrieveJob(ragClient: RagEngineClient, runStore: RunStore) {
  return inngest.createFunction(
    { id: "rag-retrieve", name: "RAG — Background Retrieve" },
    { event: "rag/retrieve.requested" },
    async ({ event }) => {
      const { story, sessionId, runId } = event.data as {
        story: string;
        sessionId: string;
        runId: string;
        startedAt: string;
      };

      const t0 = Date.now();
      try {
        const result = await ragClient.retrieve(story);
        await runStore.storeRagResult(runId, result.status === "ok" ? result.data : null);
        await runStore.recordRagCompleted(runId, new Date());
        logger.info(
          { module: MODULE, status: result.status, sessionId, runId, durationMs: Date.now() - t0 },
          "rag_retrieve_complete"
        );
      } catch (err) {
        logger.warn({ module: MODULE, err, sessionId, runId }, "rag_retrieve_failed");
        await runStore.storeRagResult(runId, null).catch(() => {/* already logged by storeRagResult */});
        await runStore.recordRagCompleted(runId, new Date()).catch(() => {/* already logged by recordRagCompleted */});
      }
    }
  );
}
