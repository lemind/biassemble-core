---
description: "Task list for Grounnel D032 remediation — bounded fixes and gated measurements"
---

# Tasks: Grounnel D032 Remediation

**Input**: [spec.md](./spec.md), [D032](../../docs/decisions/032-grounnel-failure-taxonomy-and-rework-vs-fix.md)
(incl. §8 review round), [D030](../../docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md).

**Tests**: Selectively included. Per CLAUDE.md's coverage cap, unit tests are added only for
contract/orchestration logic (T5, T12). Prompt and LLM-behaviour changes (T8, T14) are verified by
live golden-set runs, not fixtures — writing a unit test for those duplicates what the golden set
already proves.

**Organization**: Grouped by phase. **Phase 0 is a hard gate** — three of the five fixes cannot be
correctly scoped until their measurement returns, and one (T2) can invalidate an entire work item.
Ordering is by dependency, not importance.

**Sequencing rule inherited from D030 §3n**: simulate against persisted telemetry before writing
production code. Every fix task below that touches behaviour has a measurement or simulation
predecessor. This is the step that killed 4/4 `subject_entity` fixes before they shipped.

---

## Phase 0 — Decisions and measurements (blocks nearly everything)

- [x] **T1 — Ratify the extraction contract (A or B)**
  - Acceptance: D032 §2's proposed wording is accepted, amended, or rejected in favour of B; the
    decision is recorded in D032 with a date.
  - Verify: D032 §7 Q1 reads *answered*, not *awaiting*.
  - Files: `docs/decisions/032-*.md`
  - **Result (2026-08-26): Contract A ratified.** T9, SC-6 unblocked.

- [x] **T2 — Answer: does the frontend distinguish exclusion via `reason`?**
  - Acceptance: a yes/no answer with the evidence (the frontend code path that reads `reason`, or
    confirmation that it switches on `verdict` alone).
  - Verify: recorded in D032 §7 Q3.
  - Files: none in this repo — requires the frontend repo.
  - **Result (2026-08-26): No.** Frontend switches on `verdict` alone (`verdictStyle.ts`); `.reason`
    is fetched but never rendered anywhere in `biassemble/frontend/src`. FIX-1 ships backend-only.
    T5, T6, T7 unblocked. New follow-up: T16 (frontend `excluded` styling, separate small PR).

- [x] **T3 — MEASURE-1: does the case-1 false affirmation reproduce?**
  - Acceptance: a new golden case for "the first computer mouse was wireless" (`kind: false`) run at
    N≥10; the `supported` rate is recorded with N stated.
  - Verify: `pnpm tsx scripts/trigger-eval-grounnel.ts --cases g24-mouse-superlative --repeats 10`,
    then query `grounnel_claims` for the verdict distribution.
  - Files: `evaluations/golden/grounnel/live-eval-golden-set.json`
  - **Result (2026-08-26, D032 §3g): 10/10 `contradicted`, 0/10 `supported`. Does not reproduce.
    T8 cancelled** — do not harden a prompt against a single unlucky draw.

- [x] **T4 — MEASURE-2: prediction-classifier misclassification rate**
  - Acceptance: from historical `grounnel_llm_calls` (`call_type='eligibility_check'`), pull every
    claim classified `prediction`; hand-label whether each is genuinely checkable — specifically
    including dated/scheduled future events ("will report earnings on October 15"), which are
    checkable despite being future-tense. Report the rate with N.
  - Verify: written number in D032 or a new ADR section; zero API cost (reads persisted telemetry).
  - Files: `scratchpad/` script (untracked).
  - **Result (2026-08-26, D032 §3h): n=1 across 2,724 eligibility checks — too small for a rate.
    T13 stays gated** (not cleared, not failed — the category is too rare to decide from).

---

## Phase 1 — Zero-gate fix (start immediately, independent of Phase 0)

- [x] **T7 — FIX-2: enriched `reason` for no-evidence verdicts**
  - Acceptance: `NO_EVIDENCE_REASON` (and the `rewriteUngroundedAffirmativeReason` path) states both
    that no supporting evidence was found *and* that this is not a finding of falsehood. No verdict
    logic changes.
  - Verify: live smoke on a claim known to return no evidence; read the stored `reason`. Satisfies
    SC-2.
  - Files: `src/orchestrators/grounnel/pipeline.service.ts`, possibly `gates.ts`
  - Depends on: T2 only if the wording turns out to be frontend-owned (spec Open Question 4);
    otherwise none.
  - Note: this task *replaces* D032's R1. Do not let it grow into a refutation search.
  - **Result (2026-08-26, commit `c57375b`): done.** This checkbox was just never flipped after the
    commit landed — the dependency graph below already (correctly) showed T7 ✅. No further work
    needed; fixed here as a bookkeeping correction, caught 2026-08-27 when the user pointed at this
    exact block.

