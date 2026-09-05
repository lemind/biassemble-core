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
    ORDER BY l.created_at DESC LIMIT 6`);
  const JUNK=/^(skip to|join|sign in|log in|menu|search|subscribe|newsletter|cookie|advertisement|share|follow us|home$|\W*$)|^\W{0,3}\d+\s*(premium|active|k\+)/i;
  for(const [i,r] of rows.entries()){
    const p:any=r.p;
    const pairs = Array.isArray(p) ? p : (p?.pairs ?? p?.claim_passage_pairs ?? []);
    const pair = Array.isArray(pairs) ? pairs[0] : pairs;
    const ps = pair?.passage_sentences ?? pair?.passages ?? {};
    let tot=0, junk=0; const hits:string[]=[];
    for(const [label, sents] of Object.entries(ps as Record<string, any[]>)){
      for(const s of sents){ tot++;
        const t=String(s.text ?? s);
        if(t.length<25 || JUNK.test(t.trim())) junk++;
        if(t.includes("852")) hits.push(`${label}${s.n}: ${t.slice(0,95)}`);
      }
    }
    console.log(`payload ${i+1}: sources=${Object.keys(ps).length} sentences=${tot} junk-ish=${junk} (${Math.round(junk/tot*100)}%)`);
    for(const h of hits) console.log(`    852 -> ${h}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
