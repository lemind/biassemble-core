import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
// Deploy times are UTC here (the CLI reported them in MSK, +3).
const B = [
  { name: "before today", from: "2026-08-01", to: "2026-09-07 14:31" },
  { name: "8e91d45  window=3 + T017", from: "2026-09-07 14:31", to: "2026-09-07 17:21" },
  { name: "eb96789  whole pool + filter", from: "2026-09-07 17:21", to: "2026-09-07 18:03" },
  { name: "a95cc2d  whole pool, no filter", from: "2026-09-07 18:03", to: "2026-09-08" },
];
console.log("build".padEnd(32) + "n".padEnd(5) + "detect".padEnd(8) + "rate".padEnd(8) + "verdicts");
console.log("-".repeat(96));
for (const b of B) {
  const r = await q(sql`SELECT verdict, count(*) c FROM grounnel.grounnel_claims
    WHERE claim_text ILIKE '%first computer mouse was wireless%'
      AND created_at >= ${b.from}::timestamptz AND created_at < ${b.to}::timestamptz GROUP BY 1`);
  const tot = r.reduce((a: number, x: any) => a + Number(x.c), 0);
  if (!tot) { console.log(b.name.padEnd(32) + "0"); continue; }
  const hit = Number(r.find((x: any) => x.verdict === "contradicted")?.c ?? 0);
  console.log(b.name.padEnd(32) + String(tot).padEnd(5) + String(hit).padEnd(8) + `${((100*hit)/tot).toFixed(0)}%`.padEnd(8)
    + JSON.stringify(Object.fromEntries(r.map((x: any) => [x.verdict, Number(x.c)]))));
}
process.exit(0);
