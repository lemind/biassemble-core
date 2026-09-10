import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const tok = process.argv[2];
const [run] = await q(sql`SELECT run_id, status, source, session_id, length(text) chars, max_claims, truncated,
  prompt_version_extract pe, prompt_version_verify pv, created_at, completed_at, score, left(text,160) preview
  FROM grounnel.grounnel_runs WHERE share_token=${tok}`);
if (!run) { console.log("NO RUN for token", tok); process.exit(0); }
console.log(run);
const cl = await q(sql`SELECT status, verdict, count(*) n FROM grounnel.grounnel_claims WHERE run_id=${run.run_id}::uuid GROUP BY 1,2 ORDER BY 3 DESC`);
console.log("claims:", cl);
const llm = await q(sql`SELECT stage, call_type, status, failure_type, count(*) n, max(left(error_message,160)) err
  FROM grounnel.grounnel_llm_calls WHERE run_id=${run.run_id}::uuid GROUP BY 1,2,3,4 ORDER BY 5 DESC`);
console.log("llm calls:", llm);
process.exit(0);
