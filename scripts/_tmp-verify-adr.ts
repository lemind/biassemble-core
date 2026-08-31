import { getDb } from "../src/db/config";
import { grounnelGateEvents, grounnelRuns } from "../src/db/schema";
import { sql, eq, and, gte } from "drizzle-orm";
async function main() {
  const db = getDb();
  // Which runs fired subject_entity since the Aug-30 re-eval?
  const rows = await db
    .select({ runId: grounnelRuns.runId, createdAt: grounnelRuns.createdAt, source: grounnelRuns.source,
              n: sql<number>`count(DISTINCT ${grounnelGateEvents.claimId})` })
    .from(grounnelGateEvents)
    .innerJoin(grounnelRuns, eq(grounnelRuns.runId, grounnelGateEvents.runId))
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true),
               gte(grounnelRuns.createdAt, new Date("2026-08-30T00:00:00Z"))))
    .groupBy(grounnelRuns.runId, grounnelRuns.createdAt, grounnelRuns.source)
    .orderBy(grounnelRuns.createdAt);
  console.log("runs firing subject_entity since 2026-08-30:");
  for (const r of rows) console.log("  ", r.runId.slice(0,8), r.createdAt, r.source, "distinct claims:", r.n);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
