import { getDb } from "../src/db/config";
import { grounnelClaims } from "../src/db/schema";
import { eq, and } from "drizzle-orm";
async function main() {
  const db = getDb();
  for (const [label, runId] of [["Aug30", "a2d4e3b2-fed6-4796-875b-ae42ade713fb"], ["Aug31", "55e13495-0ff7-4a0c-a203-af23546b5848"]] as const) {
    const rows = await db.select().from(grounnelClaims).where(eq(grounnelClaims.runId, runId));
    for (const c of rows) {
      if (/Germany surrendered|really did fly 852|first flight covered approximately 120/.test(c.claimText)) {
        console.log(`--- ${label} | ${c.verdict} | ${c.claimText}`);
        console.log(`    evidence: ${JSON.stringify(c.evidence)}`);
      }
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
