import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb();
  const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const r=await q(sql`
    WITH w AS (SELECT run_id FROM grounnel.grounnel_runs
               WHERE source='eval' AND text NOT LIKE '[%'
                 AND created_at > '2026-09-04 15:10:00+00'::timestamptz)
    SELECT (SELECT count(*) FROM w) AS case_runs, count(*) AS calls,
           coalesce(sum(l.input_tokens),0) AS in_tok
    FROM grounnel.grounnel_llm_calls l WHERE l.run_id IN (SELECT run_id FROM w)`);
  const x=r[0];
  console.log(`spent: ${x.case_runs} case-runs, ${x.calls} calls, ${Number(x.in_tok).toLocaleString()} input tokens`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
