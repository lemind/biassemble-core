import { getDb } from "../src/db/config";
import { grounnelRuns } from "../src/db/schema";
import { eq } from "drizzle-orm";
async function main() {
  const db = getDb();
  const [r] = await db.select({ text: grounnelRuns.text }).from(grounnelRuns)
    .where(eq(grounnelRuns.runId, "55e13495-0ff7-4a0c-a203-af23546b5848"));
  process.stdout.write(r?.text ?? "");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
