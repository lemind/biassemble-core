import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const id = '70d3d2fc-302a-45a9-883a-01b28491673a';
console.log("--- llm calls timeline ---");
for (const r of await q(sql`SELECT stage, call_type, status, duration_ms, input_tokens, output_tokens,
  to_char(started_at,'HH24:MI:SS') st, to_char(ended_at,'HH24:MI:SS') en, left(coalesce(error_message,''),120) err
  FROM grounnel.grounnel_llm_calls WHERE run_id=${id}::uuid ORDER BY started_at`))
  console.log(`${r.st}->${r.en} ${String(r.stage).padEnd(7)} ${String(r.call_type).padEnd(18)} ${r.status} ${String(r.duration_ms).padStart(6)}ms in=${r.input_tokens} out=${r.output_tokens} ${r.err}`);
console.log("--- search calls ---");
for (const r of await q(sql`SELECT call_type, status, count(*) n FROM grounnel.grounnel_search_calls WHERE run_id=${id}::uuid GROUP BY 1,2`)) console.log(r);
console.log("--- gate events ---");
for (const r of await q(sql`SELECT reason, count(*) n FROM grounnel.grounnel_gate_events WHERE run_id=${id}::uuid GROUP BY 1 ORDER BY 2 DESC`)) console.log(r);
process.exit(0);
