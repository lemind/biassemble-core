// TEMP — not part of the codebase, used to poll a live grounnel run during manual verification.
// Safe to delete.
import { getDb } from "../src/db/config";
import { grounnelRuns, grounnelClaims } from "../src/db/schema";
import { eq } from "drizzle-orm";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: tsx _tmp-poll-run.ts <runId>");
  process.exit(1);
}

async function main() {
  const db = getDb();
  const [run] = await db.select().from(grounnelRuns).where(eq(grounnelRuns.runId, runId));
  if (!run) {
    console.log(JSON.stringify({ found: false }));
    return;
  }
  const claims = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, runId));
  console.log(JSON.stringify({
    found: true,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    score: run.score,
    claimCount: claims.length,
    claims: claims.map(c => ({ id: c.claimId, text: c.claimText, verdict: c.verdict, reason: c.reason, status: c.status })),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
