---

description: "Task list for Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering"
---

# Tasks: Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering

**Input**: Design documents from `/specs/012-grounnel-ordinal-eligibility-gates/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, and
[D030](../../docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md) — all
complete and through two rounds of design review, plus a review pass on this task list itself
(corrected two dependency-graph gaps that would have let live deployment happen before the held-out
safety checks passed — see Notes).

**Tests**: Included. The design docs (quickstart.md's build order, D030 §3a, data-model.md §1/§2)
treat "validated offline before wired in" as a hard sequencing requirement, not an optional
nice-to-have — the task breakdown below preserves that ordering exactly rather than collapsing it
into a single "implement + test" step.

**Organization**: Tasks are grouped by user story (US1 = P1 ordinal gate, US2 = P2 eligibility
filter) so each can be implemented, tested, and shipped independently. Neither has a functional
dependency on the other, though both add fixtures under the shared
`evaluations/golden/grounnel/` directory — parallel implementation is fine, just expect a trivial
merge in that one shared file if both land at once.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 or US2
- File paths are exact, taken from plan.md's Project Structure and data-model.md

---

## Phase 1: Setup

**Purpose**: Confirm no new project scaffolding is needed — this is an addition to an existing,
established service, not a new project.

- [x] T001 [P] Confirm no new dependencies are required — plan.md's Technical Context lists only the
      existing stack (TypeScript 5, Fastify 5, Drizzle ORM, the existing Gemini provider adapter in
      `src/providers/`); no `package.json` changes.
      **Done**: verified directly against `package.json` — `fastify@5.8.5`, `zod@4.4.3`,
      `drizzle-orm@0.40.0`, `@google/generative-ai@0.21.0` are all already present. No dependency
      changes needed for either user story.

---

## Phase 2: Foundational

**Purpose**: N/A for this feature. Neither user story is a functional prerequisite for the other —
`applyReasonOrdinalGate` (US1) and `classifyClaimVerifiability` (US2) touch disjoint source files and
neither calls into the other (spec.md Assumptions; plan.md Structure Decision). Both can start
immediately after Phase 1.

**Confirmed empty** — re-checked during implementation, not just at planning time: no shared
scaffolding, config, or infrastructure change is required before either user story can start. Zero
tasks in this phase, intentionally.

---

## Phase 3: User Story 1 - Catch sequence-position contradictions before they're reported as confirmed (Priority: P1) 🎯 MVP

**Goal**: A claim about a specific position in a sequence (e.g. "the first flight") is never stored
as `supported`/`partially_supported` when VERIFY's own explanation names a different position for
the same fact.

**Independent Test**: Submit an article containing such a claim/evidence mismatch; confirm the
stored verdict is not `supported` or `partially_supported`. Fully testable via unit tests alone —
`applyReasonOrdinalGate` is a pure function.

### Tests for User Story 1 ⚠️

> Write these FIRST — they must fail (the function doesn't exist yet) before implementation.

- [ ] T002 [P] [US1] Write `applyReasonOrdinalGate` unit tests in
      `tests/unit/orchestrators/grounnel/gates.test.ts` covering the full validation matrix from
      `data-model.md` §1: the Wright-brothers regression fire case, a second/third-attempt fire case,
      a discourse-enumeration abstain case ("First,... Second,..."), an ambiguous-mention abstain
      case, a same-value-different-position no-fire case, a same-anchor-different-measurement abstain
      case, a discourse-ordinal-mixed-with-a-real-one fire case, a modifier-between-ordinal-and-anchor
      fire case ("the third unsuccessful attempt"), a negation fire case, plus a full re-run of every
      existing `applyReasonYearGate` golden case as a regression guard (the two gates must not
      interfere). The gate's correctness rests on structural pattern-matching (anchor + explicit
      competing ordinal), not on any claim that `reason` is generally "true" — cases should exercise
      that structural condition directly, not just plausible-sounding text.

### Implementation for User Story 1

- [ ] T003 [US1] Implement `applyReasonOrdinalGate` in `src/orchestrators/grounnel/gates.ts` per
      `data-model.md` §1 — the explicit anchor definition (single unambiguous noun phrase or
      abstain), the abstention short-circuits in their stated order, and the override-direction
      semantics (forces `contradicted` from any state except `contradicted`/`unverifiable`; never
      promotes toward `supported`). Deliberately **unwired** — no call site yet. (depends on T002)
- [ ] T004 [US1] Run `gates.test.ts`; confirm 100% pass on the validation matrix with zero false
      positives on every "must NOT fire"/"must abstain" row, and zero regression on the existing
      `applyReasonYearGate` golden cases. This establishes **deterministic regression correctness on
      the known matrix only** — it is not evidence of generalization; T009 establishes that
      separately, on held-out data. **Gate**: do not proceed to T005 until this passes — per
      quickstart.md's build order and T068's own precedent (tasks.md Phase 35), wiring in is a
      separate, later decision, not part of the same change. (depends on T003)
- [ ] T005 [US1] Wire `applyReasonOrdinalGate` into `runGateChain` in
      `src/orchestrators/grounnel/pipeline.service.ts`, positioned after the `reason_year` gate.
      (depends on T004)
- [ ] T006 [US1] Add integration coverage in
      `tests/unit/orchestrators/grounnel/pipeline-service.test.ts` proving `runGateChain` actually
      invokes `applyReasonOrdinalGate` at the right point in sequence — one case where it fires and
      changes the final verdict/gate-event list, one case where it correctly abstains and leaves
      earlier gates' results untouched. Unit tests alone (T002) only prove the function is correct in
      isolation, not that the pipeline wires it up correctly (wrong argument, wrong order, dropped
      result). (depends on T005)
- [ ] T007 [US1] Add `"reason_ordinal"` to the persistence gate-name/reason-code representation,
      following the same pattern T069 used for `reason_year` — but **verify the actual DB
      representation first, don't assume**: inspect how `reason_year` is actually stored (check
      `src/persistence/grounnel-gate-event-store.ts`, `src/persistence/types.ts`, `src/db/schema.ts`,
      `src/db/queries.ts` for whether it's a free-text/varchar with an app-level union — no migration
      needed — or a native Postgres `enum` — needs an additive `ALTER TYPE ... ADD VALUE` migration —
      per `data-model.md` §3's own hedge) and make the minimum corresponding change. This is a
      DB-facing change independent of T006's in-memory integration test — both branch from T005 and
      can run in parallel rather than serialized. (depends on T005)
- [ ] T008 [P] [US1] Add an ordinal golden-set case restoring the intent of the removed
      `g15-wright-brothers-ordinal` to `evaluations/golden/grounnel/live-eval-golden-set.json` (now
      exercising the gate, not a prompt section). Doesn't need persistence changes to be meaningful —
      only needs the gate wired in. (depends on T005)
- [ ] T009 [P] [US1] Measure the false-downgrade rate on a held-out set of correctly-supported
      claims not used in T002's fixture set (spec.md SC-002) — hard requirement of zero. **Also
      report the contradiction-detection recall rate on a held-out set of genuine contradiction
      cases** (SC-002's other required measurement — not just the safety metric): a gate that never
      fires has a trivially perfect 0% false-downgrade rate while being useless, the same reasoning
      already applied to US2's T016. Can be measured directly against the pure function (no wiring
      needed). (depends on T004)
- [ ] T010 [US1] Live re-verification: with the gate deployed, re-run the original Wright-brothers
      regression test article twice against the live API; confirm the claim no longer lands on
      `supported`/`partially_supported`. Query `grounnel_gate_events` directly (same method used to
      verify T069) to confirm `reason_ordinal` fires on the regression case and does not fire on
      unrelated claims in the same run. **Do not perform this until T007, T008, and T009 have all
      passed** — this is the live/production check and must not happen before both the
      integration-correctness and held-out-safety work is done. (depends on T007, T008, T009)

**Checkpoint**: User Story 1 is fully functional, independently deployable, and live-verified.

---

## Phase 4: User Story 2 - Distinguish "can never be checked" from "checked and found nothing" (Priority: P2)

**Goal**: A claim with no reasonable way to be externally verified (private circumstance, opinion,
vague prediction) is labeled distinctly from a claim that was searched and came up empty.

**Independent Test**: Submit an article containing a private first-person statement; confirm it's
labeled non-checkable rather than `unsupported`. Independent of User Story 1 — no shared files, no
ordering dependency between them.

### Tests for User Story 2 ⚠️

> Write these FIRST — they must fail (the function doesn't exist yet) before implementation.

- [ ] T011 [P] [US2] Write `classifyClaimVerifiability` orchestration unit tests (mocked provider
      responses) in `tests/unit/orchestrators/grounnel/claim-eligibility.test.ts`, covering the
      Policy table in `data-model.md` §2: `category === "checkable"` → search; non-checkable category
      with `certainty: "clear"` → excluded; `certainty: "uncertain"` (any category) → search. **Also
      cover failure modes explicitly**: a malformed/schema-invalid response, a provider error, and a
      timeout must all be treated as `checkable` and proceed to normal search — never treated as
      grounds for exclusion (this is the single most important correctness property of this feature:
      false exclusion is the dangerous failure direction, so any failure must fail open). This tests
      wiring only, not classification quality — see T016.
- [ ] T012 [P] [US2] Create the `classifyClaimVerifiability` prompt at
      `src/prompts/grounnel/eligibility/system.json` — input shape (`claimText`, `sourceExcerpt`),
      output shape (`category`, `certainty`, `reason`) per `data-model.md` §2. Must instruct the
      model precisely on two points: (1) `personal` names a speaker-relative *category*, not an
      automatic exclusion — a first-person claim about a well-documented public figure is checkable;
      (2) `certainty: "clear"` must reflect confidence that the claim is **not reasonably externally
      verifiable specifically** — not mere confidence about which category label fits. A claim must
      not receive `category: "personal"` + `certainty: "clear"` just because it's phrased in first
      person; the model needs to reason about verifiability, not grammatical person.

### Implementation for User Story 2

- [ ] T013 [US2] Implement `classifyClaimVerifiability` in new file
      `src/orchestrators/grounnel/claim-eligibility.ts`. **Must fail open**: any LLM error, timeout,
      provider error, or invalid/malformed structured output results in treating the claim as
      `checkable` and proceeding to normal search — never as grounds for exclusion. (depends on T011,
      T012)
- [ ] T014 [US2] Wire into `src/orchestrators/grounnel/extract.service.ts`, positioned **after** the
      existing `isOpinionClaim` call, not ahead of it — `classifyClaimVerifiability` must only
      evaluate claims the regex filter did not already exclude (cost optimization; no correctness
      change — see `research.md` Decision 4). (depends on T013)
- [ ] T015 [P] [US2] Add eligibility golden-set cases to `evaluations/golden/grounnel/` — true
      exclusions (personal circumstance, opinion, vague prediction) and hard negatives (a quoted
      first-person claim, a checkable personal claim about a public figure, a scheduled/dated future
      event) per `data-model.md` §2's Validation set. For the quoted-attribution hard negative
      (`"I discovered X in 1928," said Fleming`), explicitly verify that the `sourceExcerpt` EXTRACT
      actually produces for this claim includes the attribution clause — if it doesn't, the
      classifier has no way to make the correct call regardless of prompt quality, and that's a real
      gap to surface now rather than discover during live eval. (depends on T013)
- [ ] T016 [US2] Run `pnpm eval:grounnel` (live/golden-set evaluation) to validate actual classifier
      *behavior* — distinct from T011's mocked orchestration tests, which only prove the pipeline
      wires a given classification correctly, not that the model classifies correctly (plan.md
      Testing, three-layer split). Report **both** metrics, not just safety: false-exclusion rate
      (safety) and non-checkable-detection recall (utility) — a classifier that calls everything
      "checkable" has a perfect 0% false-exclusion rate and is also useless; recall makes that
      failure mode visible. (depends on T014, T015)
- [ ] T017 [P] [US2] Measure the false-exclusion rate on a held-out set of checkable claims not used
      in T015's fixture set (spec.md SC-004 — the primary safety metric for this check) — hard
      requirement of zero. Broaden the set beyond first-person phrasing specifically: include
      third-person, attributed, and superficially-personal-but-checkable claims too, so this doesn't
      end up only proving the classifier is a fancier `\bI\b` regex. (depends on T014)
- [ ] T018 [US2] Live re-verification: with the classifier deployed, re-run the original "I was in
      need of a new laptop" report; confirm the claim is labeled distinctly from a checked-and-empty
      (`unsupported`) result. **Do not perform this until T015, T016, and T017 have all passed** —
      this is the live/production check and must not happen before both the model-behavior evaluation
      and the held-out safety measurement are done. (depends on T015, T016, T017)

**Checkpoint**: User Story 2 is fully functional, independently deployable, and live-verified —
independently of whether User Story 1 has shipped.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T019 [P] Confirm `verify/system.json` (`MULTIPLE SOURCES` section) is untouched — this is a
      design-invariant check, not cosmetic polish: this feature deliberately contains the ordinal
      bug's symptom downstream (D030 §2) instead of touching the prompt, and this confirms that
      choice wasn't accidentally violated (D030 §4).
- [ ] T020 [P] Record the current test-failure baseline (`pnpm test:run`), then run `pnpm typecheck`
      and the full suite again after this feature's changes — confirm no *new* failures beyond that
      recorded baseline. Don't hard-code "16 pre-existing failures" from `CLAUDE.md` as a fixed
      target; that count can go stale as the codebase evolves independently of this feature.
- [ ] T021 Run `/code-review` at this repo's usual effort level across the full diff before merge
      (plan.md Constitution Check references `code-review-and-quality`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Empty — nothing blocks either user story.
- **User Stories (Phase 3, 4)**: Both can start immediately after Phase 1. Fully independent of each
  other — implement in either order, or in parallel.
- **Polish (Phase 5)**: Depends on whichever user stories are being shipped in this pass.

### Within Each User Story

- **US1**: T002 (tests, must fail) → T003 (implement, unwired) → T004 (validate, gate) → T005 (wire
  in) → then T006 (integration test), T007 (persistence), and T008 (golden case) all branch off T005
  and can run in parallel (no data dependency between them); T009 (held-out metric) branches off T004
  directly. **T010 (live re-verification) requires T007, T008, AND T009 — all three** — this was a
  real gap in the first draft of this task list (T010 previously only waited on persistence + golden
  case, which would have allowed a live deploy before the held-out safety check ran).
- **US2**: T011/T012 (tests + prompt, parallel) → T013 (implement, fail-open) → T014 (wire in, after
  the existing regex). T015 (golden set) and T017 (held-out metric) both branch off T014 and run in
  parallel; T016 (live/golden eval) additionally needs T015. **T018 (live re-verification) requires
  T015, T016, AND T017 — all three** — same class of gap as US1's T010, now fixed.

### Parallel Opportunities

- T001 has nothing to block on.
- T002 (US1 tests) and T011+T012 (US2 tests + prompt) can all run in parallel — different files,
  different stories.
- Within US1: T006, T007, and T008 can all start as soon as T005 is done, in parallel with each
  other; T009 can start as soon as T004 is done.
- Within US2: T015 and T017 can both start as soon as T014 is done.
- T019 and T020 (Polish) can run in parallel.

---

## Parallel Example: kicking off both stories at once

```bash
# After T001, launch both stories' test-writing tasks together:
Task: "Write applyReasonOrdinalGate unit tests in tests/unit/orchestrators/grounnel/gates.test.ts"
Task: "Write classifyClaimVerifiability orchestration unit tests in tests/unit/orchestrators/grounnel/claim-eligibility.test.ts"
Task: "Create the classifyClaimVerifiability prompt at src/prompts/grounnel/eligibility/system.json"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