---

## Phase 2 — Contract fix (needs T2)

- [x] **T5 — FIX-1a: add `excluded` to the verdict contract**
  - Acceptance: `excluded` exists in `GrounnelVerdictEnum` (Zod), `db/schema.ts`, `db/queries.ts`,
    and the persistence types — all declaration sites updated together, matching the
    `retry_decision` precedent. Migration generated and hand-verified.
  - Verify: `npx tsc --noEmit`; `npx vitest run`; migration SQL reviewed against
    `.skills/drizzle-migrations.md`.
  - Files: `src/contracts/grounnel.schemas.ts`, `src/db/schema.ts`, `src/db/queries.ts`,
    `src/persistence/types.ts`, `src/db/migrations/`
  - Depends on: T2. **Ask before applying the migration** (spec Boundaries).
  - Note: resolve spec Open Question 3 first — enum value vs. separate status field. A never-checked
    claim arguably has no verdict at all.
  - **Result (2026-08-26): enum value chosen** (D032 §11) — matches spec's own `retry_decision`
    precedent, smaller frontend lift given T2's finding. **No migration** — `pnpm db:generate`
    confirmed "No schema changes, nothing to migrate" (`verdict` has no SQL CHECK constraint, TS-only
    enum). Audit-pipeline's unrelated verdict enum deliberately untouched.

- [x] **T6 — FIX-1b: write `excluded` from the eligibility path**
  - Acceptance: `writeExcludedClaim` persists `excluded`, not `unverifiable`. The distinct per-
    category `reason` strings are retained.
  - Verify: live smoke with one opinion claim + one genuinely-unverifiable claim; confirm the two
    are distinguishable in the API response and in `grounnel_claims`. Satisfies SC-1.
  - Files: `src/orchestrators/grounnel/extract.service.ts`
  - Depends on: T5.
  - Scope note (D032 §3f): this covers **41.9%** of historical `unverifiable` claims. It does not
    address the 24.9% produced by `subject_entity` downgrades — see T6b.
  - **Result (2026-08-26): done** (D032 §11). Also updated `grounnel-live-gate.ts`'s `ACCEPTABLE`
    mapping and `grounnel-store.ts`'s score computation (excluded claims correctly drop out of
    `eligible` — documented as deliberate, not a gap). 84 files / 1219 tests pass, `tsc` clean.
  - **Live SC-1 smoke verification (2026-08-27): PASS.** g18 (opinion claim) ran twice through the
    live eval harness post-deploy: both came back `excluded` with the expected reason text. This
    half of SC-1 is closed.

