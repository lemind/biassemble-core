---
description: "Task list for escalation pool union — U1 carry the pool, U2 verify it stopped discarding"
---

# Tasks: Escalation Pool Union

**Input**: [plan.md](./plan.md). No `spec.md`; scope is in plan.md's Summary.

**Prerequisites**: none. Phase 1 is already done (the churn measurement that justified the change).

**Tests**: orchestration control flow only — pool union, dedup, cap, short-circuit keying. No
prompt/LLM-behaviour tests (CLAUDE.md coverage cap).

**Sequencing rule (D030 §3n)**: measure against persisted telemetry before writing production code.
Phase 1 satisfies this.

## Format: `[ID] [P?] [Story] Description`

- **[Story]**: `[U1]` carry the pool, `[U2]` prove it stopped discarding.

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

- [ ] T008 [U2] Deployed: golden set + the 44-claim article, **3 repeats**, via Inngest (Gemini is
  geo-blocked locally). **Gate: FA = 0.** Detection on the 9 planted claims is secondary
- [ ] T009 [U2] Re-run T001's churn query against the new runs — *transitions dropping an
  already-selected URL* must be **0** by construction. This is the acceptance check for the change,
  independent of detection

**Hard ordering**: T008 before T009 (T009 reads T008's runs). T007 before T008.

## Implementation strategy

**MVP is U1, shipped alone.** It is a data-plumbing change inside one file, with no prompt, schema,
or provider-contract surface, and no change to how many passages VERIFY sees.

U2 is not optional — T009 is the only check that proves the change did what it claims, and it is
independent of the noisy detection metric.

## Explicitly out of scope

- **Discovery quality.** 3 of the 5 unstable claims failed because the deciding page was never
  discovered. Union cannot fix that; no plan for it yet.
- **Multi-entity `subject_entity` / rerank prompt** — the CSS-class fix, next change set. This one is
  its prerequisite.
- **`MAX_VERIFY_PASSAGES`** — later, and only after this lands.
- **Wright `retry_reconciliation`** — D030, separate change set.
- **Skipping the re-fetch of a URL already held** — would widen the `SearchProvider` contract.
- **The `String.fromCharCode(65 + i)` overflow at >26 candidates** — latent; the cap of 8 keeps the
  union at ≤16.
- **Freezing contradictions across tiers** — refuted by the 14-day census (716 / 163 / 10).
