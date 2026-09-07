// Spec 017 T027 — does a later escalation tier create or destroy more contradictions?
// The pre-union census (716 / 163 / 10) is what refused a blanket contradiction freeze; the pool
// union changed what a later tier sees, so the number has to be re-taken. Read-only.
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";

// N1 (b36be9ab) ran at 11:25Z on the union build; nothing between it and the deploy.
const UNION_CUTOFF = "2026-09-07 11:20:00+00";

async function main(): Promise<void> {
  const db = getDb();
  const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
  for (const [label, where] of [
    ["PRE-union  (all history)", sql`ge.created_at < ${UNION_CUTOFF}`],
    ["POST-union (this build) ", sql`ge.created_at >= ${UNION_CUTOFF}`],
  ] as const) {
    const rows = await q(sql`
      SELECT count(*) AS transitions,
        count(*) FILTER (WHERE ge.verdict_before IS DISTINCT FROM 'contradicted' AND ge.verdict_after = 'contradicted') AS created,
        count(*) FILTER (WHERE ge.verdict_before = 'contradicted' AND ge.verdict_after IS DISTINCT FROM 'contradicted') AS destroyed,
        count(DISTINCT ge.claim_id) AS claims
      FROM grounnel.grounnel_gate_events ge
      WHERE ge.gate = 'escalation_replacement' AND ${where}`);
    const x = rows[0]!;
    const ratio = Number(x.destroyed) > 0 ? (Number(x.created) / Number(x.destroyed)).toFixed(1) : "n/a";
    console.log(`${label}  transitions=${String(x.transitions).padStart(5)}  claims=${String(x.claims).padStart(5)}  created=${String(x.created).padStart(4)}  destroyed=${String(x.destroyed).padStart(3)}  created:destroyed=${ratio}`);
  }
  console.log("\n--- POST-union destroyed contradictions, if any ---");
  const d = await q(sql`
    SELECT c.claim_text, ge.verdict_before, ge.verdict_after, ge.reason
    FROM grounnel.grounnel_gate_events ge JOIN grounnel.grounnel_claims c ON c.claim_id = ge.claim_id
    WHERE ge.gate = 'escalation_replacement' AND ge.created_at >= ${UNION_CUTOFF}
      AND ge.verdict_before = 'contradicted' AND ge.verdict_after IS DISTINCT FROM 'contradicted'`);
  if (d.length === 0) console.log("  (none)");
  for (const r of d) console.log(`  ${r.verdict_before} -> ${r.verdict_after}  [${r.reason ?? ""}]  ${String(r.claim_text).slice(0, 76)}`);
  process.exit(0);
}
await main();
