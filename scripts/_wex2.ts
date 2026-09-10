import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const r = await q(sql`SELECT c.status, count(*) n, count(*) FILTER (WHERE jsonb_array_length(sources)>0) with_src
  FROM grounnel.grounnel_claims c JOIN grounnel.grounnel_runs r USING(run_id)
  WHERE c.verdict IS NULL AND r.source='production' GROUP BY c.status`);
console.log(r);
process.exit(0);
