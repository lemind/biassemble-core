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

- [ ] **T7 — FIX-2: enriched `reason` for no-evidence verdicts**
  - Acceptance: `NO_EVIDENCE_REASON` (and the `rewriteUngroundedAffirmativeReason` path) states both
    that no supporting evidence was found *and* that this is not a finding of falsehood. No verdict
    logic changes.
  - Verify: live smoke on a claim known to return no evidence; read the stored `reason`. Satisfies
    SC-2.
  - Files: `src/orchestrators/grounnel/pipeline.service.ts`, possibly `gates.ts`
  - Depends on: T2 only if the wording turns out to be frontend-owned (spec Open Question 4);
    otherwise none.
  - Note: this task *replaces* D032's R1. Do not let it grow into a refutation search.

---

## Phase 2 — Contract fix (needs T2)

- [ ] **T5 — FIX-1a: add `excluded` to the verdict contract**
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

- [ ] **T6 — FIX-1b: write `excluded` from the eligibility path**
  - Acceptance: `writeExcludedClaim` persists `excluded`, not `unverifiable`. The distinct per-
    category `reason` strings are retained.
  - Verify: live smoke with one opinion claim + one genuinely-unverifiable claim; confirm the two
    are distinguishable in the API response and in `grounnel_claims`. Satisfies SC-1.
  - Files: `src/orchestrators/grounnel/extract.service.ts`
  - Depends on: T5.
  - Scope note (D032 §3f): this covers **41.9%** of historical `unverifiable` claims. It does not
    address the 24.9% produced by `subject_entity` downgrades — see T6b.

- [ ] **T6b — Label `subject_entity` downgrades distinctly**
  - Acceptance: a claim downgraded to `unverifiable` by the `subject_entity` gate is distinguishable
    — in `grounnel_claims` and/or the API — from one that genuinely could not be verified. Minimum
    viable form: a distinct `reason` string; fuller form: its own verdict/status value.
  - Verify: query the three §3f causes and confirm each is separable without joining
    `grounnel_gate_events`. Extends SC-1.
  - Files: `src/orchestrators/grounnel/pipeline-gate-chain.ts` or `pipeline.service.ts`'s write path
  - Depends on: T5 (if it takes an enum value) — otherwise none.
  - Note: **does not change gate behaviour.** D030 §3m's decision to keep `subject_entity` as-is
    stands; this only stops its downgrades from masquerading as genuine verification failures. That
    24.9% slice is the same population D030 §3m measured as ~25–30 wrongly-suppressed true claims
    per 1,000 — labelling it makes that cost visible in production instead of only in archaeology.

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
  - **Blocked on a decision: `reason_ordinal` is FROZEN (D030 §3m) and this design requires
    unfreezing it.** Must be taken before T12 starts.

- [ ] **T12 — FIX-3b: implement the negation-scope guard**
  - Acceptance: `reason_year`, `reason_ordinal`, and `reason_consistency` abstain when the compared
    claim token sits inside a negation scope. No new gate is added; no verdict-escalation path is
    added. Unit tests cover the negation predicate and each gate's abstain path (pure logic —
    in-scope per CLAUDE.md, and `gates.ts` is the one place kept exhaustive).
  - Verify: the 12 captured T10 repetitions no longer produce `contradicted`/`unsupported`;
    simulation shows the gates' legitimate historical firings are not gutted (D030 §3n);
    T10's fixtures reach `supported` in ≥8/10 (SC-3); full golden set N≥5 for regression (SC-5).
  - Files: `src/orchestrators/grounnel/gates-reason-grounded.ts`, `gates.ts`,
    `tests/unit/orchestrators/grounnel/gates.test.ts`
  - Depends on: T11 (done) + the `reason_ordinal` unfreeze decision.

- [ ] **T13 — FIX-5: prediction exclusion policy**
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

- [ ] **T9 — Align the eval harness with the ratified contract**
  - Acceptance: scoring reflects T1's decision; the contract is stated in the golden set's own
    documentation so a future reviewer applies the same rubric.
  - Verify: re-score run `c94d2954` under the ratified contract; the number matches D032 §2's table
    for the chosen contract. Satisfies SC-6.
  - Files: `src/evaluation/`, `evaluations/golden/grounnel/`
  - Depends on: T1.

- [ ] **T16 — Frontend: style the `excluded` verdict**
  - Acceptance: `VERDICT_HIGHLIGHT_CLASS`/`VERDICT_DOT_CLASS` in `verdictStyle.ts` handle `excluded`;
    a UI decision made for what it looks like to a user (distinct from `unverifiable`'s `bg-info`).
  - Verify: manual check — an excluded claim renders distinctly, not unstyled/undefined.
  - Files: `biassemble/frontend/src/lib/verdictStyle.ts`, `biassemble/frontend/src/types/grounnel.ts`
  - Depends on: T5 (the enum value must exist first). **Different repo — out of this spec's own
    scope, tracked here only so it isn't lost** (D032 §7 Q3).

- [ ] **T15 — Record every measurement outcome**
  - Acceptance: MEASURE-1..4 each have a written result with N stated. A measurement that changed no
    decision says so explicitly.
  - Verify: D032 (or a successor ADR) contains all four. Satisfies SC-7.
  - Files: `docs/decisions/`
  - Depends on: T3, T4, T10, T14.

---

## Dependency graph

```
T1 ✅ (contract=A) ─────────────────────────► T9 ──► SC-6
T2 ✅ (frontend=no) ─► T5 ──► T6 ──────────────────► SC-1
                       ├──► T6b (subject_entity labelling) ──► SC-1
                       └──► T16 (frontend styling, other repo)
T7 (reason text, no gate) ────────────────────────► SC-2
T3 ✅ (MEASURE-1: does not reproduce) ─► T8 ❌ CANCELLED ─► SC-4 (satisfied without T8)
T4 ✅ (MEASURE-2: n=1, inconclusive) ──► T13 (stays gated)
T10 (MEASURE-3) ─► T11 ──► T12 ───────────────────► SC-3
T14 (MEASURE-4) ─► [future R3 decision]
T3,T4,T10,T14 ───► T15 ───────────────────────────► SC-7
all fixes ────────────────────────────────────────► SC-5 (regression, N≥5)
```

**Phase 0 is closed** (2026-08-26): T1, T2, T3, T4 all answered/measured. T8 cancelled as a direct
result. **Now unblocked and parallelisable:** T5 (→ T6, T6b), T7, T9, T10 (→ T11 → T12), T14.
**Start with T7** if any code is to be written today: it is the only fix with no gate.

## Notes

- **Cancellation is a valid outcome.** T8, T11/T12, and T13 each have a named condition under which
  they are cancelled rather than implemented. That is the design, not a failure — D030 §3n's four
  refuted `subject_entity` fixes are why this spec gates behaviour changes behind measurement.
- **Cost.** T3 ≈ 120 Gemini calls; T10 ≈ 300–500; regression runs (SC-5) ≈ 110 per N=5 pass over 22
  cases. T4 and T14 are free (persisted telemetry only). Full golden set at N=5 is roughly a day's
  quota — see D030 §3k's cost table before batching runs.
- **Nothing here is committed without an explicit request** (CLAUDE.md).
