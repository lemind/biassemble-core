import { getDb } from "../src/db/config";
import { grounnelLlmCalls } from "../src/db/schema";
import { eq, desc } from "drizzle-orm";
async function main() {
  const db = getDb();
  const rows = await db.select({ t: grounnelLlmCalls.callType, s: grounnelLlmCalls.status, c: grounnelLlmCalls.createdAt, f: grounnelLlmCalls.failureType })
    .from(grounnelLlmCalls).orderBy(desc(grounnelLlmCalls.createdAt)).limit(12);
  for (const r of rows) console.log(JSON.stringify(r));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
