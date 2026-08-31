// TEMP — safe to delete.
import { getDb } from "../src/db/config";
import { grounnelGateEvents, grounnelClaims } from "../src/db/schema";
import { eq, and } from "drizzle-orm";

const runId = process.argv[2];

async function main() {
  const db = getDb();
  const rows = await db
    .select({
      claimText: grounnelClaims.claimText,
      verdict: grounnelClaims.verdict,
      gate: grounnelGateEvents.gate,
      before: grounnelGateEvents.verdictBefore,
      after: grounnelGateEvents.verdictAfter,
      overridden: grounnelGateEvents.overridden,
      reason: grounnelGateEvents.reason,
    })
    .from(grounnelGateEvents)
    .innerJoin(grounnelClaims, eq(grounnelClaims.claimId, grounnelGateEvents.claimId))
    .where(and(eq(grounnelGateEvents.runId, runId), eq(grounnelGateEvents.overridden, true)));
  for (const r of rows) console.log(JSON.stringify(r));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
