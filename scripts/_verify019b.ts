import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const r = await q(sql`SELECT run_id, share_token, status, (SELECT count(*) FROM grounnel.grounnel_claims c WHERE c.run_id=g.run_id) claims
  FROM grounnel.grounnel_runs g WHERE run_id IN ('bb62670f-1f82-49d4-8316-1c1265f5ddc1','2a701ffa-36ca-4d3e-a617-b179a18ee705')`);
for (const x of r) console.log(`${x.run_id} ${x.share_token} ${x.status} ${x.claims}cl`);
process.exit(0);
