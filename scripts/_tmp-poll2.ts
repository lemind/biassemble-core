import { getDb } from "../src/db/config";
import { grounnelRuns, grounnelClaims } from "../src/db/schema";
import { eq } from "drizzle-orm";
const runId = process.argv[2]!;
async function main() {
  const db = getDb();
  const [run] = await db.select().from(grounnelRuns).where(eq(grounnelRuns.runId, runId));
  const claims = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, runId));
  console.log(JSON.stringify({ status: run?.status, n: claims.length,
    claims: claims.map(c => ({ text: c.claimText, verdict: c.verdict, reason: c.reason })) }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
