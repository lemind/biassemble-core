---
description: "Task list for escalation pool union and the evidence-window work that followed — U1/U2 carry the pool, W1 widen the VERIFY window, W2 multi-entity rerank, W3 fetch ladder"
---

# Tasks: Escalation Pool Union

**Input**: [plan.md](./plan.md). No `spec.md`; scope is in plan.md's Summary.

**Prerequisites**: none. Phase 1 is already done (the churn measurement that justified the change).

**Tests**: orchestration control flow only — pool union, dedup, cap, short-circuit keying. No
prompt/LLM-behaviour tests (CLAUDE.md coverage cap).

**Sequencing rule (D030 §3n)**: measure against persisted telemetry before writing production code.
Phase 1 satisfies this.

## Format: `[ID] [P?] [Story] Description`

- **[Story]**: `[U1]` carry the pool, `[U2]` prove it stopped discarding, `[W1]` widen the
  VERIFY window (parked), `[W2]` multi-topic claims, `[W3]` fetch ladder, `[W4]` absence vs refutation, `[W5]` gate-chain verdict stability.

---

## The defect

`escalateUnresolved` calls `discoverUrls()` fresh at every tier and discards the previous tier's
pool, so a later tier can hand VERIFY a strictly worse evidence set than the tier before it.

| metric (3 runs, 32 multi-tier claim-runs) | value |
|---|---|
| tier transitions | 50 |
| transitions dropping ≥1 URL | **35 (70.0%)** |
| URLs dropped | 69 |
| dropped URLs already **selected** (shown to VERIFY) | **50** |

**Expected detection gain is 1 of 5 unstable claims (CSS).** This ships on the churn number, not a
detection story. See plan.md § Honest scope.

---

## Phase 1: Measure (done)

- [x] T001 Measure tier-to-tier pool churn across runs `7c28d45b` / `6760307f` / `f603014b` from
  `grounnel_rerank_decisions`, clustering tiers by a >5s gap in `created_at`
- [x] T002 Cross-run check: for each unstable claim, did a losing run ever hold the winner's deciding
  page and then drop it, or was it never discovered?

**RESULTS (2026-09-07)** — zero API, read-only telemetry.

T001: 50 transitions, 35 (70.0%) dropped ≥1 URL, 69 URLs dropped, **50 of them already selected**.

T002: only **CSS/B** shows had-then-dropped (`prysmian.com/when-was-the-internet-invented`). Mouse,
Rome and Vikings/C never discovered the deciding page at all. Wright is a gate bug, not retrieval.
**Union is scoped to CSS; the other four are explicitly not addressed here.**

---

## Phase 2: Carry the pool [U1]

- [x] T003 [U1] Add `ScoredSource` (`source`, frozen `lexicalScore`, optional `llmScore`) and
  `combinedOf` to `src/orchestrators/grounnel/pipeline-helpers.ts`; add optional
  `rankedPool?: ScoredSource[]` to `ResolvedEvidence`
- [x] T004 [U1] `rerankPassages` takes and returns `ScoredSource[]`, uses the supplied
  `lexicalScore` instead of recomputing from index, and **short-circuits on `union.length <= 1`**
  (not the new-fetch count). Both no-LLM paths emit `llmScore: undefined`
- [x] T005 [U1] `resolveEvidence` takes optional `carried?: ScoredSource[]`; unions new-ok-sources
  with carried, **deduped by normalized URL, newer wins**; input-duplicate runs on every new source
  and a refused re-fetch drops the URL entirely; returns the capped `rankedPool`
- [x] T006 [U1] `resolveAllEvidence` populates `rankedPool`; `escalateUnresolved` threads a
  `Map<claimId, ScoredSource[]>` per tier; `run` seeds it from the base pass
- [x] T007 [U1] Unit tests in `tests/unit/orchestrators/grounnel/pipeline-service.test.ts`:
  base-tier page survives a tier that did not rediscover it; dedup by normalized URL with the newer
  body and newer `url`; frozen `lexicalScore` not re-scored positionally; **one new + several
  carried still calls the reranker**; cap at 8 by `combinedOf` keeping lex=40/llm=95 over
  lex=100/llm=20; missing `llmScore` caps by lexical; refused re-fetch does not resurrect the
  carried copy; a claim whose new pool already contains every carried URL emits the same number of
  `recordRerankDecisions` rows; a non-escalating claim is unchanged

**Hard ordering**: T003 → T004 → T005 → T006 → T007.

**RESULTS (2026-09-07)** — `pnpm typecheck` clean, full suite **1301 passed / 85 files**, 7 new tests.

Two things the implementation had to settle that the plan did not name:

**`droppedAll` had to become `everyNewSourceWasDuplicate`.** The old early-return fired the moment
every *new* source was refused as an input copy. With a carry that is wrong — carried pages may still
be usable — so the `allSourcesWereInputDuplicates` return moved behind `pool.length === 0`.

**A tier that resolves nothing keeps the prior pool** rather than clearing it
(`if (r.rankedPool?.length) carriedByClaimId.set(...)`). Clearing on an empty tier would reintroduce
the exact discard this spec removes, one tier later.

Fixture note for whoever extends these tests: `shingles()` returns a **Set**, so an input document
built by repeating one sentence yields fewer than `MIN_SHINGLES` (8) distinct 5-grams and
`isInputDuplicate` silently disables itself. The G1 test uses 40 varied sentences.

**REVIEW FIXES (2026-09-07)** — `/code-review medium`. Four findings, all applied; suite still 1301.

1. **A carried page could be cited while absent from the claim's own `sources`.** `resolveEvidence`
   returned `sources` = this tier's fetches only, but `passages` now includes carried pages;
   `processVerifyResults` builds the user-facing source list from `item.sources` and the citation URL
   from `item.passages`. On the CSS/B path — the exact case this spec targets — the claim shipped a
   citation to a URL absent from its own source list. Nothing caught it: `citationsInvariant` only
   enforces evidence-null ⇒ citations-empty. Fixed by unioning `sources` with the pool.
2. **`seen` was built from `pool` after construction, so duplicate URLs *within* one tier were never
   deduped** — and the carry then persisted them. `fetchCandidate` returns the post-redirect
   `response.url`, so two discovery candidates can resolve to one page and eat two of three VERIFY
   slots. Fixed by deduping while building the pool; `lexicalScore` still indexes raw fetch order.
3. **`normalizeUrlKey` kept the query string**, so `?utm_source=…` variants did not collapse. Fixed
   by stripping *tracking* params only — dropping the whole query string would merge sites that
   route by `?article=5`, and losing a genuinely distinct page is worse than wasting a slot.
4. Comment at the pool construction was 3 lines / 269 chars; trimmed to 2 with the rationale left in
   plan.md.

Considered and rejected: `String.fromCharCode(65 + i)` overflow (Tavily caps at
`maxCandidates ?? FALLBACK_RETAINED_CANDIDATES` = 8, so the union maxes at 16); memory from the carry
(it holds *references* to `SearchPassage` objects already alive in `resolved`); the
`[...ranked].sort(combinedOf)` re-sort (a no-op on the LLM path, and on the fail-open path it
reorders only the carry, never what VERIFY sees).

