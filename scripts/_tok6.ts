import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const id = '70d3d2fc-302a-45a9-883a-01b28491673a';
console.log("claims with >=1 SELECTED passage:", await q(sql`SELECT count(DISTINCT claim_id) n FROM grounnel.grounnel_rerank_decisions WHERE run_id=${id}::uuid AND selected`));
console.log("claims with 0 selected:", await q(sql`SELECT count(*) n FROM (
  SELECT claim_id FROM grounnel.grounnel_rerank_decisions WHERE run_id=${id}::uuid GROUP BY 1 HAVING bool_or(selected) IS NOT TRUE) t`));
console.log("last rerank decision at:", await q(sql`SELECT max(created_at) FROM grounnel.grounnel_rerank_decisions WHERE run_id=${id}::uuid`));
console.log("run completed_at:", await q(sql`SELECT completed_at FROM grounnel.grounnel_runs WHERE run_id=${id}::uuid`));
process.exit(0);
