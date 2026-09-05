import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
async function main(){
  const db=getDb(); const q=async(s:any)=>{const r=(await db.execute(s)) as any; return Array.isArray(r)?r:r.rows;};
  const r=await q(sql`
    SELECT l.input_payload AS p FROM grounnel.grounnel_runs r
    JOIN grounnel.grounnel_llm_calls l ON l.run_id=r.run_id
    WHERE r.source='eval' AND r.text LIKE 'On December 17, 1903%'
      AND l.stage='verify' AND l.input_payload IS NOT NULL
      AND l.created_at > '2026-09-04 12:18:00+00'::timestamptz
    ORDER BY l.created_at DESC LIMIT 1`);
  console.log(JSON.stringify(r[0].p, null, 1).slice(0, 2200));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