Test note: the new sources assertion asserts the invariant — *every citation URL appears in the
claim's own sources* — not a specific URL. In that fixture the carried page ranks third and is not
the cited one; asserting the URL directly tested the fixture's ranking, not the fix.

**REVIEW ROUND 2 (2026-09-07)** — second `/code-review medium`. Five more findings, all applied;
suite 1303. Two of them would have silently defeated the feature:

5. **A tier that found nothing new re-verified the carried pool.** Pre-change, `okSources.length === 0`
   made the tier a genuine no-op. With a carry, `pool` is non-empty, so rerank + VERIFY re-ran on
   byte-identical evidence — burning quota during a known-degraded (e.g. Tavily-rate-limited) tier
   and letting a `contradicted` flip to `unsupported` on pure LLM nondeterminism. The D030 §3h floor
   does **not** stop it: the replacement has citations. Fixed with a `newSourceCount === 0` guard
   that restores the old no-op while keeping the carry alive for the next tier.
6. **The degraded (no-LLM) rerank paths returned pool insertion order.** Carried entries are appended
   last, so on the fail-open and short-circuit paths a carried page could never win a VERIFY slot —
   the union became a no-op exactly when the ranker was down. Both paths now share `degradedRank`,
   which sorts by `combinedOf`. The comment claiming "llmScore stays undefined on both no-LLM paths"
   was **wrong** — `pool.filter` returns the carried objects, which keep their prior tier's score.
7. **`sourceKeys` was built from all of `sources`, failed fetches included**, so a carried ok page
   whose re-fetch was blocked this tier got excluded from `allSources` while staying citable — a
   citation pointing at a source the claim's own list marks unreachable. Now one entry per URL with
   `ok` winning, via a Map that preserves first-seen order.
8. `normalizeUrlKey` rejoined `searchParams` **decoded**, so `?a=1%26b=2` and `?a=1&b=2` produced the
   same key and silently dropped a distinct page. Re-encoded per component.
9. `www.` was not stripped — the same equivalence class as the scheme, and it differs far more often
   between the Gemini-discovery and Tavily-fallback paths. A miss, not a wrong collapse, but it cost
   two of three VERIFY slots on one article.

`ref`/`source` were dropped from `TRACKING_PARAM_RE` on evidence: over 365 real retrieved URLs with
query strings, neither appears, the only tracker present is `utm_source` (14), and content-bearing
keys dominate (`id` 148, `page` 121, `doc_id` 45). Zero observed benefit, nonzero collapse risk.

Round 2 also re-confirmed clean: `lexicalScore` over raw fetch order, `combinedOf` with `llmScore === 0`,
`allSourcesWereInputDuplicates` behaviour, the `rate_limited` consumers, and the A–Z label ceiling.

---

## Phase 3: Prove it stopped discarding [U2]

- [x] T008 [U2] Deployed: golden set + the 44-claim article, **3 repeats**, via Inngest (Gemini is
  geo-blocked locally). **Gate: FA = 0.** Detection on the 9 planted claims is secondary
- [x] T009 [U2] Re-run T001's churn query against the new runs — *transitions dropping an
  already-selected URL* must be **0** by construction. This is the acceptance check for the change,
  independent of detection

**RESULTS (2026-09-07)** — deployed build, golden run `01M1XVCQ4BE2XNWGNDHW5GDQWJ`, article runs
`b36be9ab` (N1) and `db91384b` (N2). Both gates pass.

| gate | target | result |
|---|---|---|
| golden-set false accusations | 0 | **0** |
| golden-set failing cases | 0 | **0 of 28** |
| golden-set binding failures | 0 | **0** (`bindingPassed: true`, 33/33 correct) |
| T009 already-selected URLs dropped | 0 | **0** in both runs (baseline 50) |

Churn, per run: N1 19 transitions / 1 dropping / 0 selected; N2 15 / 0 / 0. Baseline was 50 / 35 / 50.
Multi-tier claim-runs fell 32 → 13 → 10, so fewer claims escalate at all. `g17-wright-brothers-ordinal`
correctRate 0.5 → 1 and `g24-mouse-superlative` 0.8 → 1 while needing 1 run instead of 5 escalated.

**Detection on the article did NOT improve, as predicted.** Pre-change mean 77.8% (88.9 / 55.6 / 88.9),
post-change 72.2% (66.7 / 77.8) — flat, inside noise at n=2. CSS went 2/3 → **2/2**, the one claim this
change was scoped to. The other four unstable claims fail on pages discovery never returned.

One blemish, not a gate failure: N2 marked *"AI would eliminate most programming jobs within five
years"* `contradicted` — a prediction, so not refutable, and `unsupported` in the four prior runs.
Traced: the citing page (`computing.louisiana.edu`) was **freshly discovered at tier 2**, never
carried, so the union did not cause it. It does not appear on the golden set. Worth watching as the
residual FA vector review finding #5 named; not grounds for revert under the pre-registered gate.

