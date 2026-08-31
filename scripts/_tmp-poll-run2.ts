import { getDb } from "../src/db/config";
import { grounnelClaims } from "../src/db/schema";
import { eq } from "drizzle-orm";

const runId = process.argv[2];
async function main() {
  const db = getDb();
  const claims = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, runId));
  for (const c of claims) {
    const sources = c.sources as any;
    console.log(JSON.stringify({ text: c.claimText, verdict: c.verdict, sourcesLen: Array.isArray(sources) ? sources.length : null, sources }));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
