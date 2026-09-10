import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const r = await q(sql`WITH runs AS (
  SELECT r.run_id, length(r.text) chars,
    (SELECT count(*) FROM grounnel.grounnel_claims c WHERE c.run_id=r.run_id) claims,
    (SELECT count(*) FROM grounnel.grounnel_claims c WHERE c.run_id=r.run_id AND c.verdict='contradicted') contra,
    (SELECT coalesce(sum(l.input_tokens),0) FROM grounnel.grounnel_llm_calls l WHERE l.run_id=r.run_id) inp,
    (SELECT coalesce(sum(l.output_tokens),0) FROM grounnel.grounnel_llm_calls l WHERE l.run_id=r.run_id) outp,
    extract(epoch from (r.completed_at - r.created_at))::int secs
  FROM grounnel.grounnel_runs r
  WHERE r.source='production' AND r.status='done' AND r.completed_at IS NOT NULL)
SELECT count(*) n, sum(claims) claims, sum(contra) contra, sum(inp) inp, sum(outp) outp,
  avg(claims)::numeric(10,1) claims_per_run, avg(chars)::int chars_per_run, avg(secs)::int secs_per_run
FROM runs WHERE claims > 0`);
const x = r[0];
const cost = Number(x.inp)/1e6*0.10 + Number(x.outp)/1e6*0.40;
const tok = Number(x.inp)+Number(x.outp);
console.log(`runs                  ${x.n}`);
console.log(`claims/article        ${x.claims_per_run}   (avg ${x.chars_per_run} chars, ${x.secs_per_run}s)`);
console.log(`tokens/claim          ${Math.round(tok/Number(x.claims))}`);
console.log(`tokens/contradiction  ${Math.round(tok/Number(x.contra))}   (${x.contra} contradictions)`);
console.log(`cost/claim            $${(cost/Number(x.claims)).toFixed(5)}`);
console.log(`cost/contradiction    $${(cost/Number(x.contra)).toFixed(4)}`);
console.log(`total                 ${x.claims} claims, ${tok} tokens, $${cost.toFixed(2)}`);
process.exit(0);
