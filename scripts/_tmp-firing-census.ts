// TEMP — safe to delete.
import { getDb } from "../src/db/config";
import { grounnelGateEvents, grounnelClaims, grounnelRuns } from "../src/db/schema";
import { sql, eq, and } from "drizzle-orm";

async function main() {
  const db = getDb();

  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(grounnelGateEvents)
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true)));

  const distinctClaims = await db
    .select({ n: sql<number>`count(DISTINCT ${grounnelGateEvents.claimId})` })
    .from(grounnelGateEvents)
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true)));

  const distinctRunClaim = await db
    .select({ n: sql<number>`count(DISTINCT (${grounnelGateEvents.runId}, ${grounnelGateEvents.claimId}))` })
    .from(grounnelGateEvents)
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true)));

  const bySource = await db
    .select({ source: grounnelRuns.source, n: sql<number>`count(DISTINCT ${grounnelGateEvents.claimId})` })
    .from(grounnelGateEvents)
    .innerJoin(grounnelRuns, eq(grounnelRuns.runId, grounnelGateEvents.runId))
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true)))
    .groupBy(grounnelRuns.source);

  console.log("subject_entity overridden=true:");
  console.log("  total gate events        :", total[0]?.n);
  console.log("  distinct claim_id        :", distinctClaims[0]?.n);
  console.log("  distinct (run,claim)     :", distinctRunClaim[0]?.n);
  console.log("  distinct claim by source :", JSON.stringify(bySource));

  // source_excerpt population — reviewer premise check
  const excerptStats = await db
    .select({
      total: sql<number>`count(*)`,
      withExcerpt: sql<number>`count(${grounnelClaims.sourceExcerpt})`,
    })
    .from(grounnelClaims);
  console.log("\ngrounnel_claims source_excerpt:");
  console.log("  total claims   :", excerptStats[0]?.total);
  console.log("  with excerpt   :", excerptStats[0]?.withExcerpt);

  // the contentless claim specifically
  const contentless = await db
    .select({ runId: grounnelClaims.runId, verdict: grounnelClaims.verdict, excerpt: grounnelClaims.sourceExcerpt })
    .from(grounnelClaims)
    .where(sql`${grounnelClaims.claimText} ILIKE '%really did die in a particular year%'`);
  console.log("\ncontentless claim rows:");
  for (const r of contentless) console.log("  ", r.runId.slice(0, 8), r.verdict, "| excerpt:", JSON.stringify(r.excerpt));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
