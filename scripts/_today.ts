import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { evaluateGrounnelRun } from "../src/evaluation/grounnel-live-gate";
const norm=(s:string)=>s.toLowerCase().replace(/\s+/g," ").trim();
async function main(){
  const golden:any=JSON.parse(readFileSync("evaluations/golden/grounnel/live-eval-golden-set.json","utf8"));
  const db=getDb();
  const raw:any=await db.execute(sql`
    SELECT r.run_id::text AS id, r.text,
      coalesce(json_agg(json_build_object('text',c.claim_text,'verdict',c.verdict))
               FILTER (WHERE c.claim_id IS NOT NULL),'[]'::json) AS claims
    FROM grounnel.grounnel_runs r LEFT JOIN grounnel.grounnel_claims c ON c.run_id=r.run_id
    WHERE r.source='eval' AND r.text NOT LIKE '[%'
      AND r.created_at BETWEEN '2026-09-04 12:50:00+00' AND '2026-09-04 13:30:00+00'
    GROUP BY 1,2`);
  const runs=Array.isArray(raw)?raw:raw.rows;
  const bad:any[]=[];
  for(const gc of golden.cases){
    const reps=runs.filter((r:any)=>norm(String(r.text))===norm(gc.text));
    if(!reps.length) continue;
    const res:any=evaluateGrounnelRun(reps.map((r:any)=>({id:String(r.id),claims:r.claims})),
      {id:gc.id,claims:gc.claims,minCorrectRate:gc.minCorrectRate,detectionFloor:gc.detectionFloor} as any);
    const rate=res.matched?res.correct/res.matched:0;
    if(rate < 1.0) bad.push({case:gc.id,N:res.runs,correct:`${res.correct}/${res.matched}`,rate:rate.toFixed(2),reportedOk:res.ok});
  }
  console.log(`cases whose correct-rate was BELOW minCorrectRate 1.0 in today's N=5 pass:`);
  if(bad.length) console.table(bad); else console.log("  none");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
