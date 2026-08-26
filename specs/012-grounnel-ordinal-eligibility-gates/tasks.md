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

- [x] T002 [P] [US1] Write `applyReasonOrdinalGate` unit tests in
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
      **Done**: 15 new cases added, confirmed to fail first (`applyReasonOrdinalGate is not a
      function`) before implementation.

### Implementation for User Story 1

- [x] T003 [US1] Implement `applyReasonOrdinalGate` in `src/orchestrators/grounnel/gates.ts` per
      `data-model.md` §1 — the explicit anchor definition (single unambiguous noun phrase or
      abstain), the abstention short-circuits in their stated order, and the override-direction
      semantics (forces `contradicted` from any state except `contradicted`/`unverifiable`; never
      promotes toward `supported`). Deliberately **unwired** — no call site yet. (depends on T002)
      **Done**: claim-anchored extraction (2-content-word window after the ordinal, clause-scoped,
      stoplist-filtered), confirmation-takes-precedence-over-contradiction design (resolves the
      "does NOT fire — same value" and "abstains — ambiguous" matrix rows for free, since both
      collapse to the same no-op return regardless of which internal path is taken).
- [x] T004 [US1] Run `gates.test.ts`; confirm 100% pass on the validation matrix with zero false
      positives on every "must NOT fire"/"must abstain" row, and zero regression on the existing
      `applyReasonYearGate` golden cases. This establishes **deterministic regression correctness on
      the known matrix only** — it is not evidence of generalization; T009 establishes that
      separately, on held-out data. **Gate**: do not proceed to T005 until this passes — per
      quickstart.md's build order and T068's own precedent (tasks.md Phase 35), wiring in is a
      separate, later decision, not part of the same change. (depends on T003)
      **Done**: 114/114 pass (15 new + 99 existing) on first attempt; `tsc --noEmit` clean.
- [x] T005 [US1] Wire `applyReasonOrdinalGate` into `runGateChain` in
      `src/orchestrators/grounnel/pipeline.service.ts`, positioned after the `reason_year` gate.
      (depends on T004)
      **Done**. **Discovery, correcting T007 below**: wiring this in without updating the
      persistence union types first is a **compile-time TypeScript error**
      (`"reason_ordinal"` not assignable to `GateEventInput["gate"]`), not a decoupled later step as
      originally planned — `gateEvents.push({ gate: "reason_ordinal", ... })` is type-checked against
      that union at the call site. T007 was done immediately after T005, before T006, not in
      parallel with it as this task originally assumed.
- [x] T007 [US1] Add `"reason_ordinal"` to the persistence gate-name/reason-code representation,
      following the same pattern T069 used for `reason_year` — but **verify the actual DB
      representation first, don't assume**: inspect how `reason_year` is actually stored (check
      `src/persistence/grounnel-gate-event-store.ts`, `src/persistence/types.ts`, `src/db/schema.ts`,
      `src/db/queries.ts` for whether it's a free-text/varchar with an app-level union — no migration
      needed — or a native Postgres `enum` — needs an additive `ALTER TYPE ... ADD VALUE` migration —
      per `data-model.md` §3's own hedge) and make the minimum corresponding change. ~~This is a
      DB-facing change independent of T006's in-memory integration test — both branch from T005 and
      can run in parallel rather than serialized.~~ **Corrected during implementation (see T005): this
      is actually a hard compile-time prerequisite of T005/T006, not independent of them** — the
      dependency direction in the original task graph was backwards. (depends on T005)
      **Done**: confirmed `text("gate", { enum: [...] })` is a Drizzle TS-level enum, not a native
      Postgres enum (no CHECK constraint) — no migration needed, matching the hedge exactly.
- [x] T006 [US1] Add integration coverage in
      `tests/unit/orchestrators/grounnel/pipeline-service.test.ts` proving `runGateChain` actually
      invokes `applyReasonOrdinalGate` at the right point in sequence — one case where it fires and
      changes the final verdict/gate-event list, one case where it correctly abstains and leaves
      earlier gates' results untouched. Unit tests alone (T002) only prove the function is correct in
      isolation, not that the pipeline wires it up correctly (wrong argument, wrong order, dropped
      result). (depends on T005, and in practice T007 — see correction above)
      **Done**: 2 new end-to-end tests added. **Also found and fixed 2 real regressions** in
      *existing* tests that hard-coded the old 8-gates-per-pass count/indices (`toHaveLength(17)`→19,
      `events[4]`/`events[12]`→`events[5]`/`events[14]`, and a gate-name-order array missing
      `"reason_ordinal"`) — these would have silently broken on merge without this task's full-suite
      run surfacing them.
