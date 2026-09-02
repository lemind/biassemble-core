/**
 * spec 014 T004 — simulate the escalation-exception rule against every historical
 * `escalation_replacement` rejection. Zero API cost: reads persisted telemetry only.
 *
 * Candidate rule: when prior.verdict === "contradicted" and the evidence-empty replacement
 * verdict is in {unsupported, unverifiable}, accept the replacement instead of restoring the
 * contradiction. Every other combination keeps today's behaviour.
 *
 * The attempted replacement verdict is not stored on the gate event (verdictAfter is the
 * RESTORED prior). It is recovered from the escalation pass's own gate-chain rows, which share
 * the escalation_replacement event's timestamp — their verdictBefore is what the tier produced.
 *
 * Usage: npx tsx --env-file=.env scripts/t004-simulate-escalation-exception.ts
 */
import { getDb } from "../src/db/config";
import { grounnelClaims, grounnelGateEvents } from "../src/db/schema";
import { and, eq } from "drizzle-orm";

const RETRACTABLE = new Set(["unsupported", "unverifiable"]);

async function main() {
  const db = getDb();

  const rejections = await db
    .select()
    .from(grounnelGateEvents)
    .where(and(eq(grounnelGateEvents.gate, "escalation_replacement"), eq(grounnelGateEvents.overridden, true)));

  const fromContradicted = rejections.filter((r) => r.verdictBefore === "contradicted");

  console.log("=== POPULATION ===");
  console.log("escalation_replacement rejections total:      ", rejections.length);
  console.log("  ...where the restored prior was contradicted:", fromContradicted.length);

  const buckets = { released: [] as any[], kept: [] as any[], unknown: [] as any[] };

  for (const r of fromContradicted) {
    // The escalation pass's own gate-chain rows are flushed in the same batch, immediately before
    // this event. Timestamp equality is unreliable (microsecond precision vs JS Date), so walk the
    // claim's ordered history back from the rejection to the nearest ordinary gate row instead.
    const history = await db
      .select()
      .from(grounnelGateEvents)
      .where(eq(grounnelGateEvents.claimId, r.claimId))
      .orderBy(grounnelGateEvents.createdAt);
    const idx = history.findIndex((g) => g.id === r.id);
    let attempted: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i]!.gate !== "escalation_replacement") {
        attempted = history[i]!.verdictBefore;
        break;
      }
    }

    const [claim] = await db.select().from(grounnelClaims).where(eq(grounnelClaims.claimId, r.claimId));
    const row = {
      claimId: r.claimId,
      runId: r.runId.slice(0, 8),
      attempted,
      wouldRelease: attempted !== null && RETRACTABLE.has(attempted),
      claimText: claim?.claimText ?? "(claim row missing)",
      reason: String(claim?.reason ?? "").slice(0, 160),
    };
    if (attempted === null) buckets.unknown.push(row);
    else if (row.wouldRelease) buckets.released.push(row);
    else buckets.kept.push(row);
  }

  console.log("\n=== SIMULATION ===");
  console.log("would be RELEASED (contradiction retracted -> " + [...RETRACTABLE].join("/") + "):", buckets.released.length);
  console.log("would still be KEPT (attempted verdict not retractable):                      ", buckets.kept.length);
  console.log("UNKNOWN (attempted verdict not recoverable):                                   ", buckets.unknown.length);

  for (const [name, rows] of Object.entries(buckets)) {
    if (!rows.length) continue;
    console.log("\n--- " + name.toUpperCase() + " ---");
    for (const b of rows as any[]) {
      console.log(`${b.runId}  ${b.claimId.slice(0, 8)}  attempted=${b.attempted}`);
      console.log(`    claim:  ${b.claimText}`);
      console.log(`    reason: ${b.reason}`);
    }
  }

  console.log(
    "\nHAND-LABEL the RELEASED rows: each is either a correct contradiction destroyed (bucket 1, VETO)\n" +
      "or a false accusation freed (bucket 2, desired). Pre-registered kill criterion: bucket 1 must be ~0."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
