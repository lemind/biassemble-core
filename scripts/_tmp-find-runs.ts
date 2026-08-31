// TEMP — safe to delete.
import { getDb } from "../src/db/config";
import { grounnelRuns, grounnelClaims } from "../src/db/schema";
import { sql, eq } from "drizzle-orm";

async function main() {
  const db = getDb();
  const rows = await db
    .select({ runId: grounnelRuns.runId, createdAt: grounnelRuns.createdAt, status: grounnelRuns.status, source: grounnelRuns.source, count: sql<number>`count(${grounnelClaims.claimId})` })
    .from(grounnelRuns)
    .leftJoin(grounnelClaims, eq(grounnelClaims.runId, grounnelRuns.runId))
    .groupBy(grounnelRuns.runId)
    .orderBy(grounnelRuns.createdAt);
  for (const r of rows) {
    if (Number(r.count) >= 40) {
      console.log(JSON.stringify(r));
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
