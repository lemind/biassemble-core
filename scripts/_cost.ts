import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb();
  const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const r=await q(sql`
    WITH w AS (SELECT run_id FROM grounnel.grounnel_runs
               WHERE source='eval' AND text NOT LIKE '[%'
                 AND created_at > '2026-09-04 12:50:00+00'::timestamptz)
    SELECT (SELECT count(*) FROM w) AS case_runs, count(*) AS llm_calls,
           sum(l.input_tokens) AS in_tok, sum(l.output_tokens) AS out_tok
    FROM grounnel.grounnel_llm_calls l WHERE l.run_id IN (SELECT run_id FROM w)`);
  const x=r[0]; const runs=Number(x.case_runs), calls=Number(x.llm_calls); const per=calls/runs;
  console.log(`case-runs ${runs} | llm calls ${calls} | ${per.toFixed(1)} calls per case-run`);
  console.log(`tokens in ${Number(x.in_tok).toLocaleString()} / out ${Number(x.out_tok).toLocaleString()}`);
  const f=(n:number)=>`${n} runs = ${Math.round(n*per)} calls`;
  console.log(`\nscreen only (28)      ${f(28)}`);
  console.log(`+1 escalated          ${f(33)}`);
  console.log(`+3 escalated          ${f(43)}`);
  console.log(`worst (all 28 esc)    ${f(168)}`);
  console.log(`today's N=5 pass      ${f(140)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
