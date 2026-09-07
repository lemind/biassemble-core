/**
 * Wright payload screen (D030 §3m Addendum 20) — the prompt is held FIXED at v4.6.0 and the INPUT
 * varies. Eight prompt levers were already refuted; this asks whether the model can be moved at all
 * by what we hand it. `variants` is control-only: nothing is spliced.
 *
 * Payloads are pinned real `input_payload` rows, not hand-written — run 4 carries the decisive
 * "fourth flight ... 852" sentence, run 3 is rank-only ("record"/"longest", no member named).
 *
 * Usage: npx tsx --env-file=.env scripts/trigger-payload-screen.ts [--repeats 3] [--dry-run]
 */
import { sql } from "drizzle-orm";
import { inngest } from "../src/jobs/client.js";
import { getDb } from "../src/db/config.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i !== -1 ? args[i + 1] : undefined; };
const repeats = Number(arg("repeats") ?? 3);
const dry = args.includes("--dry-run");

/** Pinned so the screen is reproducible: run 4 has the member-naming sentence, run 3 does not. */
const RUN_WITH_MEMBER = "f95e56a7-ace4-4976-b9fd-3f5702d59f96";
const RUN_RANK_ONLY = "c98eb144-e076-4c89-9dbd-4eda28e8d86d";

const FALSE_CLAIM = "The first flight covered 852 feet.";
const TRUE_CLAIM = "The fourth and final flight covered 852 feet.";
const BROAD = "Wright brothers";
const MEMBER_FALSE = "the first flight of December 17, 1903";
const MEMBER_TRUE = "the fourth and final flight of December 17, 1903";

type Sent = { n: number; text: string; selector?: string };
type Passages = Record<string, Sent[]>;

/** The exact pair production sent VERIFY for the 852 claim in that run. */
async function pinnedPayload(runId: string): Promise<Passages> {
  const db = getDb();
  const r = (await db.execute(sql`
    SELECT input_payload p FROM grounnel.grounnel_llm_calls
    WHERE run_id = ${runId}::uuid AND stage='verify' AND input_payload IS NOT NULL
    ORDER BY created_at`)) as unknown as { rows?: Array<{ p: unknown }> } | Array<{ p: unknown }>;
  for (const row of (Array.isArray(r) ? r : (r.rows ?? []))) {
    const items = (Array.isArray(row.p) ? row.p : [row.p]) as Array<Record<string, unknown>>;
    const t = items.find((i) => /852/.test(String(i?.claim ?? "")) && /first flight/i.test(String(i?.claim ?? "")));
    if (t?.passage_sentences) return t.passage_sentences as Passages;
  }
  throw new Error(`no pinned 852 payload in run ${runId}`);
}

const mapSentences = (p: Passages, keep: (s: Sent) => boolean, dropped: string[]): Passages =>
  Object.fromEntries(Object.entries(p).map(([src, ss]) => [src, ss.filter((s) => {
    if (keep(s)) return true;
    dropped.push(`${src}:${s.n}  ${s.text.slice(0, 90)}`);
    return false;
  })]));

/** Heading/worksheet crumbs: no terminal punctuation, or a list marker. Deterministic, printed below. */
const isProse = (s: Sent) => /[.!?]\s*$/.test(s.text) && !/^[a-z]\)\s/i.test(s.text);
/** The member the CLAIM does not select. Aliases (fourth/last/final) are one member, D030 §3m. */
const namesOtherMember = (s: Sent) => /^(fourth|4th|last|final)$/i.test(s.selector ?? "");