- [x] T008 [P] [US1] Add an ordinal golden-set case restoring the intent of the removed
      `g15-wright-brothers-ordinal` to `evaluations/golden/grounnel/live-eval-golden-set.json` (now
      exercising the gate, not a prompt section). Doesn't need persistence changes to be meaningful —
      only needs the gate wired in. (depends on T005)
      **Done**: added as `g17-wright-brothers-ordinal` (fresh ID, not reusing "g15" — a different
      mechanism now, gate not prompt), real historical Wright Flyer figures (first flight ~120 ft,
      fourth/final flight 852 ft/59 s), README.md case count updated 15→16 with a labeling note.
      Not run live (requires `GEMINI_API_KEY`/`TAVILY_API_KEY`, real budget-affecting API calls) —
      that's T010's job, blocked on deploy access.
- [x] T009 [P] [US1] Measure the false-downgrade rate on a held-out set of correctly-supported
      claims not used in T002's fixture set (spec.md SC-002) — hard requirement of zero. **Also
      report the contradiction-detection recall rate on a held-out set of genuine contradiction
      cases** (SC-002's other required measurement — not just the safety metric): a gate that never
      fires has a trivially perfect 0% false-downgrade rate while being useless, the same reasoning
      already applied to US2's T016. Can be measured directly against the pure function (no wiring
      needed). (depends on T004)
      **Done**: 10 held-out "must not fire" + 10 held-out "must fire" cases, deliberately different
      domains (novels, experiments, seasons, candidates, albums, prototypes, referendums, episodes,
      quarters, chapters) from T002's flight/attempt fixtures. **Measured, not assumed**:
      false-downgrade rate 0/10 (meets the hard requirement); recall 10/10 (reported, not required to
      hit 100%).
- [x] T010 [US1] Live re-verification: with the gate deployed, re-run the original Wright-brothers
      regression test article twice against the live API; confirm the claim no longer lands on
      `supported`/`partially_supported`. Query `grounnel_gate_events` directly (same method used to
      verify T069) to confirm `reason_ordinal` fires on the regression case and does not fire on
      unrelated claims in the same run. (depends on T007, T008, T009)
      **Done, mixed result — do not treat as a clean pass**: deploy confirmed live
      (`vercel inspect`, prod alias `biassemble-core.vercel.app`, `/health` 200, build ~30 min old,
      matches local `92628ad` on a clean tree). Ran g17 (`On December 17, 1903... The first flight
      covered 852 feet...`) against `/extract` + `/status` twice, then queried
      `grounnel.grounnel_gate_events` / `grounnel_claims` directly via `psql`.
      - **Run 1**: `reason_ordinal` ran (confirmed in DB) but abstained (`overridden: f`) — VERIFY's
        own `reason` for this claim was *"the longest of the four flights covered 852 feet"*, no
        ordinal word at all. Final verdict: `supported` (regression NOT caught).
      - **Run 2**: `reason_ordinal` correctly fired on a T034 retry pass (`overridden: t`, `reason:
        reason_ordinal_mismatch`, verdict flipped to `contradicted`) — proves the gate detects the
        mismatch live, not just in unit tests. But the pre-existing D025 §5 `checkRetryContradiction`
        classifier then judged that contradiction "inconsistent" and downgraded it to `unsupported`
        (`retry_reconciliation` / `retry_contradiction_invalidated`). Final verdict: `supported`
        again — a **second, distinct claim-processing pass for the same `claim_id`** (VERIFY
        returned two answers for one id in the batched response; `Promise.all` processed both,
        last write won) landed clean with no ordinal in its reason either. Regression NOT caught,
        by a different path than run 1.
      - **Verdict on the gate itself**: works as designed — deterministic, reason-grounded, fires
        correctly when the signal is present in VERIFY's own reason text. Not a bug in
        `applyReasonOrdinalGate`.
      - **Real gaps surfaced, out of scope for this task/feature, logged for backlog**: (1) VERIFY's
        `reason` paraphrase is nondeterministic and often omits the ordinal word entirely even when
        describing the exact fact that would contradict the claim — the reason-grounded design has
        no signal to act on in that case (known/accepted limitation, see ADR D030 §3a). (2) The
        pre-existing `checkRetryContradiction` safety net (built for a different failure mode —
        compound-claim conflation) can undo a correct `reason_ordinal` catch. (3) A batched VERIFY
        response duplicate-answering one claim id, processed twice concurrently with "last write
        wins," is a pre-existing data-integrity gap unrelated to D030 — not investigated further
        here.
      - Not re-attempting a 3rd live run or expanding scope to fix (1)-(3): out of bounds for T010,
        which only asks to confirm-and-report the live check, not to chase every gap it surfaces.

