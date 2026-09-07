// Spec 017 T013 — screen EXTRACT's subject_entities BEFORE wiring T014-T016. Junk second entities
// pull wrong pages, which is worse than no change. Zero API, read-only.
// Usage: pnpm exec tsx --env-file=.env scripts/s017-t013-extract-screen.ts <run-id-prefix>
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";

const db = getDb();
const q = async (s: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
  const r = (await db.execute(s)) as unknown;
  return Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);
};

const prefix = process.argv[2];
if (!prefix) { console.error("usage: s017-t013-extract-screen.ts <run-id-prefix>"); process.exit(2); }

const rows = await q(sql`
  SELECT parsed_output FROM grounnel.grounnel_llm_calls
  WHERE run_id::text LIKE ${prefix + "%"} AND stage = 'extract' AND status = 'success'
  ORDER BY created_at`);

let total = 0, multi = 0;
const listed: Array<{ claim: string; se: string; ses: string[] }> = [];
for (const r of rows) {
  const po = r.parsed_output as { claims?: Array<{ claim: string; subject_entity?: string; subject_entities?: unknown }> } | null;
  for (const c of po?.claims ?? []) {
    total++;
    const ses = Array.isArray(c.subject_entities) ? c.subject_entities.filter((x): x is string => typeof x === "string") : [];
    if (ses.length >= 2) { multi++; listed.push({ claim: c.claim, se: c.subject_entity ?? "", ses }); }
  }
}

console.log(`run:                    ${prefix}`);
console.log(`extract calls:          ${rows.length}`);
console.log(`claims emitted:         ${total}`);
console.log(`claims w/ >=2 entities: ${multi}  (${total ? ((100 * multi) / total).toFixed(1) : "0"}%)`);
console.log(`\nplan expected ~4-6 of 44 (~10%). Far above => EXTRACT is over-splitting; far below => inert.\n`);
for (const l of listed) {
  const firstMatches = l.ses[0]?.toLowerCase() === l.se.toLowerCase();
  console.log(`  [${l.ses.length}] ${l.ses.join("  |  ")}${firstMatches ? "" : `   <-- head != subject_entity ("${l.se}")`}`);
  console.log(`      ${l.claim.slice(0, 110)}`);
}
process.exit(0);
