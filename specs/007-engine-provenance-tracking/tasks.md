---

description: "Task list for Engine Provenance Tracking (D017)"
---

# Tasks: Engine Provenance Tracking

**Input**: Design documents from `/specs/007-engine-provenance-tracking/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/engine-response-source.md,
quickstart.md

**Tests**: Included — unit-level, consistent with how this codebase already tests `workspace-builder`
and `comparison-recorder`. Write each test to fail first where noted.

**Organization**: Phase 2 fixes pre-existing, unrelated test debt (plan.md "Pre-Existing Test Debt").
Phases 4–6 are grouped by user story (US1 per-bias provenance, US2 fallback/back-compat, US3
persisted per-source breakdown), matching spec.md's priorities.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- Paths are relative to `biassemble-core/`.

---

## Phase 1: Setup

- [x] T001 Confirmed on branch `007-engine-provenance-tracking`; `pnpm typecheck` clean; `pnpm vitest run` = 341 pass / 16 fail / 357, matching the pre-diagnosed set exactly. Proceeding to Phase 2 to fix them for real.

---

## Phase 2: Fix Pre-Existing Test Failures

**Purpose**: All 16 failures on this branch are pre-existing and unrelated to D017 — each has a
verified root cause (plan.md "Pre-Existing Test Debt"). Fixing them here establishes a genuinely
green baseline for the rest of this plan, instead of carrying a known-red set forward.

**⚠️ Scope note**: none of these touch the same code as US1/US2/US3 except `assessment.service.ts`,
and at a different, non-overlapping block (the `noBiasDetected` consistency check vs. the
`engineSources`/`callProvider` work in Phases 4–6) — see T005 below.

- [x] T002 [P] Rewrote tests/unit/catalog/normalize.test.ts to match the actual `{name, id?}` contract: dropped all `.confidence` assertions, `toBeNull()`→`toBeUndefined()`, folded the id-exact-match case into the name-match case. Found one more real divergence while running it: `normalizeBiasName("Halo", ...)` genuinely scores ~0.446 (below the 0.5 threshold) under the current simple scorer — computed by hand (overlap=0.5, editDist≈0.636) and confirmed, not assumed. Rewrote that case to assert no-match instead of forcing the threshold. 8/8 green, no src changes.
- [x] T003 [P] Replaced both "should reject missing prompt_version" tests (QuestionOutputSchema, AssessmentOutputSchema) with "should accept missing prompt_version," citing commit 4b27bb8 + ADR D003. 29/29 green, no src changes.
- [x] T004 [P] Fixed src/evaluation/compute-evaluation-metrics.ts L110: `(b.confidence ?? 0)` → `(b.confidence ?? 1)`, with a comment explaining why. 17/17 green.
- [x] T005 Fixed src/orchestrators/reflection/assessment.service.ts's T205 block: `=== undefined` → `== null`, with a comment citing repair.ts's `partialParseObject` as the root cause. Verified it fixes both T505 and two-phase-session Phase 1 in one change (ran both files together, confirmed only the separate T006 target remained red).
- [x] T006 [P] two-phase-session.test.ts Phase 2: replaced the hardcoded `"1.0.0"` with `new PromptRegistry().getVersion()`, removed the now-duplicate old assertion. 9/9 green.
- [x] T007 [P] inngest-eval.test.ts: replaced the stale `"asking 2-5"` trigger with `"QUESTION DESIGN PRINCIPLES"` (a structural heading, less likely to drift than prose); verified the assessment prompt's `"answered follow-up questions"` trigger is still valid, unchanged. Checked no other test file uses the stale trigger. 3/3 green.
- [x] T008 Full suite: **356 passed, 0 failed, 31 files, typecheck clean** (357→356: the redundant kebab-id test case was folded into the name-match case in T002, net −1 test, not a dropped assertion). True green baseline established.

**Checkpoint**: `pnpm vitest run` is fully green. All subsequent phases build on a verified baseline.

---

## Phase 3: Foundational (Blocking Prerequisites)

**Purpose**: Engine response types + `source` normalizer, consumed by BOTH US1 and US3.

**⚠️ CRITICAL**: US1 and US3 cannot begin until this phase is complete.

- [x] T009 [P] Added tests/unit/rag/engine-client-provenance.test.ts (6 tests: array passthrough+dedup, legacy "both" expansion, null/absent/unknown handling, response parsing with/without source, top-level llm_* metadata). Confirmed RED first (4/6 failed before implementation).
- [x] T010 Extended `BiasResult` with `source?: EngineSource[] | null` and `EngineResponse` with optional `selection_strategy`/`llm_model`/`llm_latency_ms`/`truncated_story`/`llm_scores`/`vector_scores` in src/rag/engine-client.ts.
- [x] T011 Added exported `normalizeSource()` implementing the array/legacy-scalar/unknown rules; applied per-bias in `retrieve()`; `isEngineResponse` left lenient.
- [x] T012 6/6 green; typecheck clean.

**Checkpoint**: Engine response types + normalization ready; `"both"` never survives past this layer as a value.

---

## Phase 4: User Story 1 — Per-bias provenance (Priority: P1) 🎯 MVP

**Goal**: Every detected bias carries `engineSources: ("vector"|"llm")[]`, replacing `context_source`.

**Independent Test**: Run an assessment against a stored retrieval result with per-bias `source`;
confirm each bias's `engineSources` matches, and an LLM-alone bias (`[]`, request retrieved) is
distinguishable in the stored record from a no-retrieval-available bias (`[]`, request unavailable).

### Tests for User Story 1

- [x] T013 [P] [US1] Added tests/unit/rag/workspace-builder-provenance.test.ts (3 tests: array sources, fallback, mixed response, unavailable cases). Confirmed RED first (3/3 failed).
- [x] T014 [P] [US1] Added tests/unit/orchestrators/assessment-provenance.test.ts (2 tests: engine=retrieved copies sources + LLM-alone gets [], engine=unavailable [] means unknown). Confirmed RED first (2/2 failed).

### Implementation for User Story 1

- [x] T015 [US1] Extended `BiasWorkspace` with `engineSources: Map<string, EngineSource[]>` in src/rag/workspace-builder.ts; built alongside `retrievedIds` with the `["vector"]` fallback; empty map on both unavailable branches.
- [x] T016 [US1] Captured `workspace.engineSources` in `runFullAssessment`.
- [x] T017 [US1] Extended `callProvider`'s signature with `engineSourcesMap` param, passed from both call sites — done before T018 to avoid the known gap.
- [x] T018 [US1] Replaced the `context_source` derivation with `engineSources: engineSourcesMap.get(result.id ?? "") ?? []`; confirmed no line-range collision with T005 (Phase 2's noBiasDetected fix is a separate, earlier block).
- [x] T019 [US1] Swapped `context_source` enum for `engineSources: z.array(z.enum(["vector","llm"])).optional()` in reflection.schemas.ts.
- [x] T020 [US1] Verified by inspection: only the post-parse bias-normalization loop and callProvider's signature/call sites were touched; `renderWorkspaceToPrompt`/`prompts.render()` untouched.
- [x] T021 [US1] Cleaned up now-dead `retrievedIds` param (superseded by `engineSourcesMap`) from callProvider and both call sites during the wiring. T013/T014 green (5/5); typecheck clean; full suite 367 pass / 0 fail / 34 files (356 Phase-2 baseline + 6 Phase-3 + 5 Phase-4 = 367, zero regressions).

**Checkpoint**: Live assessment results carry per-bias provenance; MVP demonstrable.

---

## Phase 5: User Story 2 — Fallback & backward compatibility (Priority: P2)

**Goal**: Stored retrieval results without per-bias `source` resolve provenance via the existing
inference rule, unchanged.

**Independent Test**: Process a retrieval result with no `source` on any bias; provenance resolves to
`["vector"]` for every retrieved bias, no errors, existing behavior otherwise unchanged.

### Tests for User Story 2

- [x] T022 [P] [US2] Added tests/unit/rag/workspace-builder-fallback.test.ts: a response with NO source field on any bias yields `["vector"]` for every retrieval_score>0 bias, excludes score=0. Ran immediately green (1/1) — the T015 fallback logic was already per-bias, confirming US2's requirement was already satisfied by the Phase 4 implementation.

### Implementation for User Story 2

- [x] T023 [US2] Confirmed by direct code inspection: the `b.source && b.source.length > 0 ? b.source : ["vector"]` ternary lives inside `retrieved.map(...)` in workspace-builder.ts, evaluated independently per bias — no per-response branching that could apply the fallback to the whole set. No code change needed.
- [x] T024 [US2] Full suite: 368 pass / 0 fail / 35 files; typecheck clean. Zero regressions.

**Checkpoint**: Non-`llm_union` and legacy stored results behave exactly as before.

---

## Phase 6: User Story 3 — Persisted per-source breakdown (Priority: P2)

**Goal**: `retrieval_comparisons` stores a generic `source_breakdown` per-run, plus `selection_strategy`/`llm_model` per-run metadata. No fixed-arity storage anywhere — no `both` key, no per-source `*_hit_final` columns.

**Independent Test**: Run a full assessment with per-bias source data; inspect the stored row —
`source_breakdown` has one key per distinct source that appeared, a bias found by two sources appears
in both keys' lists, no `both` key exists, `selection_strategy`/`llm_model` are populated; forced
write failure does not affect the response.

### Tests for User Story 3

- [x] T025 [P] [US3] Added tests/unit/observability/comparison-recorder-breakdown.test.ts (4 tests): per-key list/hitFinal against finalList, no `both` key, aggregate unchanged, NULL-not-`{}` when empty, throwing-store fire-and-forget, selectionStrategy/llmModel passthrough (null when absent). Confirmed RED first (3/4 failed).
- [x] T026 [P] [US3] Covered in the same file/commit as T025 (NULL-not-`{}` case).
- [x] T027 [P] [US3] Covered in the same file/commit as T025 (throwing-store case).
- [x] T028 [P] [US3] Covered in the same file/commit as T025 (selectionStrategy/llmModel passthrough case).

### Implementation for User Story 3

- [x] T029 [US3] Added `sourceBreakdown`/`selectionStrategy`/`llmModel` (all nullable) to `retrievalComparisons` in schema.ts; added `{enum:[...]}` to `ragStatus`.
- [x] T030 [US3] Generated migration 0009_aromatic_orphan.sql — confirmed the predicted drift (phantom `CREATE TABLE` + phantom `runs` columns, from the pre-existing missing 0006-0008 snapshots) and confirmed `ragStatus`'s enum change produced zero SQL, exactly as predicted. Hand-corrected to 3 idempotent `ADD COLUMN IF NOT EXISTS` statements. **NOT applied** — that's T040, gated on explicit go-ahead.
- [x] T031 [US3] Extended `RetrievalComparisonRecord` with the 3 new fields (non-optional, always `null` or populated — matches the recorder's always-provide-a-value design).
- [x] T032 [US3] Threaded the 3 fields through `insertRetrievalComparison` and `DrizzleRetrievalComparisonStore`.
- [x] T033 [US3] Built `sourceLists` in `runFullAssessment` from `workspace.candidates` + `workspace.engineSources` (workspace layer, not raw response — per the fixed ambiguity from review). Captured `selectionStrategy`/`llmModel` from the validated `ragResult.data`. Extended `runFullAssessment`'s return type and `FullAssessmentResult` (routes/reflection.ts) to match.
- [x] T034 [US3] Implemented the generic `source_breakdown` computation in comparison-recorder.ts: source-name-agnostic `Object.entries(sourceLists)` loop, `null` when empty, existing fields/fire-and-forget path unchanged.
- [x] T035 [US3] Threaded `sourceLists`/`selectionStrategy`/`llmModel` into the `recordComparison(...)` call in routes/reflection.ts.
- [x] T036 [US3] 4/4 recorder tests green; typecheck clean; full suite 372 pass / 0 fail / 36 files (368 Phase-5 baseline + 4 = 372, zero regressions).

**Checkpoint**: Per-source confirmation-rate dataset is queryable; no fixed-arity storage anywhere (SC-003, SC-007).

---

## Phase 7: Polish & Cross-Cutting

- [ ] T037 [P] Run quickstart.md's fast-verification block; grep the full diff for the literal string `"both"` outside comments/docs explaining its absence — zero hits expected (SC-007 self-check)
- [ ] T038 [P] Confirm model-call count per assessment is unchanged (SC-004) — no new provider call anywhere in the diff
- [ ] T039 Confirm `context_source` has zero remaining references in `src/**/*.ts` after T018/T019 (`grep -rn "context_source" --include=*.ts src/`); update any doc/comment cross-refs found
- [ ] T040 Apply the migration to the live database **only after explicit go-ahead** — this repo's convention (per prior sessions) is to confirm before any live-DB write, even an additive one

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Pre-Existing Test Debt (Phase 2)**: after Setup. Independent of D017 entirely — touches `normalize.test.ts`, `reflection.schemas.test.ts`, `compute-evaluation-metrics.ts`, `assessment.service.ts` (T205 block only), `two-phase-session.test.ts`, `inngest-eval.test.ts`. Establishes the true green baseline; does not block Phase 3 in principle, but should run first so every later "no regression" check is unambiguous.
- **Foundational (Phase 3)**: after Phase 2 (or Phase 1, if run in parallel with Phase 2 — see below). BLOCKS US1 and US3 (both consume the extended engine types + `normalizeSource`).
- **US1 (Phase 4)**: after Foundational. Delivers the MVP. Internal order matters: T015 (map) → T016 (capture) → T017 (signature) → T018 (lookup) → T019 (schema) — T017 before T018 is the specific ordering that avoids the `callProvider` gap.
- **US2 (Phase 5)**: after US1 (extends the same `buildBiasWorkspace` fallback branch T015 already built).
- **US3 (Phase 6)**: after Foundational; independent of US1/US2's `callProvider` wiring (T016–T019) but **NOT independent of T015** — `T033` reads `workspace.engineSources`, which only exists once `T015` (Phase 4) lands. `T029`–`T032` (schema/migration/types/persistence-chain) have no such dependency and can genuinely run in parallel with US1; `T033`–`T035` cannot start until `T015` is done. Internal order: T029 (schema) → T030 (migration, hand-verified) → T031 (types) → T032 (persistence chain) → [wait for T015] → T033 (service builds sourceLists) → T034 (recorder) → T035 (route wiring).
- **Polish (Phase 7)**: after all stories. T040 (apply migration) is the last step and requires explicit go-ahead.

### Parallel Opportunities

- T002/T003/T004/T006/T007 [P] in Phase 2 — five independent files; T005 touches `assessment.service.ts` and can run alongside them (different file from the other four, and a different block within `assessment.service.ts` than anything in Phase 4).
- T009 [P] alone in Phase 3 until T010/T011 land.
- US1 tests T013/T014 [P]; US3 tests T025/T026/T027/T028 [P].
- After Phase 3: US1+US2 (one thread) and US3's `T029`–`T032` (schema/migration/types/persistence-chain, another thread) touch disjoint files and can genuinely run in parallel. `T033`–`T035`, however, are NOT parallel with US1 — `T033` depends on `T015` (the `BiasWorkspace.engineSources` field, US1/Phase 4), and `T033`/`T016`/`T017` all edit `assessment.service.ts`'s `runFullAssessment`. Sequence: finish `T015` before starting `T033`; do `T016`/`T017`/`T033` in that file one at a time regardless of which "thread" is doing the rest.

---

## Implementation Strategy

### MVP First (US1)

Phase 1 → Phase 2 (green baseline) → Phase 3 → Phase 4 (US1) → **STOP & validate**: per-bias provenance visible on live results.

### Incremental Delivery

1. Phase 2 → truly green baseline (no known-red set to reason around for the rest of this plan).
2. Foundational ready (no `"both"` value survives the engine-response parse layer).
3. US1 → provenance on live results (MVP).
4. US2 → fallback/back-compat locked in.
5. US3 → persisted, queryable per-source dataset (the actual measurement payoff — SC-003).
6. Polish → migration applied only with explicit go-ahead (T040).

---

## Notes

- No task in this list adds a per-source-combination field (no `bothList`, no `*BothHitFinal`) —
  that is the specific defect this rebuild exists to avoid (see docs/decisions/017, ADR header note).
- `engineSources`/`source_breakdown` are observability-only — never fed back into the assessment
  prompt or used to rank/filter what the assessment LLM sees (FR-010/FR-011).
- The `ragStatus` enum addition (T029) is TypeScript-only, matching existing precedent in this
  schema — it does not add database-level enforcement (data-model.md §3).
- Phase 2 fixes are pre-existing debt, unrelated to D017, folded into this plan on explicit request
  (plan.md "Pre-Existing Test Debt") — each has a verified root cause, not a guess.
- Commit cadence per repo convention: one-line message, no AI attribution, only when asked.
- Do not commit or apply the migration without being explicitly told to, consistent with how this
  session has been run so far.