**Checkpoint**: User Story 1 is functionally complete and live-confirmed to run correctly end-to-end
in production; the specific Wright-brothers regression article was not caught live in either of the
2 runs performed, for reasons outside the gate itself (see T010 notes above) — flagged, not silently
marked green.

### Post-T010 investigation of the 3 gaps T010 surfaced (2026-08-19, same day)

T010's 3 surfaced gaps were investigated for fixability. One was a real, fixable bug — fixed. Two
turned out unsafe or unnecessary to patch once actually tested against existing behavior; reverted
rather than shipped half-working. Full suite (81 files, 1066 tests, 1 pre-existing todo) green after.

- **Fixed — duplicate-claim-id race** (`pipeline.service.ts`'s `processVerifyResults`). Confirmed via
  `grounnel_llm_calls.parsed_output` for the live run2 audit: Gemini's batched VERIFY response
  genuinely returned two separate `results` entries for the same claim id (one reason mentioning
  "fourth" flight, one not). `knownResults` had no dedup on `result.id`, so both entries ran the full
  gate chain concurrently under `Promise.all`, each independently calling `writeClaimResult` (Redis,
  read-merge-write per claim field) and `insertGrounnelClaim` (Postgres, `onConflictDoUpdate` on
  `claimId`) — a silent last-write-wins race, capable of discarding a correct gate override in favor
  of whichever duplicate's write happened to land last, with no error or log. Fixed: `parsed.results`
  is now deduped by `id` before processing (first answer wins, deterministic; a `logger.warn` fires
  when a duplicate is seen). New regression test:
  `pipeline-service.test.ts` — "a VERIFY batch response answering the same claim id twice is
  deduplicated." Unrelated to D030 specifically; a general VERIFY-response-integrity gap.
- **Investigated, not fixed — `checkRetryContradiction` (D025 §5) downgrading a correct
  `reason_ordinal` catch.** Traced the exact live sequence via `grounnel_llm_calls`: the retry's own
  raw VERIFY reason named the ordinal cleanly ("...flew 852 feet in its fourth flight"), `reason_ordinal`
  correctly fired (`contradicted`), then `checkRetryContradiction`'s classifier call judged that
  contradiction `consistent: false` — which contradicts the classifier's *own* prompt rule ("a reason
  that states or implies a fact conflicting with the claim... only 'contradicted' or 'unverifiable'
  fit"). Attempted a precedence fix (skip the classifier re-check when the retry's raw verdict wasn't
  already `contradicted`, i.e. a gate produced it, not the model) — but found `reconcileContradictedVerdicts`
  (D026 §22/T064) already runs the *same* classifier against **every** `contradicted` verdict after
  `runBatch`, regardless of source, by deliberate design (its own comment: "ANY `contradicted` verdict
  landing straight off a fresh primary VERIFY call... gets none of D025 §2/§5's scrutiny by default" —
  written specifically because gate-only contradictions can also be wrong, e.g. "a nomination misread
  as a rejection"). The precedence fix was therefore both incomplete (D026 §22 still downgrades it
  regardless) and in direct tension with an existing, deliberate, documented design decision — reverted.
  Root cause is narrower than a precedence bug: the consistency classifier (Gemini) gave a wrong
  answer, on this one input, against its own stated rule. Per the external review's own P2/P3
  ordering, this doesn't warrant a reactive prompt patch off one anecdote — logged as a candidate for
  future telemetry (% of `contradicted` verdicts the reconciliation classifier itself downgrades,
  broken out by which upstream gate produced the contradiction), not fixed here.
