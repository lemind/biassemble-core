import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb(); const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const rows=await q(sql`
    SELECT l.prompt_version AS variant,
           l.parsed_output->'results'->0->>'id' AS fixture,
           l.parsed_output->'results'->0->>'verdict' AS verdict,
           count(*) AS n
    FROM grounnel.grounnel_llm_calls l
    WHERE l.prompt_version LIKE 'neg-%' AND l.created_at > now() - interval '40 minutes'
      AND l.status='success'
    GROUP BY 1,2,3 ORDER BY 1,2`);
  const EXP:Record<string,string>={ "w1-false-ordinal":"contradicted","w2-false-ordinal":"contradicted",
                                    "w1-true-ordinal":"supported","w2-true-ordinal":"supported" };
  const byV=new Map<string,any[]>();
  for(const r of rows){ const v=String(r.variant).replace(/^neg-/,""); if(!byV.has(v)) byV.set(v,[]); byV.get(v)!.push(r); }
  for(const [v,rs] of byV){
    console.log(`\n### ${v}`);
    const t=rs.map((r:any)=>({fixture:r.fixture, expect:EXP[r.fixture]??"?", got:r.verdict, n:r.n,
      ok: r.verdict===EXP[r.fixture] ? "OK" : (String(r.fixture).includes("true") && r.verdict==="contradicted" ? "*** FALSE ACCUSATION ***" : "miss")}));
    console.table(t);
  }
  console.log(`\ntotal calls: ${rows.reduce((s:number,r:any)=>s+Number(r.n),0)}/36`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
