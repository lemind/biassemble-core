import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb(); const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const rows=await q(sql`
    SELECT l.input_payload AS p FROM grounnel.grounnel_runs r
    JOIN grounnel.grounnel_llm_calls l ON l.run_id=r.run_id
    WHERE r.source='eval' AND r.text LIKE 'On December 17, 1903%'
      AND l.stage='verify' AND l.input_payload IS NOT NULL
      AND l.created_at > '2026-09-04 12:18:00+00'::timestamptz
    ORDER BY l.created_at DESC LIMIT 40`);
  const seen=new Set<string>(); const out:any[]=[];
  for(const row of rows){
    const p:any=row.p;
    const pairs=Array.isArray(p)?p:(p?.pairs??p?.claim_passage_pairs??[]);
    const ps=(Array.isArray(pairs)?pairs[0]:pairs)?.passage_sentences;
    if(!ps) continue;
    const k=JSON.stringify(ps).slice(0,400); if(seen.has(k)) continue; seen.add(k);
    out.push(ps); if(out.length===2) break;
  }
  for(const [i,ps] of out.entries()){
    console.log(`\n===== w${i+1}  (${Object.keys(ps).length} sources, ${Object.values(ps as any).flat().length} sentences) =====`);
    for(const [label,sents] of Object.entries(ps as Record<string,any[]>)){
      for(const s of sents){ if(String(s.text).includes("852")) console.log(`  ${label}${s.n}: ${String(s.text).slice(0,120)}`); }
    }
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
