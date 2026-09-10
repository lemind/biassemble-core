import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const id = '70d3d2fc-302a-45a9-883a-01b28491673a';
console.log("pages:", await q(sql`SELECT count(*) n, count(DISTINCT url) urls, sum(length(excerpt)) total_chars, max(length(excerpt)) max_chars, avg(length(excerpt))::int avg_chars FROM grounnel.grounnel_search_pages WHERE run_id=${id}::uuid`));
console.log("claims w/ pages:", await q(sql`SELECT count(DISTINCT claim_id) n FROM grounnel.grounnel_search_pages WHERE run_id=${id}::uuid`));
console.log("search bytes:", await q(sql`SELECT sum(length(coalesce(url,''))) u, count(*) n FROM grounnel.grounnel_search_calls WHERE run_id=${id}::uuid`));
// How this run compares with every other production run.
console.log("\n-- this run vs others (claims extracted) --");
console.log(await q(sql`SELECT r.run_id, r.status, length(r.text) chars,
  (SELECT count(*) FROM grounnel.grounnel_llm_calls l WHERE l.run_id=r.run_id AND l.call_type='eligibility_check') claims_checked,
  (SELECT count(*) FROM grounnel.grounnel_search_pages p WHERE p.run_id=r.run_id) pages
  FROM grounnel.grounnel_runs r WHERE r.source='production' AND r.created_at > now() - interval '3 days' ORDER BY r.created_at DESC LIMIT 8`));
process.exit(0);