async function main() {
  const base = await pinnedPayload(RUN_WITH_MEMBER);
  const rankOnly = await pinnedPayload(RUN_RANK_ONLY);

  const droppedTitles: string[] = [];
  const noTitles = mapSentences(base, isProse, droppedTitles);
  const droppedMember: string[] = [];
  const noMemberSentence = mapSentences(base, (s) => !namesOtherMember(s), droppedMember);

  // Pre-registered. `expect` is the hypothesis, never edited to match a result.
  const fixtures = [
    { id: "f0-baseline", role: "negation", claim: FALSE_CLAIM, subject_entity: BROAD, passages: base, expect: "contradicted", relationship: "CONFLICT" },
    { id: "f1-subject-member", role: "negation", claim: FALSE_CLAIM, subject_entity: MEMBER_FALSE, passages: base, expect: "contradicted", relationship: "CONFLICT" },
    { id: "f2-no-title-crumbs", role: "negation", claim: FALSE_CLAIM, subject_entity: BROAD, passages: noTitles, expect: "contradicted", relationship: "CONFLICT" },
    { id: "f3-drop-other-member", role: "negation", claim: FALSE_CLAIM, subject_entity: BROAD, passages: noMemberSentence, expect: "unsupported", relationship: "ABSENT" },
    { id: "c1-true-broad", role: "control", claim: TRUE_CLAIM, subject_entity: BROAD, passages: base, expect: "supported", relationship: "SAME" },
    { id: "c2-true-member", role: "control", claim: TRUE_CLAIM, subject_entity: MEMBER_TRUE, passages: base, expect: "supported", relationship: "SAME" },
    { id: "c3-true-rankonly", role: "control", claim: TRUE_CLAIM, subject_entity: MEMBER_TRUE, passages: rankOnly, expect: "supported", relationship: "SAME" },
    { id: "c4-true-no-titles", role: "control", claim: TRUE_CLAIM, subject_entity: BROAD, passages: noTitles, expect: "supported", relationship: "SAME" },
    // Isolates c3: same rank-only payload, broad entity. Without it a c3 miss cannot be attributed
    // to the narrow subject_entity rather than to the payload lacking the member sentence.
    { id: "c5-true-rankonly-broad", role: "control", claim: TRUE_CLAIM, subject_entity: BROAD, passages: rankOnly, expect: "supported", relationship: "SAME" },
  ];
  const variants = [{ id: "control", strategy: "live VERIFY 4.6.0, NOTHING spliced — only the payload varies", blocks: [] as string[] }];

  const shape = (p: Passages) => `${Object.keys(p).length} sources / ${Object.values(p).flat().length} sentences`;
  console.log("PAYLOAD SCREEN — one prompt (v4.6.0, unmodified), eight inputs");
  console.log(`  ${variants.length} variant x ${fixtures.length} fixtures x ${repeats} = ${variants.length * fixtures.length * repeats} Gemini calls\n`);
  console.log(`  base (run 4, member named): ${shape(base)}`);
  console.log(`  rank-only (run 3):          ${shape(rankOnly)}`);
  console.log(`  after title strip:          ${shape(noTitles)} — dropped ${droppedTitles.length}:`);
  for (const d of droppedTitles) console.log(`      - ${d}`);
  console.log(`  after other-member strip:   ${shape(noMemberSentence)} — dropped ${droppedMember.length}:`);
  for (const d of droppedMember) console.log(`      - ${d}`);
  if (droppedTitles.length === 0 || droppedMember.length === 0) { console.error("\nABORT: a strip removed nothing — the fixture would duplicate f0."); process.exit(1); }

  console.log("\n  PRE-REGISTERED:");
  console.log("    f0 MUST return `supported` 3/3 — it is the reproduction check. Otherwise the screen is noise.");
  console.log("    Any control leaving `supported` KILLS that lever, whatever its target row scored.");
  console.log("    c3 -> unsupported is the predicted new-miss cost of a narrow subject_entity. Report it, do not explain it away.");
  console.log("    c3 is only attributable against c5: if c5 also misses, the payload is the cause, not the entity.");
  console.log("    f1 `supported` 3/3 = dead. No retry with a longer subject_entity under the same name.\n");
  for (const f of fixtures) console.log(`    ${f.id.padEnd(22)} expect ${String(f.expect).padEnd(14)} subject_entity="${f.subject_entity}"`);

  if (dry) { console.log("\n--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, fixtures, variants } });
  console.log(`\n✓ triggered: ${r.ids.join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
