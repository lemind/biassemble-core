/**
 * T28 Step 1 — offline passage inventory, zero API cost (D030 §3m Addendum 3).
 * Asks one thing: when subject_entity fired, was the claim's subject even PRESENT in the selected
 * passage for VERIFY to have cited? If it frequently was not, citation-completeness cannot fix M2
 * and the prompt direction is dead. Lexical overlap is a coarse filter only — the sample dump at
 * the end exists so the real cases get read by eye before anything is concluded.
 *
 * Usage: npx tsx --env-file=.env scripts/t28-passage-inventory.ts [sampleSize]
 */
import { getDb } from "../src/db/config";
import { grounnelGateEvents, grounnelClaims, grounnelRerankDecisions, grounnelSearchPages } from "../src/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { properNounWords } from "../src/orchestrators/grounnel/gates-shared";

const SAMPLE = Number(process.argv[2] ?? 12);

async function main() {
  const db = getDb();

  // Every distinct claim this gate ever suppressed. Count is a moving target — record the date.
  const firings = await db
    .selectDistinct({ runId: grounnelGateEvents.runId, claimId: grounnelGateEvents.claimId, claimText: grounnelClaims.claimText })
    .from(grounnelGateEvents)
    .innerJoin(grounnelClaims, eq(grounnelClaims.claimId, grounnelGateEvents.claimId))
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true)));

  console.log(`subject_entity firings (distinct claims): ${firings.length}`);

  let subjectPresent = 0;
  let subjectAbsent = 0;
  let noPassage = 0;
  const absentExamples: Array<{ claimText: string; names: string[] }> = [];
  const presentExamples: Array<{ claimText: string; matched: string[]; snippet: string }> = [];

  for (const f of firings) {
    const rows = await db
      .select({ text: grounnelSearchPages.excerpt })
      .from(grounnelRerankDecisions)
      .innerJoin(
        grounnelSearchPages,
        and(
          eq(grounnelSearchPages.url, grounnelRerankDecisions.url),
          eq(grounnelSearchPages.claimId, grounnelRerankDecisions.claimId),
          eq(grounnelSearchPages.runId, grounnelRerankDecisions.runId)
        )
      )
      .where(
        and(
          eq(grounnelRerankDecisions.runId, f.runId),
          eq(grounnelRerankDecisions.claimId, f.claimId),
          eq(grounnelRerankDecisions.selected, true)
        )
      );

    if (rows.length === 0) {
      noPassage++;
      continue;
    }

    const passage = rows.map((r) => r.text).join(" ... ");
    const claimNames = [...properNounWords(f.claimText)];
    const passageNames = properNounWords(passage);
    const matched = claimNames.filter((n) => passageNames.has(n));

    if (claimNames.length === 0) {
      // No proper noun in the claim at all — the gate abstains on these, so they are not the
      // population this question is about.
      noPassage++;
      continue;
    }

    if (matched.length > 0) {
      subjectPresent++;
      if (presentExamples.length < SAMPLE) {
        const idx = passage.toLowerCase().indexOf(matched[0]!);
        presentExamples.push({ claimText: f.claimText, matched, snippet: passage.slice(Math.max(0, idx - 90), idx + 130).replace(/\s+/g, " ") });
      }
    } else {
      subjectAbsent++;
      if (absentExamples.length < SAMPLE) absentExamples.push({ claimText: f.claimText, names: claimNames });
    }
  }

  const scored = subjectPresent + subjectAbsent;
  console.log(`scored: ${scored}  (skipped ${noPassage}: no stored passage, or claim has no proper noun)`);
  console.log(`subject PRESENT in passage: ${subjectPresent} (${((subjectPresent / scored) * 100).toFixed(1)}%)`);
  console.log(`subject ABSENT  in passage: ${subjectAbsent} (${((subjectAbsent / scored) * 100).toFixed(1)}%)`);

  console.log(`\n--- PRESENT sample (read these: is the match a real subject mention, or a coincidental token?) ---`);
  for (const e of presentExamples) {
    console.log(`\nCLAIM   : ${e.claimText}`);
    console.log(`MATCHED : ${e.matched.join(", ")}`);
    console.log(`PASSAGE : …${e.snippet}…`);
  }

  console.log(`\n--- ABSENT sample (true M1: no lexical overlap even against the full passage) ---`);
  for (const e of absentExamples) {
    console.log(`\nCLAIM : ${e.claimText}`);
    console.log(`NAMES : ${e.names.join(", ")}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
