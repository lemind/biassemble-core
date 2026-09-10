// Settles Grounnel runs whose container died before it could write a terminal status. Redis
// already knows the outcome (getStatus self-heals, D029/D031); this writes it back. Spec 018.
import { inngest } from "./client.js";
import type { GrounnelStore } from "../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { selectStuckGrounnelRunIds } from "../db/queries.js";
import { countVerdicts } from "../orchestrators/grounnel/pipeline.service.js";
import { logger } from "../observability/logger.js";

const MODULE = "reap-stuck-runs";
/** Comfortably past the 300s function ceiling, so a live run can never be caught by this. */
const ABANDONED_AFTER_MINUTES = 15;
const MAX_PER_SWEEP = 200;

export function createReapStuckRunsJob(grounnelStore: GrounnelStore, historyStore: GrounnelHistoryStore) {
  return inngest.createFunction(
    { id: "grounnel-reap-stuck-runs", name: "Grounnel — Settle abandoned runs" },
    { cron: "*/15 * * * *" },
    async () => {
      const runIds = await selectStuckGrounnelRunIds(ABANDONED_AFTER_MINUTES, MAX_PER_SWEEP);
      let done = 0;
      let failed = 0;

      for (const runId of runIds) {
        let status: "done" | "failed" = "failed";
        let score: Record<string, unknown> | undefined;
        try {
          // The self-heal inside getStatus is the authority — it already decides what a stale run
          // really is. Absent (expired Redis) means we genuinely cannot tell: fail closed.
          const live = await grounnelStore.getStatus(runId);
          if (live?.status === "done") {
            status = "done";
            score = { ...live.score, counts: countVerdicts(live.claims) };
          }
        } catch (err) {
          logger.warn({ module: MODULE, operation: "reap", runId, err }, "Could not read Redis for a stuck run — settling as failed");
        }

        await historyStore.updateRun(runId, { status, completedAt: new Date(), ...(score ? { score } : {}) });
        status === "done" ? done++ : failed++;
      }

      if (runIds.length > 0) {
        logger.warn({ module: MODULE, operation: "reap", done, failed }, "Settled abandoned Grounnel runs");
      }
      return { done, failed };
    }
  );
}
