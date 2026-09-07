// Spec 017 T019 — re-measure the retrieval funnel after the wave loop (T017) and the blocked memo
// (T018). Baseline defect: 39% of discovered candidates were never fetched at all. Zero API.
// Usage: pnpm exec tsx --env-file=.env scripts/s017-t019-funnel.ts <run-id-prefix>...
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";

const db = getDb();
const q = async (s: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
  const r = (await db.execute(s)) as unknown;
  return Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);
};

const prefixes = process.argv.slice(2);
if (prefixes.length === 0) { console.error("usage: s017-t019-funnel.ts <run-id-prefix>..."); process.exit(2); }

const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("run", 12) + pad("attempts", 10) + pad("ok", 8) + pad("blocked", 9) + pad("unreach", 9) + pad("paywall", 9) + pad("memoskip", 10) + pad("claims", 8) + pad("ok/claim", 9) + pad("discovered", 12) + "NEVER FETCHED");
console.log("-".repeat(112));

for (const p of prefixes) {
  const rows = await q(sql`
    SELECT claim_id, status, result_count, call_type, duration_ms
    FROM grounnel.grounnel_search_calls
    WHERE run_id::text LIKE ${p + "%"}`);
  if (rows.length === 0) { console.log(`${pad(p, 12)}(no search calls)`); continue; }

  const byClaim = new Map<string, { attempts: number; ok: number; discovered: number }>();
  let ok = 0, blocked = 0, unreach = 0, paywall = 0, memo = 0, never = 0, attempts = 0;
  for (const r of rows) {
    const st = String(r.status);
    const cid = String(r.claim_id);
    if (!byClaim.has(cid)) byClaim.set(cid, { attempts: 0, ok: 0, discovered: 0 });
    const c = byClaim.get(cid)!;
    // not_attempted is the memo skip (T018): a real slot freed, not a fetch that failed.
    // Both the T018 memo skip and the pre-existing never-fetched bucket write "not_attempted";
    // only the memo skip resolved a redirect first, so duration_ms > 0 separates them.
    if (st === "not_attempted") { if (Number(r.duration_ms) > 0) memo++; else never++; continue; }
    attempts++; c.attempts++;
    if (st === "ok") { ok++; c.ok++; }
    else if (st === "blocked") blocked++;
    else if (st === "paywalled") paywall++;
    else unreach++;
    c.discovered = Math.max(c.discovered, Number(r.result_count) || 0);
  }
  const claims = byClaim.size;
  // Every discovered candidate gets exactly one row (resultCount 1), so the rows ARE the funnel.
  const discovered = attempts + memo + never;
  console.log(
    pad(p, 12) + pad(String(attempts), 10) + pad(String(ok), 8) + pad(String(blocked), 9) +
    pad(String(unreach), 9) + pad(String(paywall), 9) + pad(String(memo), 10) + pad(String(claims), 8) +
    pad((ok / claims).toFixed(2), 9) + pad(String(discovered), 12) +
    `${never} (${((100 * never) / discovered).toFixed(0)}%)`
  );
}
console.log("\nT019 gate: ok/claim UP vs baseline, unfetched% DOWN. memo-skip>0 proves T018 is live.");
process.exit(0);
