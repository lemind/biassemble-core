import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const get = async (p: string) => new Map((await q(sql`SELECT claim_text, verdict FROM grounnel.grounnel_claims
  WHERE run_id::text LIKE ${p+"%"}`)).map((r: any) => [String(r.claim_text), String(r.verdict)]));
const [a, b] = [await get(process.argv[2]!), await get(process.argv[3]!)];
const planted = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) === "contradicted" || b.get(k) === "contradicted"));
console.log(`${process.argv[2]} vs ${process.argv[3]}\n`);
console.log("claim".padEnd(62) + process.argv[2]!.padEnd(16) + process.argv[3]);
console.log("-".repeat(96));
for (const k of planted.sort()) {
  const x = a.get(k) ?? "-", y = b.get(k) ?? "-";
  console.log(k.slice(0, 60).padEnd(62) + x.padEnd(16) + y + (x !== y ? "   <-- DIFFERS" : ""));
}
process.exit(0);
