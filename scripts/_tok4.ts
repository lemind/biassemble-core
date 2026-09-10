import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
console.log("-- production runs by status --");
console.log(await q(sql`SELECT status, count(*) n, min(created_at)::date first, max(created_at)::date last FROM grounnel.grounnel_runs WHERE source='production' GROUP BY 1 ORDER BY 2 DESC`));
console.log("\n-- every failed production run --");
for (const r of await q(sql`SELECT run_id, to_char(created_at,'MM-DD HH24:MI') t,
  extract(epoch from (completed_at-created_at))::int secs, length(text) chars,
  prompt_version_extract pe, prompt_version_verify pv,
  (SELECT count(*) FROM grounnel.grounnel_llm_calls l WHERE l.run_id=r.run_id AND l.stage='verify' AND l.call_type='primary') verify_calls,
  (SELECT count(*) FROM grounnel.grounnel_claims c WHERE c.run_id=r.run_id) claims_written,
  (SELECT count(*) FROM grounnel.grounnel_llm_calls l WHERE l.run_id=r.run_id AND l.call_type='eligibility_check') elig
  FROM grounnel.grounnel_runs r WHERE source='production' AND status='failed' ORDER BY created_at DESC LIMIT 15`))
  console.log(`${r.t} ${String(r.secs).padStart(4)}s ${String(r.chars).padStart(6)}ch elig=${String(r.elig).padStart(3)} verify=${r.verify_calls} written=${r.claims_written} ${r.pe}/${r.pv} ${r.run_id}`);
process.exit(0);
