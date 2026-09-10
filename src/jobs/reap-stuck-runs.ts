/**
 * Marks abandoned Grounnel runs failed in Postgres.
 *
 * A run lives inside `waitUntil` and dies when Vercel reaps the container at maxDuration, with no
 * chance to write its own terminal status. `getStatus`'s self-heal (D031) computes "failed" from
 * Redis on the fly, but never persists it — and once the Redis key expires, the Postgres row is
 * all a shared link has. 195 runs were stuck this way on 2026-09-10, the oldest from 2026-08-10.
 */
import { inngest } from "./client.js";
import { markStuckGrounnelRunsFailed } from "../db/queries.js";
import { logger } from "../observability/logger.js";

const MODULE = "reap-stuck-runs";
/** Matches grounnel-store's STUCK_RUN_TIMEOUT_MS, with slack so the two can never disagree. */
const ABANDONED_AFTER_MINUTES = 15;

export const reapStuckRunsJob = inngest.createFunction(
  { id: "grounnel-reap-stuck-runs", name: "Grounnel — Reap abandoned runs" },
  { cron: "*/15 * * * *" },
  async () => {
    const reaped = await markStuckGrounnelRunsFailed(ABANDONED_AFTER_MINUTES);
    if (reaped.length > 0) {
      logger.warn({ module: MODULE, operation: "reap", count: reaped.length, runIds: reaped.slice(0, 20) }, "Marked abandoned Grounnel runs failed");
    }
    return { reaped: reaped.length };
  }
);
