import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const runs = await q(sql`SELECT count(*) n, min(created_at) first, max(created_at) last
  FROM grounnel.grounnel_runs WHERE source='production' AND status='done'`);
const claims = await q(sql`SELECT count(*) n FROM grounnel.grounnel_claims c
  JOIN grounnel.grounnel_runs r ON r.run_id=c.run_id WHERE r.source='production' AND r.status='done'`);
const verdicts = await q(sql`SELECT c.verdict, count(*) n FROM grounnel.grounnel_claims c
  JOIN grounnel.grounnel_runs r ON r.run_id=c.run_id WHERE r.source='production' AND r.status='done'
  GROUP BY 1 ORDER BY 2 DESC`);
const src = await q(sql`SELECT count(*) n FROM grounnel.grounnel_search_calls s
  JOIN grounnel.grounnel_runs r ON r.run_id=s.run_id WHERE r.source='production' AND s.status='ok'`);
console.log("runs   ", runs[0].n, " window", String(runs[0].first).slice(0,10), "->", String(runs[0].last).slice(0,10));
console.log("claims ", claims[0].n);
console.log("sources fetched ok", src[0].n);
console.log("verdicts:"); for (const v of verdicts) console.log(`   ${String(v.verdict).padEnd(22)} ${v.n}`);
process.exit(0);
