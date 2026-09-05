import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb(); const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const rows=await q(sql`
    SELECT l.prompt_version AS pv,
           l.parsed_output->'results'->0->>'attribution' AS ans,
           count(*) AS n
    FROM grounnel.grounnel_llm_calls l
    WHERE l.prompt_version LIKE 'prompt-control-d-%' AND l.created_at > now() - interval '20 minutes'
      AND l.status='success'
    GROUP BY 1,2 ORDER BY 1`);
  console.table(rows.map((r:any)=>({fixture:String(r.pv).replace("prompt-control-",""), answer:r.ans, n:r.n})));
  console.log(`calls: ${rows.reduce((s:number,r:any)=>s+Number(r.n),0)}/6`);
  const w=await q(sql`
    SELECT l.prompt_version AS pv, l.parsed_output->'results'->0->>'working' AS working
    FROM grounnel.grounnel_llm_calls l
    WHERE l.prompt_version='prompt-control-d-without-distractor'
      AND l.created_at > now() - interval '20 minutes' AND l.status='success' LIMIT 1`);
  if(w[0]) { console.log("\n--- reasoning WITHOUT the distractor ---"); console.log(String(w[0].working).slice(0,900)); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
