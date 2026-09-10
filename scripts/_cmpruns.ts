import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const target = process.argv[2]!;
const t = await q(sql`SELECT run_id, length(text) len, left(text,40) head FROM grounnel.grounnel_runs WHERE run_id::text LIKE ${target+"%"}`);
if (!t.length) { console.log("run not found"); process.exit(1); }
console.log(`target ${target}  len=${t[0].len}  "${t[0].head}..."`);
const runs = await q(sql`SELECT run_id, created_at, status FROM grounnel.grounnel_runs
  WHERE length(text) = ${t[0].len} AND left(text,40) = ${t[0].head} ORDER BY created_at`);
console.log(`\nruns of this exact text: ${runs.length}\n`);
console.log("run       when         status  claims  contra  supp  unsup  excl  unver  span");
console.log("-".repeat(82));
for (const r of runs) {
  const v = await q(sql`SELECT verdict, count(*) c FROM grounnel.grounnel_claims WHERE run_id = ${r.run_id} GROUP BY 1`);
  const m: any = Object.fromEntries(v.map((x: any) => [x.verdict, Number(x.c)]));
  const tot = Object.values(m).reduce((a: any, b: any) => a + b, 0);
  const w = await q(sql`SELECT extract(epoch from (max(created_at) - ${r.created_at}::timestamptz))::int s
    FROM grounnel.grounnel_claims WHERE run_id = ${r.run_id}`);
  console.log(`${String(r.run_id).slice(0,8)}  ${new Date(r.created_at).toISOString().slice(5,16).replace("T"," ")}  ${String(r.status).padEnd(7)} ${String(tot).padEnd(7)} ${String(m.contradicted??0).padEnd(7)} ${String(m.supported??0).padEnd(5)} ${String(m.unsupported??0).padEnd(6)} ${String(m.excluded??0).padEnd(5)} ${String(m.unverifiable??0).padEnd(6)} ${w[0]?.s ?? "?"}s`);
}
process.exit(0);
