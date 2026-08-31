import { getDb } from "../src/db/config";
import { grounnelClaims } from "../src/db/schema";
import { eq } from "drizzle-orm";
async function main() {
  const db = getDb();
  const rows = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, "55e13495-0ff7-4a0c-a203-af23546b5848"));
  for (const c of rows) if (c.verdict === "excluded") console.log(c.claimText.slice(0,50), "=>", c.reason);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
