import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const [c] = await q(sql`SELECT count(*)::int n, count(*) FILTER (WHERE share_token LIKE 'legacy_%')::int legacy,
  count(DISTINCT share_token)::int distinct_tokens, count(*) FILTER (WHERE share_token IS NULL)::int nulls
  FROM grounnel.grounnel_runs`);
console.log(c);
const [old] = await q(sql`SELECT share_token, created_at::date d, status FROM grounnel.grounnel_runs
  WHERE source='production' AND status='done' AND created_at < now() - interval '7 days'
  ORDER BY created_at LIMIT 1`);
console.log("oldest production run token:", old?.share_token, String(old?.d));
process.exit(0);
