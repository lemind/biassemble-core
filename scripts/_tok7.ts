import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const id = '70d3d2fc-302a-45a9-883a-01b28491673a';
console.log("llm calls by type:", await q(sql`SELECT stage, call_type, count(*) n,
  to_char(min(started_at),'HH24:MI:SS') first, to_char(max(ended_at),'HH24:MI:SS') last
  FROM grounnel.grounnel_llm_calls WHERE run_id=${id}::uuid GROUP BY 1,2 ORDER BY 4`));
console.log("search calls:", await q(sql`SELECT to_char(min(created_at),'HH24:MI:SS') first, to_char(max(created_at),'HH24:MI:SS') last, count(*) n FROM grounnel.grounnel_search_calls WHERE run_id=${id}::uuid`));
console.log("pages:", await q(sql`SELECT to_char(min(created_at),'HH24:MI:SS') first, to_char(max(created_at),'HH24:MI:SS') last FROM grounnel.grounnel_search_pages WHERE run_id=${id}::uuid`));
console.log("claims written:", await q(sql`SELECT to_char(min(created_at),'HH24:MI:SS') first, to_char(max(created_at),'HH24:MI:SS') last, count(*) n FROM grounnel.grounnel_claims WHERE run_id=${id}::uuid`));
console.log("run:", await q(sql`SELECT to_char(created_at,'HH24:MI:SS') created, to_char(completed_at,'HH24:MI:SS') completed, status FROM grounnel.grounnel_runs WHERE run_id=${id}::uuid`));
process.exit(0);
