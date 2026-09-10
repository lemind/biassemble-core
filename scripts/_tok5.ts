import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const id = '70d3d2fc-302a-45a9-883a-01b28491673a';
console.log("rerank decision cols:", (await q(sql`SELECT column_name FROM information_schema.columns WHERE table_schema='grounnel' AND table_name='grounnel_rerank_decisions'`)).map((r:any)=>r.column_name).join(', '));
console.log("\ndecisions:", await q(sql`SELECT count(*) n, count(DISTINCT claim_id) claims FROM grounnel.grounnel_rerank_decisions WHERE run_id=${id}::uuid`));
console.log("\nper claim kept:", await q(sql`SELECT kept, count(*) n FROM (
  SELECT claim_id, bool_or(true) kept FROM grounnel.grounnel_rerank_decisions WHERE run_id=${id}::uuid GROUP BY 1) t GROUP BY 1`));
process.exit(0);
