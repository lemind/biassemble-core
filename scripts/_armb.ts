import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb(); const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const rows=await q(sql`
    SELECT l.prompt_version AS pv,
           l.parsed_output->'results'->0->>'attribution' AS ans,
           count(*) AS n
    FROM grounnel.grounnel_llm_calls l
    WHERE l.prompt_version LIKE 'prompt-%' AND l.created_at > now() - interval '25 minutes'
      AND l.status='success'
    GROUP BY 1,2 ORDER BY 1`);
  const EXP:Record<string,string>={ "w1-false-ordinal":"different","w2-false-ordinal":"different",
                                    "t-w1-true-ordinal":"same","t-w2-true-ordinal":"same" };
  const byV=new Map<string,any[]>();
  for(const r of rows){
    const m=String(r.pv).match(/^prompt-(control|member-comparison)-(.+)$/); if(!m) continue;
    const [,v,fx]=m; if(!byV.has(v!)) byV.set(v!,[]);
    byV.get(v!)!.push({fixture:fx, expect:EXP[fx!]??"?", got:r.ans, n:r.n,
      ok: r.ans===EXP[fx!] ? "OK" : (String(fx).startsWith("t-") && r.ans==="different" ? "*** FALSE ACCUSATION ***" : "miss")});
  }
  for(const [v,t] of byV){ console.log(`\n### ${v}`); console.table(t); }
  console.log(`\ntotal calls: ${rows.reduce((s:number,r:any)=>s+Number(r.n),0)}/24`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
