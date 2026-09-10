import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const [x] = await q(sql`SELECT coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o, count(*) n
  FROM grounnel.grounnel_llm_calls WHERE run_id='70d3d2fc-302a-45a9-883a-01b28491673a'::uuid`);
const cost = Number(x.i)/1e6*0.10 + Number(x.o)/1e6*0.40;
console.log(`${x.n} LLM calls, ${x.i} in + ${x.o} out tokens, $${cost.toFixed(4)} spent for zero verdicts`);
process.exit(0);
