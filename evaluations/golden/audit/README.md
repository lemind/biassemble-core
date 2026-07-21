# Audit-mode golden sets

Three golden sets for the two audit-mode prompts (EXTRACT, VERIFY) and the code-side numeric normalization layer, per ADR-000 §4 steps 2–3 and D018 §2.1–§2.3. All built against one real, unmodified SEC filing — see `source-filing.md`.

This is deliberately **synthetic-equivalent data**: the ten EXTRACT texts are hand-authored "AI research note" style paragraphs about a real filing, not any company's actual product output. They are for measuring the pipeline, never for making claims about Apple. The Fintool teaser material (ADR-000 §4 step 6) is a separate, later step that uses a target company's own public output — see `context-prompt-b2b-transformation.md` §8 for that runbook.

## Labeling discipline (read before extending any of these files)

**Labels are written before the prompt they test exists to run against them.** Every `expected_claims`, `expected_verdict`, and `expected` block in these three files was hand-authored at the same time as the input it labels — the same person who wrote a trap decided its correct answer before any model ever saw it. This is not a formality: `hypotheses/v2.yaml` in the engine repo was tuned while looking at eval failures by name, and the Marta test exists specifically because that tuning wasn't out-of-sample. Do not repeat that mistake here.

If you need a new case: write the input and its expected answer together, commit them, *then* run the prompt. If a prompt run reveals a case was mislabeled, fix the label with a comment explaining why, don't silently adjust it to match what the model produced.

## The three sets

| File | Cases | Tests |
|---|---|---|
| `extract-golden-set.json` | 11 | EXTRACT prompt (D018 §2, `context-prompt-b2b-transformation.md` §4) — case 11 (dedup) added during `specs/008-b2b` task-review, spec.md's own edge case had zero coverage until then |
| `verify-golden-set.json` | 15 | VERIFY prompt (D018 §2.3, `context-prompt-b2b-transformation.md` §5) |
| `numbers-golden-set.json` | 20 | Code-side normalization layer between EXTRACT and VERIFY (D018 §2.3, "arithmetic happens in code, never in the LLM") |

## EXTRACT match rule (there was none before this file — defining it here)

A model-extracted claim **matches** an expected claim iff:
1. `type` is identical, and
2. `excerpt` matches the expected excerpt after normalization (lowercase, collapse whitespace, unify quotes/dashes/ellipses — same normalization `grounding-numbers-plan.md`'s excerpt-verification phase already specifies for the evidence-quote check) — exact match, or fuzzy ≥95 (rapidfuzz `partial_ratio`) on the fallback, and
3. the `claim` field's stated value/entity/direction doesn't contradict the expected claim (paraphrase in wording is fine; the excerpt anchor and the type must line up).

Score per scenario: **precision** = matched / total extracted, **recall** = matched / total expected. Aggregate across all 10.

**Pass bar**: recall ≥ 0.90, precision ≥ 0.85, and **zero leaks from any scenario's `excluded_content`** — extracting an opinion, forecast, or hedge as if it were a checkable claim is an automatic fail for that scenario regardless of the P/R numbers, since that's the exact failure the exclusion rules in the EXTRACT prompt exist to prevent.

`locations` (every expected claim now carries one, e.g. `["p1s2"]`, sentence-position within `output_text`) is recorded and worth eyeballing during review, but is **not** part of the pass/fail score above — no fuzzy-matching tolerance has been designed for it yet. Score on type + excerpt only until that's decided.

VERIFY doesn't need an equivalent rule — its output is an enum (`supported | partially_supported | unsupported | contradicted | unverifiable`), so "did it match" is just "is it the same string," per D018 §2.3.

## Numbers-layer pass bar

**Zero false "not comparable = contradicted."** Whenever `comparable: false` (different currency with no FX rate, missing unit, period ambiguity, pp-vs-% confusion), the case must never be treated downstream as evidence the claim is wrong — a data gap is not a contradiction. This is called out because it's the one failure mode that accuses a customer's AI of an error it didn't make, which is fatal to the product's credibility on its own terms (ADR-000 §2's headline promise is FP discipline). Every `num-0XX` case with `comparable: false` in `numbers-golden-set.json` exists specifically to catch a normalizer that guesses instead of flagging.

## What's still missing

**EXTRACT's attribution instruction is unimplementable as written.** The prompt says, for attribution claims: "mark the inner content separately if itself checkable" — but the output schema has no field for it (no second claim, no link between an attribution claim and its inner-content claim). None of the 11 EXTRACT cases here test it, because there's nothing to test yet. Needs a decision before EXTRACT is wired: either cut the instruction, or add the schema field (e.g. `inner_claim_ref`) and a golden case exercising it. Not decided here.

**`entity` claim type (numeric/entity/attribution/causal/derived per the EXTRACT prompt) is never exercised** in `extract-golden-set.json`. Fine for a first draft — every scenario here happened to produce numeric, attribution, causal, or derived claims — but worth a case before calling this set complete (e.g. "Apple's CFO is Kevan Parekh" style entity fact, or a product/segment identity claim).

There is no dedicated numeric-claim-verification spec document in this repo — `context-prompt-biassemble-overview.md` (~/Downloads) §8 references one under the name `prompt-plan-grounding-numbers.md`, but the file that actually exists under a similar name (`grounding-numbers-plan.md`) is about excerpt-verification/calibration/canary discipline, not unit/currency/period normalization. `numbers-golden-set.json` above is built directly from the one-line principle in `b2b-change-plan.md` and D018 §2.3, not from a fuller spec — because no fuller spec exists on disk anywhere. Worth writing one before this golden set is treated as complete/final rather than a reasonable first draft.

## Source filing provenance

Apple Inc. Form 10-Q, quarterly period ended March 28, 2026, filed 2026-05-01. Public EDGAR filing, fetched 2026-07-20 via `curl` with an SEC-compliant User-Agent header (SEC requires a declared contact identifier, not a login — no ToS issue). Full excerpt and location-tag index: `source-filing.md`.
