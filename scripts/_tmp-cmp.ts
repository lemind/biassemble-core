import { getDb } from "../src/db/config";
import { grounnelClaims } from "../src/db/schema";
import { eq } from "drizzle-orm";
async function main() {
  const db = getDb();
  const prev = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, "55e13495-0ff7-4a0c-a203-af23546b5848"));
  const cur = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, "a24fa8ea-1a18-49ef-a758-aa177e41de33"));
  const p = new Map(prev.map(c => [c.claimText, c.verdict]));
  for (const c of cur) {
    const before = p.get(c.claimText);
    if (before !== c.verdict) console.log(JSON.stringify({ text: c.claimText, before: before ?? "(new)", after: c.verdict }));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