**Hard ordering**: T008 before T009 (T009 reads T008's runs). T007 before T008.

---

## Phase 4: Widen the VERIFY window [W1] — PARKED

`MAX_VERIFY_PASSAGES` 3 → 5. **Parked 2026-09-07 on evidence, not shipped.**

The original case was "6 of 10 misses had a page at rank 4–5". That count was built by asking only
*where pages ranked*, never whether the top 3 **already contained the answer**. Re-checked per miss,
it does: Roman/B had the refuting sentence in slot 1, Mouse/B in slot 1, Roman/N1 in slot 3.

**3 → 5 clearly fixes 1 of 10 (Vikings/N2, rank 5), maybe 2 (CSS/B).** It is also the change most
likely to manufacture a false accusation — more text in front of VERIFY is more chances to read a
spurious conflict — at +67% VERIFY input per call. Weakest case on the board; revisit only if
Phase 7's measurement comes back small.

- [x] T010 [W1] ~~PARKED — `MAX_VERIFY_PASSAGES` 3 → 5~~ **SUPERSEDED by T031**, which removed the
  constant entirely rather than raising it. There is no 3 and no 5 to choose between any more
- [x] T011 [W1] ~~deployed, 3 repeats, gate FA = 0~~ **SUPERSEDED** — T032 is this gate, for the
  whole-pool change that replaced the 3 → 5 question

---

## Phase 5: Multi-topic claims [W2]

A claim can be about **several things at once**: "CSS before the Internet" (two), "Apple founded by
Bill Gates" (two), "X larger than Y and Z" (three). The pipeline assumes exactly one.

**The search query is the root, not the ranker.** Today the query is the whole claim text, so
`"CSS was invented before the Internet"` returns CSS-history pages; Internet-date pages appeared in
only 2 of 5 runs, by luck. Re-ranking cannot promote a page discovery never fetched — so branch the
*search*, not just the scoring.

Measured, every run without exception: the reranker scores CSS pages **90–95** and Internet pages
**10–20**, because the prompt (v1.1.0, 2026-08-21, added for the Nauru/Vatican lexical false
positive) says a candidate "about a DIFFERENT real entity must score low". Correct for one-subject
claims; it deletes half the evidence for comparative ones. That line was never weighed against them.

**One VERIFY request, not one per field.** To judge "CSS before the Internet" the model must hold
1996 and 1969 side by side. Split across two calls, neither can compare, and both correctly answer
"cannot tell".

- [x] T012 [W2] EXTRACT: optional `subject_entities: string[]` (≤4), emitted only when the claim names
  more than one checkable thing. Empty/absent ⇒ today's behaviour exactly, reading `subject_entity`
  — EXTRACT prompt v1.6.0 → v1.7.0, `normalizeSubjectEntities` returns `[]` below two distinct
  entities so single-subject claims keep today's path byte-for-byte; 5 unit tests, suite 1308
- [x] T013 [W2] Screen EXTRACT alone on the 9 planted claims plus a slice of true comparatives,
  BEFORE wiring anything downstream — junk second entities pull wrong pages, worse than no change.
  This task can cancel T014–T016 — **PASSED, T014–T016 unblocked**

**T013 RESULTS (2026-09-07)** — run `6d48ebdb`, via `scripts/s017-t013-extract-screen.ts` (reads
`grounnel_llm_calls.parsed_output`, since `subjectEntities` is in-memory only and never persisted).

**6 of 47 claims (12.8%) carry ≥2 entities**, against the plan's predicted ~4–6 of 44 (~10%):

```
CSS | Internet        Apple | Bill Gates      Microsoft | iPhone
Ethereum | Elon Musk  SQL | NoSQL            GraphQL | REST
```

Every one is a genuine two-subject claim — no junk entities, no over-splitting, and no single-subject
claim picked up a spurious second entity. That was the cancel condition, so it does not fire.

**Carry into T016**: `subject_entity` is `""` on all six (feature 013 T31 disabled it), so
`normalizeSubjectEntities` drops the empty head and `subjectEntities` is the **only** entity signal
slot allocation would have. T016 cannot fall back to `subject_entity` for the guaranteed slot.
- [ ] T014 [W2] Branch retrieval: one search per listed entity, pooled into the claim's single pool.
  Only multi-entity claims branch (~4–6 of 44 on the test article, ≈ +10% retrieval)
- [ ] T015 [W2] Rerank prompt: one sentence — a page about **any** listed entity scores high. Keep the
  DIFFERENT-real-entity line for entities NOT listed; that is what fixed Nauru/Vatican
- [ ] T016 [W2] Slot allocation: at most one guaranteed slot per listed entity **when a candidate for
  it exists**, remainder by blended score. Window size unchanged, so the FA surface does not grow.
  No candidate for entity 2 ⇒ all slots to entity 1, which is honest rather than a fake guarantee
- [ ] T021 [W2] Deployed, 3 repeats. **Gate: FA = 0.**

**T014–T016/T021 — RECOMMEND PARKING, user's call (2026-09-07).** T013 unblocked them, but the
funnel fix appears to have already solved what they target. On run `6d48ebdb` all **6 of 6**
multi-entity claims are already correct without any branched search:

| claim | verdict | truth |
|---|---|---|
| CSS invented before the Internet | CONTRADICTED | ✓ false |
| Apple founded by Bill Gates | CONTRADICTED | ✓ false |
| Microsoft did not create the iPhone | SUPPORTED | ✓ true |
| Ethereum not created by Elon Musk | SUPPORTED | ✓ true |
| SQL more useful than NoSQL | EXCLUDED | ✓ opinion |
| GraphQL better than REST | EXCLUDED | ✓ opinion |

CSS/Internet was the motivating case for the whole phase and it now passes on retrieval alone.
Building branched search would add ~10% retrieval and fresh FA surface for **zero measured gain** —
the same trap as T018's URL drop, T025 and T026, all of which measurement cancelled after the design
was already written. Not marked done: this is a recommendation, not a decision.

**Hard ordering**: T012 → T013 → T014 → T015 → T016 → T021.

**T012 RESULTS (2026-09-07)** — typecheck clean, full suite 1308 passed / 85 files.

Nothing consumes `subjectEntities` yet, by design: T013 must screen EXTRACT alone before anything
downstream reads it. **No migration is needed to do that** — EXTRACT's raw response is already
persisted to `grounnel_llm_calls.parsed_output` for `stage='extract'`, so T013 reads the field from
telemetry rather than from `grounnel_claims`.

Design note: `subjectEntity` is always placed first and the cap counts it, so a model list of four
plus a distinct `subject_entity` keeps only three of the model's own entries. The `>= 2` floor is
what makes this backward-compatible — an EXTRACT response that echoes the subject back as a
one-item list collapses to `[]` and changes nothing.

Review fix applied: the prompt's second example was `"Apple was founded by Bill Gates"` — one of the
planted FALSE claims from the test article. Replaced with a neutral `"Company A was founded by
Person B"` so an EXTRACT example is not teaching the pattern off a falsehood.

---

## Phase 6: Fetch ladder [W3]

The other 4 of the 10 misses (Roman/B, Roman/N1, Vikings/B, Vikings/C) had a final-tier pool of
**≤3 pages**. No window size fixes those — the pages were never fetched.

**Discovery is not the bottleneck.** Measured on run `db91384b`: 430 URLs discovered, but
**197 (45.8%) were never fetched at all** because `MAX_CANDIDATES` caps the base tier at 3, and of the
233 actually attempted only 160 (68.7%) returned usable text — 57 blocked, 9 unreachable, 7 paywalled.
Roman/B is typical: 18 URLs discovered, 4 never attempted, 8 blocked, 6 usable.

So the base tier reliably yields ~2 usable pages out of ~10 found.

### Free the wasted slots before buying more

Roman/B, broken down candidate by candidate: **18 fetch-attempt rows, but only 11 distinct URLs, and
only 3 that ever returned usable text.** Where the other slots went:

| waste | count | why |
|---|---|---|
| repeat attempts at domains already known blocked | 7 | `study.com` attempted and blocked 3×, `britannica.com` 3× across passes — the block is a property of the domain, not the attempt |
| `vertexaisearch.cloud.google.com/grounding-api-redirect/…` stubs | 4 | Gemini grounding redirect placeholders, not pages, counted as discovered candidates (and duplicated) |
| genuinely usable | 3 | `mpm.edu`, `romecabs.com`, `wikipedia/Roman_Empire` |

**7 of 18 slots were spent re-failing on domains we had already watched fail.** Doing this first is
strictly cheaper than raising the cap: it costs no extra fetch latency and frees slots for URLs
discovery already found and never tried.

- [x] T017 [W3] Fetch in waves until the TARGET of usable pages is met, with a run-scoped memo of
  already-failed pages checked the moment a redirect resolves — replaces the URL-keyed memo, which
  was impossible (see below)
- [x] ~~T018 [W3] Drop `vertexaisearch.cloud.google.com/grounding-api-redirect/*`~~ — **CANCELLED,
  it would have broken retrieval entirely**

**WHY THE ORIGINAL TASKS WERE IMPOSSIBLE (2026-09-07)** — from `hybrid-provider.ts` and telemetry:

`discoverUrls` returns Gemini grounding chunks whose `web.uri` is **always** an opaque
`vertexaisearch.cloud.google.com/grounding-api-redirect/<token>` URL — the raw form of *every*
candidate, not a stub subset. `fetchCandidate` uses `redirect: "follow"`, so the real page is only
known from `response.url`, after the request. Confirmed across all history:

| status | vertexaisearch | total |
|---|---|---|
| `not_attempted` | **33,712** | 33,730 (99.9%) |
| `ok` | 0 | 37,704 |
| `blocked` | 0 | 8,659 |

So T018 would have discarded 100% of candidates, and a URL-keyed memo can never match a
re-discovered page, because the token differs per discovery call.

**WHAT SHIPPED INSTEAD.** The measured defect was never the memo — it was the funnel: 86,220
candidates discovered, **33,730 (39%) never fetched at all**, and 28% of the 52,490 fetched failed,
so VERIFY routinely saw 1–2 pages while usable URLs sat untried.

- `MAX_CANDIDATES` 3 → **5, and its meaning changed from "attempts" to "usable pages wanted"**.
  `ESCALATION_TIERS` [5, 8] → **[8, 11]** to stay above the new base.
- `HybridSearchProvider.search` fetches in **parallel waves sized to the shortfall** until the target
  is met, bounded by `FETCH_ATTEMPT_BUDGET_MULTIPLIER` (2) attempts per page wanted.
- A run-scoped `failedUrlKeys` set lives in `pipeline.service.ts` (dies with the run) and is threaded
  through `SearchProvider.search`. `fetchCandidate` checks it **the instant the redirect resolves**,
  before reading the body — the earliest point the real page is knowable.
- `MAX_VERIFY_PASSAGES` stays **3**: more pages to rank, same amount of text in front of VERIFY, so
  the false-accusation surface does not grow.

Cost: up to 10 fetch attempts per claim-pass instead of 3, i.e. roughly one extra parallel wave
(~0.5–1s) on claims whose first wave falls short. No LLM calls added.

**Known gap, not fixed here:** `statusFromHttpStatus` maps 403 → `blocked` and *everything else* →
`unreachable`, so an HTTP 429 is indistinguishable from a dead host and the attempt budget is the
only backstop against a rate-limited domain. A guard keyed on `rate_limited` was written, found to be
dead code (only the Tavily fallback ever emits that status, and it returns before the wave loop), and
removed. Mapping 429 properly means touching the `SourceStatus` enum — a separate change.

- [x] T019 [W3] Re-measure the funnel on a fresh run (needs a deploy). Expect usable-pages-per-claim up with **no**
  change to `MAX_CANDIDATES`. Only if that is still short: `MAX_CANDIDATES` 3 → 5 and
  `ESCALATION_TIERS` [5, 8] → [8, 11] — measured on `6d48ebdb`, never-fetched 45% → **6%**,
  usable pages/claim 4.10 → **7.04**; the cap raise shipped inside T017, so this run measures both

**T019 RESULTS (2026-09-07)** — run `6d48ebdb` vs the four pre-T017 baselines, via
`scripts/s017-t019-funnel.ts`. The 39%-never-fetched funnel defect is closed.

| run | attempts | ok | ok/claim | discovered | NEVER fetched |
|---|---|---|---|---|---|
| **6d48ebdb** (T017/T018) | 458 | 317 | **7.04** | 493 | **31 (6%)** |
| db91384b | 234 | 161 | 3.93 | 431 | 197 (46%) |
| b36be9ab | 258 | 175 | 4.27 | 453 | 195 (43%) |
| f603014b | 245 | 168 | 4.10 | 443 | 198 (45%) |
| 6760307f | 245 | 168 | 4.10 | 446 | 201 (45%) |

Block rate is **flat at 24% of attempts** (110/458 vs 58/245), so the doubled fetch volume is not
just hitting more walls. Memo skips (T018) fired **4** times — live, but a small effect next to the
wave loop; the memo is run-scoped and most blocked domains recur across runs, not within one.

**Measurement note — `not_attempted` is two different things.** The pre-existing instrumentation at
`hybrid-provider.ts:231` records every candidate left unfetched after the loop as `not_attempted`;
T018's memo skip now writes the same status. They separate on `duration_ms`: a memo skip resolved a
redirect first (`> 0`), a never-attempted candidate did nothing (`= 0`). Conflating them makes the
funnel look unchanged — the baselines' `memoskip = 0` is what confirms the discriminator.
- [x] T020 [W3] Deployed, 3 repeats. **Gate: FA = 0.** Quote wall-time separately: T017/T018 should
  *reduce* it (fewer doomed fetches); a cap raise would increase it for every claim, including the
  ~70% that already resolve on the first pass — **gate PASSED (FA = 0)**; wall-time went **up**, see below

**T020 RESULTS (2026-09-07)** — golden run `01M1Y6KRGP1JF8FMDDJDWMQRPC`, article run `6d48ebdb`.

Run in **screen+escalate** mode (28 × 1, auto-escalating 5 runs per failing case), not flat 3-repeat:
28 × 3 priced at ~1008 Gemini calls, about a full day's quota. Screen mode covers every case and
deep-dives only where risk appears, for ~336. Consequence: `verdictIsBinding: false` — this is a
clean **screen**, not a 3-repeat verdict, and T021 should re-price before assuming otherwise.

| | golden set | article `6d48ebdb` |
|---|---|---|
| **false accusations** | **0** | **0** |
| correct | 32 / 33 (97%) | 10 / 10 contradictions factually false |
| detection | — | **9 / 9 planted** (baselines: 8, 6, 8, 5) |
| binding failures | 0 | — |

All 10 article contradictions are genuinely false, including one the article states as reported
speech it then debunks ("The documentary also mentioned that the Wright brothers' fourth flight was
120 feet long"). Flagging it is correct — the sentence asserts a falsehood — but it is the tenth
contradiction against nine planted claims, so **count contradictions against ground truth, never
against the planted total**, or this reads as an FA that it is not.

**Wall-time went the wrong way: 137–145s → 178s (+25%).** The task predicted T017/T018 would *reduce*
it. They did not, because the cap raise ships inside T017: attempts went 245 → 458. The prediction
held for the memo and the wave loop in isolation; the cap dominates them. This is the cost of
usable-pages 4.10 → 7.04 and is worth it at FA = 0, but it should not be recorded as a win.

**Only miss: `g17-wright-brothers-ordinal`** — "first flight covered 852 feet" (false) returned
`supported`, detection 0. Under-detection, the safe direction, and no FA. Not established as a
regression: the pre-union golden run's output is past Inngest's retention window and could not be
diffed. g17 is the long-standing ordinal-gate weak case (D030), not new surface from this change.

**Hard ordering**: T017 ∥ T018 → T019 → T020. The cap raise in T019 is **conditional** — it only
happens if freeing the wasted slots does not already supply enough pages.

### Measurement note — which table marks a tier

`grounnel_rerank_decisions` is written in ONE batch per rerank call, so rows inside a tier share a
timestamp to 0.0s and tiers sit minutes apart: clustering it by a >5s gap recovers tiers exactly.
`grounnel_search_calls` spreads over real fetch latency (1.8–4.3s per cluster on Roman/B) and a
>5s gap **over-splits** it — 5 apparent clusters where there were 2 rerank passes. Cluster
`grounnel_rerank_decisions` for anything tier-shaped; `grounnel_search_calls` only for totals.

---

## Phase 7: Absence vs refutation [W4] — MEASURED, CANCELLED

**Looked like the biggest bucket — 5 of the 10 misses. Measured at ~1% of the population; cancelled.** VERIFY collapses "the sources say the opposite" into
"the sources say nothing", answering `unsupported` where `contradicted` is correct.

| miss | what it read | what it answered |
|---|---|---|
| Mouse/B | slot 1: *"A **wired** computer mouse with two buttons"* | *"**None of** the provided sentences state that the first computer mouse was wireless."* |
| Roman/B | slot 1: *"From its **founding in 625 BC**…"* (article titled *The Roman Empire: A Brief History*) | *"…but **none mention** its origin in Greece."* |
| Roman/N1 | slot 3: *"founded when Augustus proclaimed himself first emperor **of Rome**"* | *"…none of the passages mention Greece"* |
| Mouse/N2 | same pages as Mouse/B | *"it does not state whether the very first computer mouse…"* |
| Vikings/N2 | 3 Viking pages | *"**None of** the provided sentences mention Vikings discovering Australia."* |

**No gate can catch this.** `applyCounterfactIgnoredGate` fires only when the model's *reason*
contradicts its *verdict*; here reason ("none of the sentences state X") and verdict (`unsupported`)
agree perfectly. The chain can only catch a contradiction the model expressed and failed to act on —
this one it never noticed. The gap is upstream of every gate.

**Do not write the prompt fix first.** Pushing VERIFY toward `contradicted` is precisely the
direction that manufactures false accusations, and FA has held at 0 across 176 verdicts. A model told
to treat "the sources say something different" as refutation will contradict *true* claims wherever a
source uses different wording, units, or a different instance.

- [x] T022 [W4] From telemetry, pull every `unsupported` verdict whose reason matches the absence
  shape and count them as a share of all `unsupported`
- [x] T023 [W4] Of those, how many read passages that actually contain a refutation?
- [x] T024 [W4] The inverse: how many **correct** `unsupported` verdicts would a stricter rule
  wrongly flip?
- [x] ~~T025 [W4] Draft the VERIFY prompt change~~ — **CANCELLED by T024.**

**RESULTS (2026-09-07)** — `scripts/s017-t022-absence-vs-refutation.ts`, zero API, whole telemetry
history (10,589 persisted verdicts).

| | count | share of `unsupported` |
|---|---|---|
| `unsupported` with a reason | 655 | — |
| absence-shaped reason | 470 | 71.8% |
| absence **+ a clause describing what the sources DO say** (the refutation signature) | **46** | **7.0%** |
| of a manual read of 18 of those 46, genuine "refutation reported as absence" | **~2** | **~0.8%** |

**The 5-of-10 rate on the test article is not the population rate — it is ~1%.** That article's
claims are crisp factual inversions (wireless/wired, Rome/Greece) where refutation is unambiguous.
Real claims are mostly *more specific than the sources*, and there absence is the correct answer.

**T024 is the kill.** The 46 contrast cases are dominated by VERIFY being correctly careful, and a
stricter rule would convert that care into false accusations:

- *"Mount Everest stands at 8,849 meters"* — sources say **8,848.86 m**. A rule that reads "the
  source says something different" as refutation contradicts a **true** claim. Cardinal Rule violation.
- *"The Emu War campaign was declared a total failure within days"* — sources confirm the failure but
  say nothing about timing. Same trap.
- *"Nauru is the world's smallest island nation by population"* — sources give the population but not
  the superlative.

Genuine cases found: *"Apple's market cap surpassed $3.5 trillion in 2024"* (sources say $3.2T) and
*"Svalbard breached by floodwater in 2087"* (sources say 2017). Both are **numeric/date** mismatches,
already the territory of the `numeric` and `year` gates — not a prompt problem.

**Do not touch the VERIFY prompt for this.** Upside ~1% of `unsupported`; downside is manufacturing
false accusations on true claims, against an FA count that has held at 0 across 176 verdicts. If the
two genuine cases matter, they belong in the existing numeric/year gate family, deterministically —
not in a prompt asking the model to lean toward `contradicted`.

**Hard ordering**: T022 → T023 → T024 → ~~T025~~.

---

## Phase 8: Verdict stability in the gate chain [W5]

Two things this investigation surfaced that are gate-chain, not retrieval, and were previously logged
as out of scope. Both are now in scope because the per-miss taxonomy below shows they cover misses no
retrieval change can reach.

**Wright/A — a correct contradiction destroyed by its own retry.** The trail was
`instance_attribution[supported→unverifiable]` → `retry_decision[unverifiable→contradicted]` →
`retry_reconciliation[contradicted→unsupported: retry_contradiction_invalidated]`. The verdict was
right and the evidence was there — the app's own reason says *"Source B states the fourth flight was
852 feet long"*. D030 §3d immunises `reason_ordinal` and `instance_attribution` contradictions from
reconciliation, but this route passed through `unverifiable` first, so the protection never attached.
Runs B, C, N1 and N2 all reached the same claim via `reason_ordinal_mismatch` and held.

**`contradicted` re-escalates and can be overwritten.** `findUnresolvedClaims` excludes only
`supported`, so a claim we correctly caught goes back out for more pages and a later tier can flip
it. That is deliberate (D030 §3m Addendum 8 — "any downgrade moves a claim across this boundary and
buys it a second retrieval pass") and the 14-day census refused a blanket freeze: 716 transitions,
163 created a contradiction, 10 destroyed one. But that census predates the pool union, which changed
what a later tier sees. Re-run it before deciding.

- [x] ~~T026 [W5] Extend D030 §3d protection to a contradiction that reached `contradicted` **via** an
  `instance_attribution` or `reason_ordinal` gate at any point in the chain~~ — **IMPLEMENTED, THEN
  REVERTED ON REVIEW.** Wright/A cannot be rescued this way without immunising false accusations
  — new `contradictionIsProtected` in `pipeline-helpers.ts` replaces the
  `PROTECTED_CONTRADICTION_GATES.has(originatingContradictionGate(...))` test at all three call
  sites; 5 unit tests incl. the Wright/A trail; suite 1313
- [x] T027 [W5] Re-run the escalation-transition census on post-union runs — how many contradictions
  does a later tier create vs destroy now? Decide the freeze question on the new number, not the old
  — **still no freeze**: 12 created vs 1 destroyed post-union
- [x] T028 [W5] Deployed, 3 repeats. **Gate: FA = 0.** T026 makes contradictions harder to remove, so
  watch the false-accusation side specifically — that is the direction it pushes — **moot, folded
  into T020**

**T028 (2026-09-07)** — the premise died with the T026 revert. `contradictionIsProtected` is now
byte-identical to the pre-017 origin-gate-only rule, so nothing makes contradictions harder to remove
and there is no gate-chain-specific surface left to verify. The FA = 0 gate it asked for is the one
T020 ran and passed. Closed as verified-by-T020, not as work performed.

**Hard ordering**: T026 ∥ T027 → T028. T027 can cancel any freeze work outright.

**T026 REVERTED (2026-09-07, `/code-review medium`)** — shipped, reviewed, reverted the same day.
`contradictionIsProtected` now does exactly what the old inline check did: only the gate that
PRODUCED the contradiction protects it.

The widening's *entire* net effect was one class, because `reason_ordinal` and `instance_attribution`
already emit `contradicted` themselves and are therefore caught by the origin check. The only new
firing shape is: a protected gate **downgrades** to `unverifiable`, and a later, unrelated gate
produces the contradiction.

That shape is Wright/A. It is **also** this:

| | Wright/A (want to protect) | numeric false accusation (must not protect) |
|---|---|---|
| gate 1 | `instance_attribution[supported→unverifiable]` | `instance_attribution[supported→unverifiable]` |
| reason | `instance_attribution_conflict` | `instance_attribution_conflict` |
| gate 2 | `retry_decision[→contradicted]` | `numeric[→contradicted]` |

**Identical shape, identical reason code — there is no discriminator.** And
`instance_attribution_conflict` is by its own docstring an abstention ("disagreeing sources are not a
falsehood finding, Cardinal Rule"), so the rule would let "I can't tell" confer immunity.

Worse, `protectedContradictionClaimIds` also excludes a claim from `findUnresolvedClaims`, so a wrong
contradiction would ship with **neither reconciliation nor a second retrieval pass**.

The blast-radius simulation below still stands and is why this was not caught sooner: 7 of 398
trails, all genuinely false claims, **zero retroactive benefit**. Narrow and benign in the data, wrong
in mechanism — and with zero measured upside, the Cardinal Rule decides it. Wright/A stays unfixed;
any future attempt needs a signal that distinguishes an abstention from a finding.

**T027 RESULTS (2026-09-07)** — `scripts/s017-t027-escalation-census.ts`, read-only, counted from
`escalation_replacement` gate events.

| | transitions | claims | contradictions created | destroyed | ratio |
|---|---|---|---|---|---|
| pre-union (all history) | 2,421 | 1,432 | 176 | 10 | 17.6 : 1 |
| post-union (this build) | 72 | 44 | **12** | **1** | **12 : 1** |

**Decision: still no blanket freeze.** The ratio improved (17.6 → 12) but a freeze would save 1 and
cost 12. Sample is small — 72 transitions across 2 runs — so re-take it once more runs exist.

**The one destroyed contradiction post-union is `Amazon began by selling electronics`** — the N1
regression, previously written off as a one-run outlier. It was not noise: an escalation tier
overwrote a correct `contradicted`. That is now a known, measured failure mode with a name.

Gap this exposes: `guardEscalatedContradictionReversals` only re-checks flips to `supported` /
`partially_supported`. Amazon went `contradicted → unsupported`, which the guard does not cover, so
nothing looked at it. Widening that guard is a candidate follow-up — but it pushes toward keeping
contradictions, so it needs the same FA measurement T026 got, not an assumption.

**T026 RESULTS (2026-09-07)** — typecheck clean, suite 1313 passed / 85 files.

The rule now protects a contradiction when a protected gate fired (`overridden`) *strictly before*
the gate that produced it. Strictly before matters: a protected gate firing after the contradiction
cannot have caused it, and counting it would shield unrelated verdicts.

**Blast radius simulated over the full history** (`scripts/s017-t026-protection-blast-radius.ts`,
read-only; replays whole trails where production applies the rule per pass, so it is an upper bound):

| | |
|---|---|
| claims with a gate trail | 10,279 |
| trails containing a contradiction | 398 |
| protected, old rule | 158 |
| protected, new rule | 165 |
| **newly protected** | **7 (1.76%)** |

All 7 are genuinely FALSE claims — Wright fourth-flight-120ft (×4), first-mouse-wireless,
"the first flight lasted 59 seconds" (×2). **No true claim is newly shielded anywhere in the
history**, which answers the false-accusation question with data rather than argument.

Caveat, stated plainly: all 7 already ended `contradicted`, so the *retroactive* benefit is **zero**.
The value is prospective — preventing the Wright/A shape — and Wright/A's own trail is not in the
newly-protected set because its final state was reached by a different path. The in-code note
"simulated over 141 persisted trails: 8 verdicts restored, 0 new false accusations" describes an
earlier change and does **not** cover this rule; the table above does.

---

## Reference: what the 10 misses actually were

Built 2026-09-07 by reading, per miss, the pages VERIFY was actually shown. **Recorded because the
cause was mis-attributed twice** — first "retrieval" for Roman/B, then "rank 4–5" for six of them,
both wrong. Do not re-derive from rank position alone; check whether the top 3 already held the answer.

| miss | real cause | fixed by |
|---|---|---|
| Roman/B | answer in **slot 1** (`mpm.edu`, *"founding in 625 BC"*), VERIFY read it and said "none mention Greece" | nothing planned |
| Roman/N1 | answer in **slot 3** (`rome.net`, *"first emperor **of Rome**"*) | nothing planned |
| Mouse/B | answer in **slot 1** (Wikipedia, *"A **wired** computer mouse"*) | nothing planned |
| Mouse/N2 | same pages as Mouse/B | nothing planned |
| CSS/B | app's own reason names both dates; explicit Internet-date pages at r4/r5 | Phase 5 |
| Wright/A | had the 852 ft fact; **gate chain** downgraded it | **Phase 8 / T026** |
| Vikings/B | pool was 3, all Viking *exhibition* pages | Phase 6 |
| Vikings/C | same | Phase 6 |
| Vikings/N1 | right page (`britannica/did-the-vikings-discover…`) at **rank 9** | nothing planned |
| Vikings/N2 | right page at **rank 5** | Phase 4 (parked) |

**Four of ten are VERIFY reading the answer and not drawing the inference** — and Phase 7 measured
that class at ~1% of the population, with a fix that would manufacture false accusations. So those
four are, for now, accepted as unfixed.

## Implementation strategy

**MVP is U1, shipped alone.** It is a data-plumbing change inside one file, with no prompt, schema,
or provider-contract surface, and no change to how many passages VERIFY sees.

U2 is not optional — T009 is the only check that proves the change did what it claims, and it is
independent of the noisy detection metric.

## Phase 9: Stop paying for pages that cannot be fetched [W6]

- [x] T029 [W6] Order discovered candidates so bare-domain-titled ones are tried LAST — deprioritize,
  never drop. `orderByFetchability` in `hybrid-provider.ts`, 3 unit tests, suite 1320 / 85 files
- [x] T030 [W6] Deployed re-measure on the 44-claim article. **Gate: FA = 0** ✅. Wall-time
  expectation **not met** — 248s → 313s, accepted (see T041)

**T029 RATIONALE (2026-09-07)** — replaces the persistent blocked-domain memo that was planned here.

The memo was the wrong shape. Discovery returns opaque `vertexaisearch…/grounding-api-redirect/`
tokens, so a domain is only knowable **after** the redirect resolves — by which point the 403 has
already been paid for. A domain blocklist could not have saved the request it existed to save.

Gemini's own grounding `title` is the signal, and it arrives at discovery time. It titles a chunk
with a bare domain (`"fandom.com"`) only when it could not read the page itself. Measured over 4,820
candidates from 3 days of runs:

| status | bare-domain title | rich title | % bare |
|---|---|---|---|
| ok | 4 | 3673 | **0.1%** |
| blocked | 704 | 0 | **100%** |
| unreachable | 272 | 0 | **100%** |
| paywalled | 48 | 119 | 28.7% |

1024 of 1028 bare-titled candidates failed — **99.6% precision**, and it catches `unreachable` too,
which a blocklist keyed on 403s never would. It is not our own `domainOf(uri)` fallback: that would
yield `vertexaisearch.cloud.google.com`, so the bare domain is Gemini's.

**Deprioritized, not dropped** — a stable sort, so discovery rank still orders each group and the
wave loop still reaches these candidates when the good ones run out. That makes the 0.1% false-negative
rate cost nothing, and needs no Redis, no TTL, and nothing blocked "forever".

## Phase 10: VERIFY reads the whole pool [W7] — supersedes T010/T011

- [x] T031 [W7] Remove `MAX_VERIFY_PASSAGES`. VERIFY reads every ranked passage, bounded only by
  `MAX_LABELLED_PASSAGES = 26` (the A–Z label codec ceiling, not a quality choice). Suite 1320 / 85
- [x] T032 [W7] Deployed re-measure, article + golden. **Gate: FA = 0** ✅ across both. Detection
  held at 9/9 on the article; golden left one binding failure (g24), analysed under T040

**T031 RATIONALE (2026-09-07)** — we ranked ~12 pages and showed VERIFY 3. The other 9 were fetched,
ranked, and thrown away, and a new page could displace the deciding one out of the window. That is
the mechanism behind the Amazon regression: not a *worse* pool (the union made it a superset), but a
**fixed window over a growing pool**.

The tail is evidence, not noise — measured on `6d48ebdb`:

| | n | mean llm score | score < 20 |
|---|---|---|---|
| rank 1–3 (already read) | 198 | 84.0 | 2% |
| **rank 4+ (newly read)** | **157** | **71.4** | **13%** |

157 pages per run at mean relevance 71 were being discarded. Pool size is modest — median **5**,
p90 9, max 13 — so this is ~+80% VERIFY input at the median, and every pool observed sits well under
the 26-label ceiling. Each passage stays capped at `MAX_SENTENCES = 20`, so payload grows linearly.

**This is the largest false-accusation surface increase in the spec, and it is deliberate.** The old
3-slice was doing double duty: ranking *and* excluding. Only ranking survives. The Nauru/Vatican
regression test (a real 2026-08-10 incident) changed meaning accordingly — the off-topic pages are
now **outranked rather than excluded**, and its assertion was rewritten to that, not softened away.
Remaining protection is rerank order + `subject_entity` threading + the D030 gate chain.

**Open recommendation, NOT implemented** (user's call): a relevance floor that drops candidates the
reranker itself scored < 20. It would cut 13% of the newly-read tail — the Vatican/Swiss-Guard shape
— while keeping 87% of the evidence this change unlocks. Deliberately not added: it reintroduces a
cap by another name, and the ask was that VERIFY read everything.

## Phase 11: T031 review fallout [W7]

- [x] T033 [W7] `MAX_CARRIED_SOURCES` 8 → **15**. Removing the window made the carry cap *smaller*
  than what VERIFY reads, so pages VERIFY had already read were dropped before the next tier — the
  exact defect this spec exists to remove, reintroduced from the other side. 15 + the top tier's 11
  fetches = 26, exactly the label ceiling
- [x] T034 [W7] Apply `degradedRank`'s relevance filter to the rerank success path. The `slice(0, 3)`
  was silently the only relevance *filter* on the healthy path; without it the fail-open path was
  **stricter** than the healthy one, and a ranker-rejected page could become a user-facing citation
- [x] T035 [W7] Review cleanups: label the rerank prompt via `passageLabelForIndex` (a bare
  `String.fromCharCode(65 + i)` past index 25 emits `[` and silently degrades every candidate to
  lexical-only scoring); exclude the grounding-redirect host from T029's signal; re-key the T009
  churn gate off carry-eligible rank; two over-long comments; stale `8 + 8 = 16` arithmetic

**REVIEW RESULTS (2026-09-07)** — `/code-review medium`, 10 findings, all applied. Suite 1320 / 85.

The headline was an invariant inversion. Before T031: window 3 ⊂ carry 8, so everything VERIFY read
was carried. After: window ≤19 ⊃ carry 8. **7 of 66 rerank passes** on `6d48ebdb` had pools > 8, so
it fired immediately. Caught pre-deploy — production was still on the old window throughout.

T034 is the one that changed a safety story back. The Nauru/Vatican regression test (a real
2026-08-10 incident) had to be weakened under T031, because off-topic pages were merely *outranked*
rather than excluded. With the filter restored to parity, its original assertions — no "Swiss Guard"
text in front of VERIFY, `selected = false` for the off-topic page — **pass again unmodified**.

`selected` is informative again as a side effect: it now means "VERIFY actually read this", not "a
row exists". That is what the T009 gate needs, and it is why `slice(0, 26)` is no longer dead code —
at carry 15 the maximum pool is exactly 26, so the label ceiling is now the real operative bound.

## Phase 12: high-effort review fallout [W7]

- [x] T036 [W7] `implicit_negation` reads its own bounded slice (`NEGATION_GATE_PASSAGES = 3`), not
  every pooled body. **This was a live false-accusation hole opened by T031**, in the one gate that
  upgrades to `contradicted`; 2 tests on `runGateChain`
- [x] T037 [W7] T034's filter re-keyed from the lexical predicate to `llmScore >= 20`. The lexical
  version dropped 14 pages the ranker scored 70–95 and **zero** it scored < 20 — the two mechanisms
  were near-opposites
- [x] T038 [W7] `MAX_CARRIED_SOURCES` derived from `MAX_LABELLED_PASSAGES - max(ESCALATION_TIERS)`;
  the ceiling moved to `pipeline-helpers.ts` where the codec lives; the churn gate imports it rather
  than transcribing it; `passageLabelForIndex` moved inside the fail-open `try`; empty-title
  inversion in `orderByFetchability`; dead re-sort and no-op slice removed

**T036 — the one that mattered.** `applyImplicitNegationGate` is the only gate that upgrades
`unsupported` → `contradicted`. Its condition 3 (`some(term => passageLower.includes(term))`) is a
precision guard whose docstring says it "trades recall for precision by design" — and that precision
came entirely from `passageText` being 3 passages. T031 silently made it ~24 full page bodies, which
makes the check near-vacuous: any pooled page containing "1903" or "wright" satisfies it and the
claim ships as `contradicted`.

When T031 was written its rationale listed the remaining protections as "rerank order +
`subject_entity` threading + the D030 gate chain". It was spending the precision of a gate *inside*
that chain. Gate #1's `evidenceMatchesPassage` genuinely needs the full corpus, so the two were split
rather than narrowed together.

**T037 — measured on run `6d48ebdb`, 355 ranked candidates:**

| mechanism | dropped | of which llm ≥70 | of which llm <20 |
|---|---|---|---|
| lexical filter (T034 as first written) | 29 (8.2%) | **14** | 0 |
| `llmScore >= 20` (shipped) | 24 (6.8%) | **0** | 24 |

`extractKeyTerms("Historical computer mice were connected to computers by cables.")` returns
`['historical']` alone, so relevance reduced to whether a page contains that literal word —
dropping `sri.com` (95) and `darpa.mil` (90) on the mouse claim. D026 §18 introduced the LLM reranker
*because* lexical matching judges aboutness badly; the first version of T034 inverted that.

The score floor also resolves the empty-pool concern for free: `kept` is empty only when every
candidate scored < 20, in which case `NO_EVIDENCE_REASON` ("no relevant source found") is accurate,
which it was not under the lexical version.

## Phase 13: the reranker orders, it never excludes [W7]

- [x] T039 [W7] **Revert T034 and T037.** No relevance filter on the rerank success path. A relevance
  score cannot gate a fact-checker, and neither proxy for it worked
- [x] T040 [W7] Re-run golden + article deployed. **Gate: FA = 0, and g05/g12/g24 back to detecting**
  — FA = 0 ✅, g05 and g12 restored ✅, **g24 still failing** ❌

**T040 RESULTS (2026-09-07)** — deploy `dpl_BTChLR…` (a95cc2d), golden `01M1YGNF6M72TXVDVWDBJEDTC0`.

| eval | build | correct | FA | binding failures |
|---|---|---|---|---|
| `01M1Y6KR` | pre-T031 | 32/33 | 0 | none |
| `01M1YEVK` | T031 + filter | 34/45 | 0 | g05, g12, g24 |
| `01M1YGNF` | T031, no filter | **33/37** | **0** | **g24 only** |

The revert restored g05 and g12 exactly as predicted, confirming the filter was the cause.

**g24 is not a window effect.** "The first computer mouse was wireless" ran with `rerank rows: 3,
selected: 3` — the pool was 3, so T031's wider window is not in the mechanism. VERIFY's own reason
gives it away: *"Source A explicitly states 'The Logitech Metaphor, the first wireless mouse (1984)'"*.
Retrieval surfaced wireless-mouse history pages and VERIFY matched **"first wireless mouse"** to
**"first computer mouse was wireless"** — a superlative/instance conflation, the same family as g17,
and `retry_decision` then upgraded `partially_supported → supported`.

**Not established as a regression.** g24 passed a single screening run pre-T031 and is now 1/5; with
no N=5 baseline, one passing observation is weak evidence either way. What is established: the pool
size rules out the window, and the failure is a wrong `supported` on a false claim — a miss, not a
false accusation. FA has now measured **0 across all three evals** and both article runs.

**T039 EVIDENCE (2026-09-07)** — golden run `01M1YEVKJ4ZMKJD10RNBN2VVC0` FAILED: 34/45 correct,
**FA = 0**, three cases confirmed lost at N=5 — `g05-statue-of-liberty`, `g12-bukowski-death-year`,
`g24-mouse-superlative`. All three: `rerank rows: 13, selected: 0`, no gate events, no VERIFY call.

The floor deleted every candidate. Scores for "The Statue of Liberty was a gift from **Canada**":

```
lex=100 llm=10  en.wikipedia.org/wiki/Statue_of_Liberty
lex= 80 llm=10  nps.gov/stli/learn/historyculture/the-french-connection
lex= 75 llm=10  francechannel.tv/.../HOW-...
              ... all 13 candidates scored llm=10
```

Those are the correct refuting sources. The rerank prompt scores a page about a DIFFERENT entity low
(the g17/Nauru fix); the claim asserts a *Canadian* gift and every page describes a *French* one, so
the reranker reads them as off-entity. **Refuting evidence contradicts the claim's framing by
definition, so it always scores low** — a relevance score therefore deletes exactly the evidence that
produces a detection, and only ever on false claims.

Both attempts failed in opposite directions, which is what makes this conclusive:

| attempt | signal | deleted |
|---|---|---|
| T034 | lexical key terms | pages scored **90–95** (`sri.com` on the mouse claim) |
| T037 | `llmScore >= 20` | pages scored **10 that ARE the refutation** (g05, g12) |

The original T034 finding — the fail-open path filters while the healthy path does not — stands, but
the resolution is the reverse of what was applied: `degradedRank` is the anomaly, not the LLM path.
Left as-is because it is the harmless direction (a rare error path being stricter) and FA measured 0
in every run, filter or none.

## Phase 14: accepted as-is [W7]

- [x] T041 [W7] **Decision (2026-09-07): keep T031 unchanged.** No cap at 5, no revert.

T031 removed the fixed 3-passage window so VERIFY reads the whole ranked pool. It is live and
working — VERIFY reads 5–10 passages where it read exactly 3.

**It has no measured benefit and a measured cost**, and that is recorded here deliberately rather
than quietly:

| | pre-T031 `6d48ebdb` | post-T031 `bb62670f` |
|---|---|---|
| contradictions | 10 (identical list) | 10 |
| planted detection | 9/9 | 9/9 |
| FA | 0 | 0 |
| wall-time | 248s | **313s** |
| golden binding failures | none | g24 |

Detection was already 9/9 before T031. The gain came from **T017** (never-fetched 45% → 8%, usable
pages 4.10 → 7.73), which lifted the article off its 8/6/8/5 baselines. By the time T031 landed the
top 3 passages already held the answer.

Options weighed and declined: revert to a fixed window, or cap at 5. Kept as-is on the user's call.

**Known accepted risk:** 313s against Vercel's 300s `maxDuration`. The run completes because internal
work is ~250s, but the margin is ~17% and it shrinks as articles get longer. If runs start ending
with claims unwritten, this is the first place to look — cap the window before anything else.

## Explicitly out of scope

- **Discovery quality.** 3 of the 5 unstable claims failed because the deciding page was never
  discovered. Union cannot fix that; no plan for it yet.
- **Multi-entity `subject_entity` / rerank prompt** — the CSS-class fix, next change set. This one is
  its prerequisite.
- **`MAX_VERIFY_PASSAGES`** — later, and only after this lands.
- ~~**Wright `retry_reconciliation`**~~ — moved IN scope, Phase 8 / T026.
- **Skipping the re-fetch of a URL already held** — would widen the `SearchProvider` contract.
- **The `String.fromCharCode(65 + i)` overflow at >26 candidates** — latent; the cap of 8 keeps the
  union at ≤16.
- **Freezing contradictions across tiers** — refuted by the 14-day census (716 / 163 / 10).