User Story 1 is the higher-severity fix — a live, reproduced false "confirmed" verdict, the worst
class of defect this pipeline can produce (spec.md's own priority rationale). If only one story ships
this pass:

1. Complete Phase 1 (T001).
2. Complete Phase 3 (T002–T010) in full, including live re-verification — which only happens after
   T007, T008, and T009 have all passed.
3. Ship. User Story 2 is a real but lower-severity UX fix and can follow independently.

### Incremental Delivery

1. T001 → Setup done.
2. US1 (T002–T010) → test independently → live-verify (after all safety/integration checks pass) →
   ship.
3. US2 (T011–T018) → test independently → live-verify (after all safety/eval checks pass) → ship.
4. T019–T021 → final polish pass before/alongside merge.

Each story is independently shippable — neither blocks the other, and shipping one first doesn't
require reworking anything when the second follows.

---

## Notes

- Tests are written first within each story and must fail before implementation, per this repo's
  general testing discipline — but note the split for US2: T011's mocked tests only prove
  orchestration wiring, not classification quality; T016's live/golden-set run is the only task that
  actually validates the model's judgment (plan.md Testing section).
- T004 and T009 (US1) and T017 (US2) are explicit *gates*, not just checks — per the two prior failed
  attempts at this exact ordinal bug (D030 §1), skipping straight to wiring-in without validating
  offline first is the mistake this task breakdown is structured to prevent. T004/T009 specifically
  separate "correct on the known matrix" (regression) from "correct on data not used to build the
  matrix" (generalization) — the first is necessary but is not evidence of the second.
- **Fail-open is a first-class requirement for US2, not an afterthought**: T011 and T013 both call
  it out explicitly. Given this feature's own stated principle (false exclusion is worse than a
  wasted search), any failure mode in the classifier — timeout, provider error, malformed output —
  must default to `checkable`, never to exclusion.
- Commit after each task or logical group, per this repo's single-line commit convention
  (`feat|fix|chore|docs(T0XX): <short desc>`) — never commit without explicit user request.