- [x] **T6b — Label `subject_entity` downgrades distinctly**
  - Acceptance: a claim downgraded to `unverifiable` by the `subject_entity` gate is distinguishable
    — in `grounnel_claims` and/or the API — from one that genuinely could not be verified. Minimum
    viable form: a distinct `reason` string; fuller form: its own verdict/status value.
  - Verify: confirm each of the three §3f causes is separable in the live API response
    (`GET /status/:id`, Redis-backed) — **not** in `grounnel_claims` (Postgres deliberately keeps
    VERIFY's raw, unlabelled reason for D030 §3n-style replay; see D023 §7's 2026-08-27 amendment,
    T18). Extends SC-1.
  - Files: `src/orchestrators/grounnel/pipeline-gate-chain.ts` or `pipeline.service.ts`'s write path
  - Depends on: T5 (if it takes an enum value) — otherwise none.
  - Note: **does not change gate behaviour.** D030 §3m's decision to keep `subject_entity` as-is
    stands; this only stops its downgrades from masquerading as genuine verification failures. That
    24.9% slice is the same population D030 §3m measured as ~25–30 wrongly-suppressed true claims
    per 1,000 — labelling it makes that cost visible in production instead of only in archaeology.
  - **Result (2026-08-26): minimum viable form — distinct `reason` suffix** (D032 §11). Chose this
    over a new verdict value to keep the enum small (only `excluded`'s ambiguity was severe enough
    to warrant one — subject_entity's is a labelling gap, not a category-collapse). **`/code-review
    medium` caught 2 real bugs before shipping**: a composition-order bug that could produce a
    self-contradictory reason ("no evidence found" + "evidence was found" in the same sentence) on
    any subject_entity downgrade with an originally-affirmative reason, and a stale-gate-events read
    that could mislabel a genuinely-different retry outcome. Both fixed; see D032 §11 for the
    mechanism. New `composeUserFacingReason` (extracted, directly tested — 3 new tests reproduce the
    exact precondition that hid bug #1).
  - **SC-1 subject_entity half — CLOSED 2026-08-27 by D030 §3n replay against real production data**
    (a live run was never needed): pulled all **64** real production `unverifiable` claims that had an
    overridden `subject_entity` event, and replayed each one's real verdict + real raw reason + real
    final-pass gate shape through `composeUserFacingReason`. **58/58 of the claims whose final pass was
    actually caused by `subject_entity` produce the label**; the other 6 correctly do not, because a
    later pass owned their verdict (exactly what `currentPassGateEvents` is supposed to enforce — the
    stale-gate-events bug `/code-review` caught). Sample real output: *"Multiple sources state that a
    flight covered 852 feet. Evidence was found but could not be confirmed as being about this claim's
    specific subject — this is not a finding that no evidence exists."* SC-1 is now fully closed.
  - **Why a live run couldn't close it, and what was changed so the next one can:** the user-facing
    reason exists only in the run's Redis view (Postgres keeps VERIFY's raw text — T18/D023 §7), and
    the eval harness's Redis is in-memory and discarded, so `/status/:id` 404s for eval runs. The
    Inngest eval job now logs a bounded `userFacingReasons` field (reason-bearing verdicts only,
    truncated, capped at 40) so this class of check no longer requires archaeology.
  - **Earlier attempt (superseded by the replay above): inconclusive, not failed.** Gate telemetry confirmed
    `subject_entity` fired (`overridden=true`) on g22 in 2 eval-harness runs, and `composeUserFacingReason`
    correctly applies the suffix on that precondition. But the labelled text was never observed live:
    eval-harness runs bypass Redis entirely (Postgres-only stores, by the eval job's own design), so
    `/status/:id` 404s for them; a real `POST /extract` call was then tried, but that run's retrieval
    came back cleaner than the golden case engineers and `subject_entity` never fired (`supported`,
    not `unverifiable`) — retrieval variance, not a fix problem. Re-verify by forcing the trigger
    condition on a real run, or accept the unit/gate-telemetry evidence as sufficient.
  - **New finding, independent of whether T6b works (2026-08-27):** `grounnel_claims` (Postgres)
    deliberately stores VERIFY's raw `reason`, never `userFacingReason`, across all 3 write sites in
    `pipeline.service.ts` (each carries the same "historyStore keeps raw" comment, D031-era). Sound
    for D030 §3n-style replay/archaeology, but it contradicts D023 §7's own wording calling the
    Postgres row "a durable mirror" of what Redis holds — and it means this task's own verify step
    ("confirm each is separable... in `grounnel_claims`... without joining `grounnel_gate_events`")
    is not satisfiable as literally written; only the live Redis-backed API response ever carries the
    label. **Needs a decision, not yet made:** (a) update D023 §7 + this verify step to match the
    current raw-reason-in-Postgres design (recommended — it's what makes D030 §3n's replay work), or
    (b) change the 3 write sites to persist `userFacingReason` instead. Tracked as **T18**.

---

## Phase 3 — Behaviour fixes (each needs its Phase 0 measurement)

- [x] ~~**T8 — FIX-4: extend the VERIFY prompt's superlative section**~~ **CANCELLED (2026-08-26)**
  - T3 came back 10/10 `contradicted`, 0/10 `supported` — the failure does not reproduce (D032 §3g).
    Per this task's own cancellation clause, no prompt change is made. SC-4 is satisfied as a side
    effect of the measurement itself, without touching `verify/system.json`.

- [x] **T10 — MEASURE-3: do negative claims fail systematically?**
  - Acceptance: 3–5 negative-claim golden cases ("X did not do Y", positive form well documented),
    run at N≥10. Failure rate recorded.
  - Verify: golden-set run; verdict distribution per case.
  - Files: `evaluations/golden/grounnel/live-eval-golden-set.json`
  - **Result (2026-08-26, D032 §3k): 38/50 supported, 7/50 (14%) `contradicted` on `kind:true`
    claims — a live Cardinal Rule violation, not a coverage gap. T11/T12 are NOT cancelled and are
    now higher priority than originally scoped. ⚠ T11's premise is also wrong** — search is not
    failing (correct evidence retrieved in all 7 false-accusation cases); this is a VERIFY
    polarity/negation-handling defect downstream of retrieval. **T11's design must be redone against
    this mechanism before any code is written** — query reframing does not address it.

- [x] **T11 — FIX-3a: design** — ~~negative-claim reframing~~ **RE-SCOPED: negation-scope guard for
  the reason-family gates.** Design written: **D032 §9**. Options A (VERIFY prompt) and B (new gate)
  scored 14/50 and 32/50 and both rejected; adopted option C — add a negation-scope precondition to
  the three *existing* gates that produced 100% of the wrong verdicts.
  - Acceptance: ~~detecting a negative claim and inverting its search query~~ superseded. Design
    covers: which gates change, the abstain-on-negation precondition, why it is downgrade-only by
    construction, and the simulation corpus.
  - Verify: design reviewed before implementation; simulate the predicate against the 12 captured
    repetitions + all historical firings of the three gates (zero API cost).
  - Files: `docs/decisions/032-*.md` §9.
  - **`reason_ordinal` is FROZEN (D030 §3k, not §3m — corrected citation).** Unfreeze decided
    2026-08-26 on the freeze's own exemption terms (D032 §9c). T12 unblocked.

- [x] **T12 — FIX-3b: implement the negation-scope guard**
  - Acceptance: `reason_year`, `reason_ordinal`, and `reason_consistency` abstain when the compared
    claim token sits inside a negation scope. No new gate is added; no verdict-escalation path is
    added. Unit tests cover the negation predicate and each gate's abstain path (pure logic —
    in-scope per CLAUDE.md, and `gates.ts` is the one place kept exhaustive).
  - Verify: `npx tsc --noEmit` clean; `npx vitest run` 84 files / 1208 tests pass (14 new negation-
    guard tests added). D030 §3n replay against all 109 historical `overridden=true` firings of the
    three gates: **exactly 31/109 change — the negated-claim set, all from T10's own measurement,
    all confirmed false accusations. The other 78 (all legitimate historical firings) are
    untouched — the guard is claim-text-only and structurally cannot reach them.** A naive full
    replay first showed 76 changed; the extra 45 were stale `grounnel_claims.reason` (retry/
    escalation rewrites it after a gate ran — D030 §3n's own documented caveat, reproduced directly:
    a historical `reason_ordinal` firing replayed against its now-stale stored reason abstained via
    a *pre-existing, unmodified* code path — `reasonMatches.length === 0` — before the new guard was
    even reached). Isolating the guard's claim-text-only precondition from that confound resolved it.
  - Files: `src/orchestrators/grounnel/gates-shared.ts` (new `containsNegationCue`/`NEGATION_CUE_RE`,
    shared with `gates-reason-grounded.ts`'s existing position-scoped `isNegatedAtPosition`),
    `gates-reason-grounded.ts`, `gates-text-grounding.ts`, `pipeline-gate-chain.ts` (threaded
    `claimText` into `applyReasonConsistencyGate`'s call), `tests/unit/orchestrators/grounnel/gates.test.ts`
  - Depends on: T11 (done) + the `reason_ordinal` unfreeze (done, D030 §3k amendment).
  - **`/code-review medium` run (2026-08-26), 4 findings fixed:** stale `D030 §3m` citation in a code
    comment (missed when other citations were corrected — should have been §3k); every new comment
    exceeded CLAUDE.md's ~200-char rule, trimmed to one-liners + ADR pointers; negation detection was
    backward-only, missing postposed phrasing ("1943 is not the year it ended") — now bidirectional
    via new `isClaimTokenNegated`, 2 new tests added; `reason_consistency`'s presence-only scoping can
    suppress a genuine unrelated contradiction in a compound claim — accepted as a documented,
    safe-side gap (not fixed — a real fix needs either risky comma-scoping or the trust-ordering
    redesign §9c already left open), 1 new "known gap" test added. Re-ran the D030 §3n replay after
    the postposed-negation fix: still exactly 31/109, unchanged. Final: 84 files / 1211 tests pass.
  - **Live verification (2026-08-26), deployed uncommitted (see commit note below):**
    - **SC-3 — PASS, 50/50.** All 5 T10 golden cases re-run at N=10: 100% `supported`, 0 `contradicted`,
      0 `unsupported` (was 38/50 supported, 7/50 false-accused pre-fix). Confirmed at the mechanism
      level too — `reason_year`/`reason_ordinal`/`reason_consistency` all ran and correctly abstained
      (`overridden=false`), not merely silent.
    - **SC-5 — targeted subset run** (10 cases × N=5 ≈ 600 calls, not the full 28-case/1680-call set —
      user chose the cheaper option given ~1300 calls already spent today; full-set SC-5 remains open).
      Scored with the real `evaluateGrounnelRun` harness, not by hand. 8/10 clean. Two anomalies, both
      **confirmed unrelated to T12**: g22's correctRate 0.00 is the pre-existing, documented, safe
      `subject_entity` downgrade (D030 §3l/§3m) — not new. g23 produced one real safety violation
      (`contradicted` on a true claim) traced to a **newly-discovered, pre-existing, unrelated bug**
      (D032 §10 — `SELECTOR_RE_G` reads "second" out of "12-second") that T12's guard demonstrably did
      not cause (`isClaimTokenNegated` correctly found no negation and deferred to untouched code).
  - **Not yet committed.** Deployed via the working-tree upload the user's `vercel --prod` uses from
    this directory (confirmed: results reflect the fix), but `git log` still stops at `e1ba84f` —
    committing needs to happen before this state is anything but local+deployed.
  - Remaining before this ships: live re-verification of T10's 5 golden cases (SC-3: Aldrin/WWII
    should now reach `supported` ≥8/10) and full golden-set regression (SC-5) — not yet run, needs
    deployment same as T3/T10 did.

- [ ] **T20 — g17 catches its false claim only ~33% of the time** ⚠ **measured, not a regression**
  - **Finding (2026-08-27, n=82 historical runs of g17's own claim text):** `supported` 42,
    `contradicted` 24, `unverifiable` 6, `unsupported` 1 — a **~33% catch rate**, and the dominant
    failure (42/82) is `supported`, i.e. actively affirming a claim the golden set labels `false`.
    The golden set sets `minCorrectRate: 1.0` for this case, so it has been failing its own bar for
    its entire recorded history.
  - **Not caused by anything on this branch.** Triggered by a 2026-08-27 miss that looked like a T17
    regression; ruled out by replaying all 25 historical `reason_ordinal` catches through post-T17
    code (25/25 still fire) and by confirming old/new `SELECTOR_RE_G` behave identically on g17's
    text. `reason_ordinal` also caught g17 twice on 08-26, i.e. after T12 shipped.
  - **Mechanism:** `applyReasonOrdinalGate` compares the claim's ordinal against an ordinal *in
    VERIFY's reason*. When VERIFY writes "the distance covered was 852 feet" without naming which
    flight, there is no ordinal to compare and the gate abstains (`reasonMatches.length === 0`, a
    pre-existing path). The gate is working; its **input** is unreliable. D030 built this gate for
    g17 and it does catch g17 — but only when VERIFY happens to name the competing ordinal.
  - **Decision (2026-08-27): keep `minCorrectRate: 1.0`. g17 stays RED.**
    **Observed performance is a measurement, not a requirement.** Relaxing the threshold to 33% would
    make the evaluator lie about the requirement and convert a real detection gap into a green tick.
    The honest signal is worth more than a passing suite. Rejected: "accept ~33% and correct the bar".
  - **What changes instead: reporting, not the target.** The eval already emits per-case detection
    distributions (`detection` in `eval-grounnel-run.ts` — `detectionRate` plus the per-verdict
    spread), which is what makes a 3/10 case distinguishable from a 10/10 one. g17 is recorded as a
    **known stochastic detection gap**, red and visible, not silenced.
  - **`reason_ordinal` is re-FROZEN** (D030 §3k, re-frozen 2026-08-27 after T12's scoped unfreeze).
    Do not tune it for g17. The gate is not the defect — it fires correctly whenever VERIFY names a
    competing ordinal (25/25 historical catches still fire post-T17).
  - **Prompt-only intervention is NOT the next move either.** This exact class already has a failed
    prompt attempt on record (D030 §1: the `SEQUENCE POSITION` VERIFY section failed live 2/2 and was
    reverted). Next step is investigation, not implementation: does evidence-side instance attribution
    — or a stronger verifier — show enough **measured** benefit to justify the work? Simulate before
    building (D030 §3n).
  - **Do not "fix" this by loosening the gate** — the same pressure produced the D030 §3k freeze and
    T17's false accusation. Downgrade-only discipline stands.

- [x] ~~**T13 — FIX-5: prediction exclusion policy**~~ **CLOSED WON'T-DO (2026-08-27)**
  - **Decision: do not reverse D030 §3b.** T4 measured **n=1 across 2,724 eligibility checks**, and
    that single case behaved correctly (`prediction` + `certainty: uncertain` → not excluded → full
    pipeline → `unsupported`, the right outcome for an unfalsifiable claim with no fixed timeframe).
  - Reversing a documented ADR policy on n=1 is precisely the speculative change this spec exists to
    prevent — D030 §3n killed 4 `subject_entity` fixes on exactly that reasoning. It would also risk
    excluding dated-but-checkable claims ("will report earnings on October 15").
  - **Reopen if** `prediction` classification volume rises materially, or an actual harmful case
    appears. No code, no ADR reversal. Original task terms retained below for that reopening.

  - Acceptance: `isEligibilityExcluded` excludes `prediction` regardless of `certainty` — **only if
    T4 cleared it**. D030 §3b updated to record the reversal and its evidence.
  - Verify: `npx vitest run`; golden set N≥5 confirming no checkable claim became excluded (SC-5).
  - Files: `src/orchestrators/grounnel/claim-eligibility.ts`, `docs/decisions/030-*.md`
  - Depends on: T4. **Ask first — this reverses a documented ADR policy** (spec Boundaries).

---

## Phase 4 — Research measurement (informs the deferred reworks, ships no code)

- [x] **T14 — MEASURE-4: reranker source-authority bias**
  - Acceptance: across all persisted `grounnel_rerank_decisions`, answer the **counterfactual**, not
    just a correlation (review finding): *on how many claims would an authority feature have changed
    which passages VERIFY actually received?* Recompute ranking with a domain-authority term added,
    and count the claims whose top-`MAX_VERIFY_PASSAGES` set changes. A correlation between domain
    type and rank is not decision-relevant on its own — a systematic bias that never flips the
    selected set costs nothing. Report with N and an explicit statement of what the sample can and
    cannot support.
  - Verify: written number in D032 or a new ADR section (SC-7). Zero API cost — reads persisted rows.
  - Files: `scratchpad/` script (untracked).
  - Blocks: any future R3 work. **Runs before R3 by D032 §5's ordering correction** — if rerank is
    systematically mis-ranking, an unknown share of "VERIFY interpretation failure" is really
    "VERIFY was handed the wrong passage", which bounds what R3 is responsible for.
  - Note: characterisation only. Changing the reranker is a separate decision, not this task.
  - **Result (2026-08-26, D032 §3j): 66/881 flippable claims (7.5%), 66/3874 of all claims (1.7%).
    Bounded, non-trivial — doesn't kill or confirm R3, gives it a real number instead of one
    anecdote.** First-pass measurement (85%) was a bug — merged separate escalation-retry
    invocations together; caught and fixed before being recorded.

---

## Phase 5 — Close-out

- [x] **T9 — Align the eval harness with the ratified contract**
  - Acceptance: scoring reflects T1's decision; the contract is stated in the golden set's own
    documentation so a future reviewer applies the same rubric.
  - Verify: re-score run `c94d2954` under the ratified contract; the number matches D032 §2's table
    for the chosen contract. Satisfies SC-6.
  - Files: `src/evaluation/`, `evaluations/golden/grounnel/`
  - Depends on: T1.
  - **Result (2026-08-27): done, no scoring-code change needed** — D032 §2 already established
    `GrounnelExtractService` implements Contract A; T9's remaining work was documentation debt.
    Added an "Extraction contract" section to `evaluations/golden/grounnel/README.md` stating
    Contract A verbatim, why B was rejected, and why the golden set's own cases never actually
    exercise the distinction (each is a single current assertion). **Re-score check**: confirmed
    directly against Postgres that run `c94d2954` has exactly 44 claims (matches D032 §2's stated
    denominator). The 34-correct numerator is D032 §2's own hand-verified figure (each claim checked
    against real-world facts) — not re-derived here, since doing so would mean re-verifying 44
    external facts by hand, out of proportion to this close-out task; the denominator match is the
    one fact objectively checkable from stored data alone, and it holds.

- [x] **T16 — Frontend: style the `excluded` verdict**
  - Acceptance: `VERDICT_HIGHLIGHT_CLASS`/`VERDICT_DOT_CLASS` in `verdictStyle.ts` handle `excluded`;
    a UI decision made for what it looks like to a user (distinct from `unverifiable`'s `bg-info`).
  - Verify: manual check — an excluded claim renders distinctly, not unstyled/undefined.
  - Files: `biassemble/frontend/src/lib/verdictStyle.ts`, `biassemble/frontend/src/types/grounnel.ts`
  - Depends on: T5 (the enum value must exist first). **Different repo — out of this spec's own
    scope, tracked here only so it isn't lost** (D032 §7 Q3).
  - **Result (2026-08-27, `biassemble` repo): done.** Chose a hollow/outlined treatment rather than a
    new colour token — the repo's own 2026-08-16 note records that an outlined variant "reads as no
    info", which is wrong for "not located" but exactly right for "never checked". Highlight sets an
    explicit `bg-base-100` because `<mark>`'s UA default is yellow (a trap `FAILED_STYLE` already
    documents). Icon `—`, label "Not checked". Also added `VERDICT_LABEL` to `verdictStyle.ts`:
    `GrounnelProgress` had been falling back to the raw enum string, so the same claim would have
    read "Not checked" in the article but "excluded" on the progress dot — the latter reading as if
    the user's text had been rejected. Verified: `tsc` + eslint clean, production build succeeds, and
    the built CSS was grepped to confirm all six new Tailwind utilities actually emitted (this file's
    own comment warns that a missing class fails silently).
  - **`/code-review medium` (3 finder angles + verification) found 3 issues, all fixed**: the raw-enum
    progress label above; the `isFallback` "the claim actually checked here was…" copy contradicting
    the new "wasn't checked" note in the same tooltip *and* in the `sr-only` text (now gated behind
    `!notChecked`); and dev-mock only ever emitting `verdict: "supported"`, which made the entire new
    rendering path unreachable without spending live API quota (mock now emits an `excluded` claim
    too, with a test asserting the mock still satisfies the real Zod contract). A fourth candidate —
    the "Searched, found nothing" copy co-firing with "wasn't checked" — was **refuted**:
    `writeExcludedClaim` is the sole writer of `excluded` and hardcodes `sources: []`/`citations: []`,
    so its `sources.length > 0` precondition is structurally unreachable.

- [x] **T19 — Backend contract: `excluded` 502s the entire status poll** ⚠ **found live, not specced**
  - `biassemble/backend`'s `grounnelClaimSchema.verdict` is a **runtime Zod enum** that lacked
    `excluded`. `GET /api/grounnel/status/[id]` → `getCore` → `parseJsonFromAi` → `safeParse` →
    **throws** `aiParseError` (502); it does not degrade. So a single `excluded` claim failed the
    whole poll — every claim in the run, not just that one — and Core has been shipping `excluded` to
    production since 2026-08-26. Trigger is any opinion/personal sentence, which is common in real
    user text (g18 is literally the user report that motivated the feature).
  - **Fixed 2026-08-27** by adding `excluded` to the enum, plus `backend/tests/unit/grounnel-contracts.test.ts`
    guarding verdict parity with Core (accepts all 6, still rejects an unknown value) — the failure
    mode is whole-response, so it warrants a test even under a lean test policy.
  - **Caveat:** the code path was verified end to end in source; *which build is actually deployed*
    to the backend's production was not. **Needs a deploy — highest-priority one outstanding.**
  - Found while tracing `ClaimVerdict` consumers for T16 — i.e. by the cross-file angle of the review,
    not by the task itself.

- [x] **T17 — Fix `SELECTOR_RE_G` matching a sequence word inside a hyphenated compound**
  - Acceptance: `\b(first|second|...|tenth)\b` no longer matches "second" in "12-second",
    "third" in "one-third", etc. — a word boundary next to a hyphen currently reads either side as
    a standalone word. Candidate scope: exclude a match immediately preceded by `\d+-`.
  - Verify: the exact g23 repro (D032 §10) — `applyReasonOrdinalGate` must no longer force
    `contradicted` on "The Wright brothers' first successful powered flight lasted 12 seconds"
    against a reason mentioning "the Wright brothers' 12-second flight." Simulate against historical
    `reason_ordinal`/`subject_entity`/any other `SELECTOR_RE_G` consumer's firings first (D030 §3n) —
    this regex is shared infrastructure (`instance-selector.ts`), not gate-local.
  - Files: `src/lib/instance-selector.ts`
  - **Found 2026-08-26 during T12's SC-5 regression run — real, live, false-accusation-producing,
    and independent of T12** (confirmed: T12's negation guard did not fire on the failing case).
    Not part of this spec's original scope; not blocking T12's completion. Same class of bug as
    D030 §3k's freeze was written to prevent recurrence of, but a genuinely new mechanism
    (tokenization, not phrasing) — likely needs its own unfreeze/scope decision before starting.
  - **Result (2026-08-27): done.** Added a negative lookbehind (`(?:\d+|one|...|ten)-`) to
    `SELECTOR_RE_G` — rejects a sequence word immediately preceded by a numeral/spelled-number +
    hyphen (covers both examples in this task's acceptance text: "12-second", "one-third").
    **Simulated first (D030 §3n):** found the exact "12-second"/"12-flight-duration" phrasing in 3
    historical claims' reasons; confirmed one (the real g23 claim) had `reason_ordinal` fire and
    force `contradicted` — matches D032 §10 exactly. The other two didn't fire (context-dependent,
    not investigated further — not needed to confirm the fix is safe, since the fix only removes
    matches that were never legitimate selectors). New tests: `instance-selector.test.ts` (4 cases —
    digit compound, spelled-number compound, a real ordinal still resolving alongside a compound, and
    the compound not creating a competing selector) and `gates.test.ts` (the exact g23 reproduction,
    plus a control confirming a genuine competing ordinal still fires when a compound is also
    present). `/code-review medium` — 1 convention finding (an over-length test comment), fixed. 84
    files / 1224 tests pass, `tsc` clean.
  - **Live-verified 2026-08-27 (deployed): PASS.** g23 re-run at N=5 post-deploy: **6/6 `supported`,
    0 `contradicted`**, and `reason_ordinal` abstained on 9/9 firings — i.e. the gate no longer reads
    "second" out of "12-second". Pre-fix this case produced a real `contradicted` false accusation on
    a true claim (a Cardinal Rule violation). Closed.
  - **Regression check on the same deploy (D030 §3n):** replayed all **25** historical g17 catches
    (every case where `reason_ordinal` legitimately fired) through the post-T17 code — **25/25 still
    fire, 0 regressions.** The lookbehind only removes matches that were never valid selectors.

- [x] **T18 — Resolve Postgres/Redis reason-mirroring contradiction (D023 §7 vs. current code)**
  - Acceptance: either D023 §7 and T6b's verify step are amended to state that `grounnel_claims.reason`
    is intentionally VERIFY's raw text (analytics/replay-friendly, not a mirror), or the 3 write sites
    in `pipeline.service.ts` (`processVerifyResults`, `reconcileContradictedVerdicts`,
    `guardEscalatedContradictionReversals`) are changed to persist `userFacingReason` to `historyStore`
    to match D023 §7's original "durable mirror" wording.
  - Verify: whichever direction is chosen, `grounnel_claims.reason` and D023 §7's own words agree with
    each other.
  - Files: `docs/decisions/023-*.md` §7, or `src/orchestrators/grounnel/pipeline.service.ts`.
  - **Found 2026-08-27 during T6/T6b's live SC-1 verification** — not blocking, ask first (documentation
    vs. behaviour change, user's call).
  - **Result (2026-08-27): Option A chosen (document reality, no code change)** — preserves D030 §3n's
    replay technique, the one that found T12's bug. D023 §7 amended: Postgres mirrors verdict/evidence/
    confidence/everything else, `reason` is the one deliberate exception (kept as VERIFY's raw text).
    T6b's verify step reworded to point at the live API response, not `grounnel_claims`, for checking
    the subject_entity label.

- [x] **T15 — Record every measurement outcome**
  - Acceptance: MEASURE-1..4 each have a written result with N stated. A measurement that changed no
    decision says so explicitly.
  - Verify: D032 (or a successor ADR) contains all four. Satisfies SC-7.
  - Files: `docs/decisions/`
  - Depends on: T3, T4, T10, T14.
  - **Result (2026-08-27): already satisfied, no new writing needed.** All four measurements were
    recorded with N stated as each was run: MEASURE-1/§3g (N=10, T8 cancelled), MEASURE-2/§3h (n=1,
    T13 explicitly left gated — "not evidence for reversing D030 §3b, just evidence the decision is
    low-stakes"), MEASURE-3/§3k (N=50, T11/T12 elevated in priority), MEASURE-4/§3j (7.5%/1.7%,
    "doesn't kill or confirm R3" stated explicitly). SC-7 closed.

---

## Dependency graph

```
T1 ✅ (contract=A) ─────────────────────────► T9 ✅ ──► SC-6 ✅
T2 ✅ (frontend=no) ─► T5 ✅ ──► T6 ✅ ─────────────► SC-1 (excluded half ✅ live; subject_entity half inconclusive live)
                       ├──► T6b ✅ (subject_entity labelling) ──► SC-1 ──► T18 (Postgres/ADR gap found)
                       ├──► T16 ✅ (frontend styling, other repo)
                       └──► T19 ✅ (backend Zod enum — 502 on excluded; found by T16's review)
T7 ✅ (reason text, no gate) ──────────────────────► SC-2
T3 ✅ (MEASURE-1: does not reproduce) ─► T8 ❌ CANCELLED ─► SC-4 (satisfied without T8)
T4 ✅ (MEASURE-2: n=1, inconclusive) ──► T13 (stays gated)
T10 ✅ (MEASURE-3) ─► T11 ✅ ──► T12 ✅ ────────────► SC-3 ✅ (50/50 live-verified)
T14 ✅ (MEASURE-4) ─► [future R3 decision]
T3,T4,T10,T14 ───► T15 ✅ ───────────────────────────► SC-7 ✅
all fixes ────────────────────────────────────────► SC-5 (targeted subset clean; full set open)
```

**Phase 0, Phase 3's core fixes, T9, and T15 are all closed** (2026-08-27). Remaining open:
**T13 closed won't-do** (2026-08-27 — n=1 does not justify reversing D030 §3b; amendment recorded
there) and **T20 decided** (g17 stays RED at `minCorrectRate: 1.0`; the measured ~33% is a
measurement, not a revised requirement — `reason_ordinal` re-frozen, D030 §3k). **T16**/**T17**/**T18**/**T19** are closed; T17 is
live-verified on the 2026-08-27 core deploy. **T19 still needs a `biassemble` deploy** — it is a
live 502 on any run containing an excluded claim, reproduced A/B against production Core. Live verification: **SC-1**'s `excluded` half
is confirmed live (2026-08-27), and its `subject_entity`-labelling half is now closed too — via a
64-claim replay against real production data rather than a live run. **SC-1 fully closed.** **SC-5** (full 28-case regression, not just the targeted subset) remains open. Of the spec's
7 success criteria, **SC-2, SC-3, SC-6, SC-7 are fully closed; SC-1 half-closed; SC-4 satisfied
without code; SC-5 open.**

## Notes

- **Cancellation is a valid outcome.** T8, T11/T12, and T13 each have a named condition under which
  they are cancelled rather than implemented. That is the design, not a failure — D030 §3n's four
  refuted `subject_entity` fixes are why this spec gates behaviour changes behind measurement.
- **Cost.** T3 ≈ 120 Gemini calls; T10 ≈ 300–500; regression runs (SC-5) ≈ 110 per N=5 pass over 22
  cases. T4 and T14 are free (persisted telemetry only). Full golden set at N=5 is roughly a day's
  quota — see D030 §3k's cost table before batching runs.
- **Nothing here is committed without an explicit request** (CLAUDE.md).
