import { getDb } from "../src/db/config";
import { grounnelRuns, grounnelLlmCalls } from "../src/db/schema";
import { sql, eq, and, desc } from "drizzle-orm";
async function main() {
  const db = getDb();
  const [run] = await db.select().from(grounnelRuns)
    .where(sql`${grounnelRuns.text} LIKE '[t27-referent-screen]%'`)
    .orderBy(desc(grounnelRuns.createdAt)).limit(1);
  if (!run) { console.log(JSON.stringify({ found: false })); return; }
  const calls = await db.select({ parsed: grounnelLlmCalls.parsedOutput, status: grounnelLlmCalls.status })
    .from(grounnelLlmCalls)
    .where(and(eq(grounnelLlmCalls.runId, run.runId), eq(grounnelLlmCalls.callType, "eligibility_check")));
  console.log(JSON.stringify({ found: true, runId: run.runId, createdAt: run.createdAt, callCount: calls.length,
    calls: calls.map(c => ({ status: c.status, parsed: c.parsed })) }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
