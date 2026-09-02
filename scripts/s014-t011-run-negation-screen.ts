/**
 * spec 014 T011 — run the negation-polarity / asserted-predicate screen directly against Gemini.
 *
 * Fixtures, variants and the splice are imported from the job module, so the pre-registered targets
 * cannot drift between this path and the Inngest one.
 *
 * NOTE: this dev machine is geo-blocked from the Gemini API (D030 P1; specs/013 t21-results.md) —
 * a local run returns 400 "User location is not supported". The screen must execute deployed, via
 * Inngest on Vercel. This script is kept for a machine that can reach the API.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t011-run-negation-screen.ts [--repeats 3] [--dry-run]
 */
import { writeFileSync } from "node:fs";
import { GeminiProvider } from "../src/providers/gemini";
import { PromptRegistry } from "../src/prompts/registry";
import { VerifyRawResponseSchema } from "../src/orchestrators/grounnel/pipeline-schemas";
import { FIXTURES, VARIANTS, buildVariantPrompt } from "../src/jobs/eval-negation-polarity";
import { CONFIDENCE_THRESHOLD } from "../src/orchestrators/grounnel/pipeline.service";

const args = process.argv.slice(2);
const arg = (f: string, d: number) => {
  const i = args.indexOf(f);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : d;
};
const REPEATS = arg("--repeats", 3);
const CONCURRENCY = arg("--concurrency", 5);

const RUNNABLE = FIXTURES.filter((f) => f.passages !== null);

interface Cell { variant: string; fixture: string; role: string; expect: string; got: string }

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function main() {
  const total = VARIANTS.length * RUNNABLE.length * REPEATS;
  console.log(`014 T011 negation-polarity screen`);
  console.log(`  ${VARIANTS.length} variants x ${RUNNABLE.length} fixtures x ${REPEATS} repeats = ${total} Gemini calls`);
  console.log(`  ${FIXTURES.length - RUNNABLE.length} C4 rows skipped (no passages)\n`);
  if (args.includes("--dry-run")) return;

  const provider = new GeminiProvider();
  const prompts = new PromptRegistry();

  const jobs: { variant: (typeof VARIANTS)[number]; fixture: (typeof RUNNABLE)[number]; rep: number }[] = [];
  for (const variant of VARIANTS) for (const fixture of RUNNABLE) for (let r = 0; r < REPEATS; r++) jobs.push({ variant, fixture, rep: r });

  let done = 0;
  const cells = await pool(jobs, CONCURRENCY, async ({ variant, fixture }): Promise<Cell> => {
    const rendered = prompts.render("grounnel-verify", {
      claim_passage_pairs: JSON.stringify([
        { id: fixture.id, claim: fixture.claim, subject_entity: "", passage_sentences: fixture.passages },
      ]),
      threshold: String(CONFIDENCE_THRESHOLD),
    });
    let got = "ERROR";
    try {
      const res = await provider.completeJson<unknown>({
        system: buildVariantPrompt(rendered, variant.blocks),
        user: "Verify the claim/passage pair above. Return the JSON now.",
      });
      const parsed = VerifyRawResponseSchema.safeParse(res.result);
      got = parsed.success ? (parsed.data.results[0]?.verdict ?? "MISSING") : "PARSE_FAIL";
    } catch (e) {
      got = `ERROR:${(e as Error).message.slice(0, 40)}`;
    }
    if (++done % 20 === 0) process.stdout.write(`  ...${done}/${total}\n`);
    return { variant: variant.id, fixture: fixture.id, role: fixture.role, expect: fixture.expect, got };
  });

  writeFileSync("specs/014-verify-negated-claim-polarity/t011-screen-raw.json", JSON.stringify(cells, null, 2) + "\n");

  console.log("\n=== PER-VARIANT SCORECARD ===");
  const summary: Record<string, unknown>[] = [];
  for (const variant of VARIANTS) {
    const mine = cells.filter((c) => c.variant === variant.id);
    const byFixture = RUNNABLE.map((f) => {
      const rows = mine.filter((c) => c.fixture === f.id);
      return { id: f.id, role: f.role, expect: f.expect, hits: rows.filter((r) => r.got === f.expect).length, got: rows.map((r) => r.got) };
    });
    const role = (r: string) => byFixture.filter((f) => f.role === r);
    const missed = (rows: typeof byFixture) => rows.filter((f) => f.hits < REPEATS).map((f) => f.id);
    const n1 = byFixture.find((f) => f.id === "n1-pentagon-investigating")!;
    const c5 = byFixture.find((f) => f.id === "c5-narrower-same-predicate")!;
    const c5Split = n1.hits !== c5.hits;

    const verdict = missed(role("control")).length
      ? `FAIL — controls broken: ${missed(role("control")).join(", ")}`
      : missed(role("reporting")).length
        ? `FAIL — reporting broken: ${missed(role("reporting")).join(", ")}`
        : c5Split
          ? "FAIL — C5/n1 disagree (Block B ate Block A)"
          : missed(role("negation")).length
            ? `INCONCLUSIVE — negation missed: ${missed(role("negation")).join(", ")}`
            : missed(role("block-b")).length
              ? `WEAK — block-b missed: ${missed(role("block-b")).join(", ")}`
              : "PASS";

    const hits = (r: string) => `${role(r).reduce((a, f) => a + f.hits, 0)}/${role(r).length * REPEATS}`;
    console.log(`\n${variant.id}  ${verdict}`);
    console.log(`   negation ${hits("negation")}   reporting ${hits("reporting")}   block-b ${hits("block-b")}   control ${hits("control")}`);
    for (const f of byFixture.filter((x) => x.hits < REPEATS)) {
      console.log(`     miss ${f.id.padEnd(32)} want=${f.expect.padEnd(21)} got=${f.got.join(",")}`);
    }
    summary.push({ variant: variant.id, verdict, negation: hits("negation"), reporting: hits("reporting"), blockB: hits("block-b"), control: hits("control") });
  }

  writeFileSync("specs/014-verify-negated-claim-polarity/t011-screen-summary.json", JSON.stringify(summary, null, 2) + "\n");
  console.log("\nwrote t011-screen-raw.json + t011-screen-summary.json");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
