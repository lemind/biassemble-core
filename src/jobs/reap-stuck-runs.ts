/**
 * Settles Grounnel runs whose container was reaped before they could write a terminal status.
 *
 * A run lives inside `waitUntil` and dies when Vercel hits maxDuration. Redis still knows what
 * actually happened — `getStatus`'s self-heal (D029/D031) derives "done" or "failed" from the
 * claims themselves — but nothing ever wrote that back, so 195 runs sat non-terminal on
 * 2026-09-10, the oldest from 2026-08-10, each one a share link that spins forever.
 *
 * Redis is consulted per run, NOT assumed failed: a run that verified every claim and died only
 * on the final write is `done`, and marking it failed would hide a complete result behind
 * "this check stopped before it finished". Failed is the fallback for when Redis has expired.
 */
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
