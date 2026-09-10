import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const runs = await q(sql`SELECT c.claim_id, c.verdict, c.created_at FROM grounnel.grounnel_claims c
  WHERE c.claim_text ILIKE '%first computer mouse was wireless%'
    AND c.created_at > '2026-09-07 17:00'::timestamptz ORDER BY c.created_at`);
for (const r of runs) {
  const pages = await q(sql`SELECT url, llm_score, selected FROM grounnel.grounnel_rerank_decisions
    WHERE claim_id = ${r.claim_id} ORDER BY combined_score DESC`);
  const shown = pages.filter((p: any) => p.selected);
  console.log(`\n[${String(r.verdict).toUpperCase()}] ${new Date(r.created_at).toISOString().slice(11,19)} VERIFY read ${shown.length}/${pages.length}`);
  for (const p of shown) console.log(`   llm=${String(p.llm_score).padStart(3)}  ${String(p.url).slice(0,72)}`);
}
process.exit(0);