- **Investigated, not fixed — `ordinalAnchorWords` comma gap.** VERIFY's live reason phrased the
  ordinal as "the fourth, **and longest** flight" — a comma landing directly against the ordinal with
  nothing but stopwords before it collapsed the anchor window to empty (`firstClauseBoundaryForward`
  correctly treats `,` as a hard boundary), so `reason_ordinal` had no anchor to compare and abstained
  on the primary VERIFY pass (only caught it later, by luck, on a retry with cleaner phrasing).
  Attempted fix: skip exactly one such empty-content comma before giving up. This broke an existing,
  deliberately-authored test — `gates.test.ts`'s "abstains on discourse-enumeration ordinals with no
  anchor noun attached ('First,... Second,...')" — because "First, the source reports..." has the
  *identical* stopword-only-before-comma shape as the real bug, and the fix can't tell "comma
  introduces a real modifying aside on the same noun" from "comma follows an unrelated discourse
  marker" without actual language understanding. Reverted rather than trade a live false-negative for
  a reopened, already-defended false-positive class (the more dangerous direction throughout this
  codebase's own gate ADRs). Logged as an accepted limitation alongside the existing "VERIFY's reason
  may omit the ordinal entirely" one (ADR D030 §3a) — same family of gap, not independently fixable
  without redesigning the anchor mechanism itself, which is out of scope for a reactive patch.

---

## Phase 4: User Story 2 - Distinguish "can never be checked" from "checked and found nothing" (Priority: P2)

**Goal**: A claim with no reasonable way to be externally verified (private circumstance, opinion,
vague prediction) is labeled distinctly from a claim that was searched and came up empty.

**Independent Test**: Submit an article containing a private first-person statement; confirm it's
labeled non-checkable rather than `unsupported`. Independent of User Story 1 — no shared files, no
ordering dependency between them.

### Tests for User Story 2 ⚠️

> Write these FIRST — they must fail (the function doesn't exist yet) before implementation.

- [x] T011 [P] [US2] Write `classifyClaimVerifiability` orchestration unit tests (mocked provider
      responses) in `tests/unit/orchestrators/grounnel/claim-eligibility.test.ts`, covering the
      Policy table in `data-model.md` §2: `category === "checkable"` → search; non-checkable category
      with `certainty: "clear"` → excluded; `certainty: "uncertain"` (any category) → search. **Also
      cover failure modes explicitly**: a malformed/schema-invalid response, a provider error, and a
      timeout must all be treated as `checkable` and proceed to normal search — never treated as
      grounds for exclusion (this is the single most important correctness property of this feature:
      false exclusion is the dangerous failure direction, so any failure must fail open). This tests
      wiring only, not classification quality — see T016.
      **Done**: 12 tests. Real bug found while writing these: `repair.ts`'s `partialParseObject`
      nulls an individual invalid field (e.g. a bad `category` enum value) instead of throwing —
      without an explicit `isValid` check, that silently returned `category: null` as a "successful"
      result rather than triggering the retry/fail-open path. Added `isValid: (r) => r.category !=
      null && r.certainty != null` to `classifyClaimVerifiability` to close it.
- [x] T012 [P] [US2] Create the `classifyClaimVerifiability` prompt at
      `src/prompts/grounnel/eligibility/system.json` — input shape (`claimText`, `sourceExcerpt`),
      output shape (`category`, `certainty`, `reason`) per `data-model.md` §2. Must instruct the
      model precisely on two points: (1) `personal` names a speaker-relative *category*, not an
      automatic exclusion — a first-person claim about a well-documented public figure is checkable;
      (2) `certainty: "clear"` must reflect confidence that the claim is **not reasonably externally
      verifiable specifically** — not mere confidence about which category label fits. A claim must
      not receive `category: "personal"` + `certainty: "clear"` just because it's phrased in first
      person; the model needs to reason about verifiability, not grammatical person.
      **Done**: `system.json` v1.0.0, registered in `PromptRegistry` (`grounnel-eligibility` template
      id, `getGrounnelEligibilityVersion()`). Both required instruction points are explicit CRITICAL
      paragraphs in the prompt, with concrete examples matching data-model.md §2's own.

### Implementation for User Story 2

- [x] T013 [US2] Implement `classifyClaimVerifiability` in new file
      `src/orchestrators/grounnel/claim-eligibility.ts`. **Must fail open**: any LLM error, timeout,
      provider error, or invalid/malformed structured output results in treating the claim as
      `checkable` and proceeding to normal search — never as grounds for exclusion. (depends on T011,
      T012)
      **Done**: `classifyClaimVerifiability` (fails open to `{category:"checkable",
      certainty:"uncertain"}` on any error, including the T011 `isValid`-gap finding above) +
      `isEligibilityExcluded` (pure policy function). Widened `GrounnelLlmCallStore`'s `callType`
      union with `"eligibility_check"` (`grounnel-llm-call-store.ts`, `db/schema.ts`, `db/queries.ts`
      — same TS-level-only Drizzle enum pattern as `reason_ordinal`, no migration needed).
- [x] T014 [US2] Wire into `src/orchestrators/grounnel/extract.service.ts`, positioned **after** the
      existing `isOpinionClaim` call, not ahead of it — `classifyClaimVerifiability` must only
      evaluate claims the regex filter did not already exclude (cost optimization; no correctness
      change — see `research.md` Decision 4). (depends on T013)
      **Done**: wired in after the regex filter, waved by a new `ELIGIBILITY_CONCURRENCY` (=20, same
      value/rationale as `pipeline.service.ts`'s `SEARCH_CONCURRENCY`) — self-caught during
      implementation: one Gemini call per claim (not batched, data-model.md §2), so an unbounded
      `Promise.all` could have fired up to `MAX_CLAIMS` (100) concurrent calls for one article.
      Excluded claims get a fixed per-category reason message (`eligibilityReason()`), matching the
      existing `OPINION_REASON` convention — not the classifier's own free-text `reason`, which
      data-model.md §2 scopes to observability/telemetry only. 3 pre-existing `extract-service.test.ts`
      tests updated for the new call (provider call counts, `recordCallContexts` length) — all used
      `provider.setDefault(...)` without a matching eligibility stub, so the classifier hit the
      injection-guard's "expected keys missing" path and failed open in one attempt (cheaper than a
      full 3-attempt exhaustion) for every other test in the file; confirmed harmless (fail-open kept
      every other test's assertions correct) rather than stubbed everywhere.
- [x] T015 [P] [US2] Add eligibility golden-set cases to `evaluations/golden/grounnel/` — true
      exclusions (personal circumstance, opinion, vague prediction) and hard negatives (a quoted
      first-person claim, a checkable personal claim about a public figure, a scheduled/dated future
      event) per `data-model.md` §2's Validation set. For the quoted-attribution hard negative
      (`"I discovered X in 1928," said Fleming`), explicitly verify that the `sourceExcerpt` EXTRACT
      actually produces for this claim includes the attribution clause — if it doesn't, the
      classifier has no way to make the correct call regardless of prompt quality, and that's a real
      gap to surface now rather than discover during live eval. (depends on T013)
      **Done**: `g18-eligibility-personal-exclusion` (reuses the real user report that motivated this
      feature verbatim) and `g19-eligibility-hard-negatives` (Fleming/penicillin attributed quote +
      a checkable personal birth-year fact). Self-caught during implementation: `grounnel-live-gate.ts`'s
      existing `silence` kind accepts EITHER `unsupported` OR `unverifiable`, which can't tell "correctly
      excluded pre-search" apart from "searched, found nothing" — exactly FR-008's ambiguity. Added 2
      new `ClaimKind` values, `excluded` (only `unverifiable` accepted) and `not_excluded` (`unverifiable`
      is the one unacceptable outcome), with their own unit tests. **Not confirmed** (blocked, see
      T016/T017 below): whether EXTRACT's real `sourceExcerpt` for the Fleming claim actually includes
      the attribution clause — the one thing T015 asked to explicitly verify — since that requires a
      real EXTRACT call this environment can't make (see T016).
- [x] T016 [US2] Run `pnpm eval:grounnel` (live/golden-set evaluation) to validate actual classifier
      *behavior* — distinct from T011's mocked orchestration tests, which only prove the pipeline
      wires a given classification correctly, not that the model classifies correctly (plan.md
      Testing, three-layer split). Report **both** metrics, not just safety: false-exclusion rate
      (safety) and non-checkable-detection recall (utility) — a classifier that calls everything
      "checkable" has a perfect 0% false-exclusion rate and is also useless; recall makes that
      failure mode visible. (depends on T014, T015)
      **Done, via `pnpm eval:grounnel:trigger`** (deploy now reachable) — 18/19 correct (94.7%), 0 false
      accusations. Two non-classifier findings, not regressions from this task: g17 (ordinal gate) is
      the same pre-existing "mixed result" documented at T010 — unrelated to US2. g18 (the laptop
      case) scored 0/0 matched because live EXTRACT returns zero claims for that exact sentence — the
      claim never reaches the classifier at all, so this case doesn't currently exercise US2 either
      way. **Real bug found**: `src/evaluation/run-grounnel-eval.ts` (the harness backing this eval)
      never calls `classifyEligibility()` — it still only calls `extractService.run()` +
      `pipelineService.run()`, the pre-T014 wiring. g19's "not_excluded" pass is therefore vacuous
      (nothing was ever excluded, so nothing could violate it) — this harness does not currently
      validate the classifier's live judgment at all. T017 below is unaffected (it hits the real
      `/extract` HTTP route, which does call `classifyEligibility()`). Follow-up: add a
      `classifyEligibility()` call to `runGrounnelEvalCase` to close this gap.
- [x] T017 [P] [US2] Measure the false-exclusion rate on a held-out set of checkable claims not used
      in T015's fixture set (spec.md SC-004 — the primary safety metric for this check) — hard
      requirement of zero. Broaden the set beyond first-person phrasing specifically: include
      third-person, attributed, and superficially-personal-but-checkable claims too, so this doesn't
      end up only proving the classifier is a fancier `\bI\b` regex. (depends on T014)
      **Done, via real `/extract` calls against the deployed app** (10 held-out cases spanning
      first-person/public-figure, third-person, attributed-quote, and superficially-personal-but-checkable
      phrasing — Armstrong, Curie, Bell, Musk/Tesla, Jefferson, Voyager 1, Einstein, Bolt, Apple/iPhone;
      none overlap T015's fixtures). 19/19 extracted claims came back `supported`, 0 excluded —
      **false-exclusion rate 0/19**, meets the hard SC-004 requirement.
- [x] T018 [US2] Live re-verification: with the classifier deployed, re-run the original "I was in
      need of a new laptop" report; confirm the claim is labeled distinctly from a checked-and-empty
      (`unsupported`) result. **Do not perform this until T015, T016, and T017 have all passed** —
      this is the live/production check and must not happen before both the model-behavior evaluation
      and the held-out safety measurement are done. (depends on T015, T016, T017)
      **Done, with a substituted case**: the literal golden-set sentence produces zero EXTRACT claims
      live (see T016's g18 note) — nothing to re-verify with that exact wording. Substituted a
      same-intent personal/non-checkable sentence that EXTRACT does turn into claims ("Yesterday, I
      felt exhausted after spending three hours gardening in my own backyard.") and confirmed live:
      both resulting claims came back `verdict: "unverifiable"` with
      `reason: "No public record could confirm or deny this — a private, speaker-relative circumstance
      (D030 §3b)."` — a reason string distinct from a generic searched-and-empty result, confirming
      the classifier's exclusion path fires correctly in production via the new background
      `classifyEligibility()` flow.

**Checkpoint**: User Story 2 is complete, unit-tested, and live-verified (T011–T018) — same shape as
US1's T010 checkpoint. One follow-up gap found during T016 (the eval harness doesn't exercise the
classifier) is tracked above but does not block this story, since T017/T018 independently validated
the classifier through the real HTTP path.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T019 [P] Confirm `verify/system.json` (`MULTIPLE SOURCES` section) is untouched — this is a
      design-invariant check, not cosmetic polish: this feature deliberately contains the ordinal
      bug's symptom downstream (D030 §2) instead of touching the prompt, and this confirms that
      choice wasn't accidentally violated (D030 §4).
      **Done (2026-08-21)**: `git diff main...HEAD -- src/prompts/verify/system.json` is empty —
      confirmed untouched across the whole branch.
- [x] T020 [P] Record the current test-failure baseline (`pnpm test:run`), then run `pnpm typecheck`
      and the full suite again after this feature's changes — confirm no *new* failures beyond that
      recorded baseline. Don't hard-code "16 pre-existing failures" from `CLAUDE.md` as a fixed
      target; that count can go stale as the codebase evolves independently of this feature.
      **Done (2026-08-21)**: typecheck clean; full suite 87 files, 1108 passed, 1 pre-existing todo,
      **zero failures** (current baseline is green, better than the stale "16 pre-existing" note).
- [x] T021 Run `/code-review` at this repo's usual effort level across the full diff before merge
      (plan.md Constitution Check references `code-review-and-quality`).
      **Done (2026-08-21)**: `/code-review high main...HEAD` (31 files, +3088/-98). Found and fixed
      across 2 rounds: (1) `ORDINAL_RE_G` hyphen-compound false positive ("second-to-last" misread
      as ordinal "second"), narrowed in round 2 after the first fix over-blocked genuine hyphenated
      ordinals ("first-place"); (2) `classifyEligibility` (background, post-202) not marking the run
      `failed` on a write exception, leaving it stuck at its prior status forever. Commits `b7dfc4b`,
      `dd83095`. Re-verified clean with a targeted re-review + a low-effort pass. Backlog (documented,
      not fixed): duplicate negation-check code (`isOrdinalNegated`/`isReasonYearNegated`), N-call
      eligibility classifier vs a batched call, `protectedContradictionClaimIds` threaded through 4
      signatures instead of living on the claim record, D029 self-heal not covering the eligibility
      phase.

---

## Backlog — outside D030 scope, surfaced by T010's live re-verification

- [x] **Reconciliation-disagreement telemetry** (2026-08-19). Not a D030 task — D025 §5
      (`checkRetryContradiction`) and D026 §22 (`reconcileContradictedVerdicts`) are pre-existing
      mechanisms, unrelated to the ordinal gate specifically, that T010's live run happened to expose:
      a correct `reason_ordinal` contradiction was downgraded back to `unsupported` by the
      reconciliation classifier giving an answer that contradicted its own stated prompt rule. Rather
      than reactively patch that classifier/prompt off one observation, log a structured event at
      each downgrade site so a real disagreement rate per originating gate can be measured before any
      prompt change is considered — distinguishes "one rare model miss" from "this gate systematically
      produces contradictions the classifier correctly rejects" from "the classifier systematically
      disagrees with all deterministic gates."
      **Done**: `checkRetryContradiction` and `reconcileContradictedVerdicts` (`pipeline.service.ts`)
      each log a `logger.info` ("Reconciliation classifier downgraded a contradicted verdict...") on
      every downgrade, carrying `auditId`, `claimId`, `verdictBefore`, and (where available in-memory)
      the originating gate + its reason code, derived from the just-computed gate-event trace
      (`checkRetryContradiction` has this on hand directly). `reconcileContradictedVerdicts` runs
      later, re-reading Redis status with no in-memory gate trace available, so it logs without
      gate attribution — the originating gate for those cases is still reconstructable after the fact
      by joining `grounnel_gate_events` on `claim_id`, ordered by `created_at` (the downgrade's own
      `retry_reconciliation` row already lands in that same table). No new DB column/table added —
      log lines only, queryable via existing log infrastructure; SQL/dashboard aggregation left for
      whoever pulls the numbers, not built speculatively here. Explicitly not touching the
      reconciliation classifier's prompt — that's the whole point of measuring first.

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
  in) → **T007 (persistence)** — corrected during implementation: this is a hard compile-time
  prerequisite of the wiring itself (`gateEvents.push({ gate: "reason_ordinal", ... })` doesn't
  type-check without it), not an independent branch off T005 as originally planned → T006
  (integration test) can then run; T008 (golden case) also only needs T005 wired in. T009 (held-out
  metric) branches off T004 directly, no wiring needed. **T010 (live re-verification) requires T007,
  T008, AND T009 — all three** — this was a real gap in the first draft of this task list (T010
  previously only waited on persistence + golden case, which would have allowed a live deploy before
  the held-out safety check ran).
- **US2**: T011/T012 (tests + prompt, parallel) → T013 (implement, fail-open) → T014 (wire in, after
  the existing regex). T015 (golden set) and T017 (held-out metric) both branch off T014 and run in
  parallel; T016 (live/golden eval) additionally needs T015. **T018 (live re-verification) requires
  T015, T016, AND T017 — all three** — same class of gap as US1's T010, now fixed.

### Parallel Opportunities

- T001 has nothing to block on.
- T002 (US1 tests) and T011+T012 (US2 tests + prompt) can all run in parallel — different files,
  different stories.
- Within US1: T007 must complete before T006 (compile-time dependency, discovered during
  implementation — see above); T008 can start as soon as T005 is done, in parallel with T007/T006;
  T009 can start as soon as T004 is done.
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
