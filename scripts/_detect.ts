import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
// The 9 planted falsehoods in "The Long Weekend That Changed Everything".
const PLANTED = ["Amazon began by selling electronics","Apollo 11 landed on Mars","Apple was founded by Bill Gates",
  "CSS was invented before the Internet","Galileo invented the telescope","JavaScript was created in 1999",
  "Eiffel Tower was originally constructed in London","first computer mouse was wireless","Roman Empire began in Greece"];
const runs = ["c94d2954","7c28d45b","6760307f","f603014b","b36be9ab","db91384b","6d48ebdb","bb62670f","054d3b23"];
console.log("run       build            detected/9   miss");
console.log("-".repeat(84));
for (const p of runs) {
  const rows = await q(sql`SELECT claim_text, verdict FROM grounnel.grounnel_claims WHERE run_id::text LIKE ${p+"%"}`);
  const hit: string[] = [], miss: string[] = [];
  for (const k of PLANTED) {
    const m = rows.find((r: any) => String(r.claim_text).includes(k));
    (m && m.verdict === "contradicted" ? hit : miss).push(k.split(" ").slice(0,3).join(" "));
  }
  const build = p === "c94d2954" ? "aug baseline" : ["6d48ebdb","bb62670f","054d3b23"].includes(p) ? "AFTER T017" : "before T017";
  console.log(`${p}  ${build.padEnd(16)} ${String(hit.length).padStart(2)}/9        ${miss.join(", ") || "-"}`);
}
process.exit(0);
