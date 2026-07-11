---

description: "Task list for Three-Way Bias Provenance Tracking (D015)"
---

# Tasks: Three-Way Bias Provenance Tracking

**Input**: Design documents from `/specs/005-bias-provenance-tracking/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/engine-response-v3.md

**Tests**: Included — the plan and quickstart call for unit + contract coverage, consistent with the
project's testing philosophy (`docs/testing-philosophy.md`). Write each test to fail first.

**Organization**: Grouped by user story (US1/US2/US3), which map to ADR D015 Decisions 2, 1, and 3.

> **Review fixes folded in**: finding 1 → T010 (extend `callProvider` signature); finding 2 → T025/T026
> (per-source lists keyed by **name**, built from the engine response); finding 3 → no `ragCase` added
> to the API (storage-only); finding 4 → T030 (verify no `context_source` consumer before removal).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (per-bias provenance), US2 (fallback/back-compat), US3 (persistence)

## Path Conventions

Single package: `src/`, `tests/` at `biassemble-core/` root. Migrations under `src/db/migrations/`.

---

## Phase 1: Setup

**Purpose**: Confirm working baseline before edits.

- [x] T001 Baseline captured on b423fff: `pnpm typecheck` passes; `pnpm vitest run` = **326 pass / 16 known-red / 342** (NOT green as expected). The 16 are pre-existing and unrelated to provenance (normalize.test.ts 9/9 test-impl divergence; reflection.schemas 2× prompt_version; eval-metrics 1; integration DB 4). Per user decision: snapshot-gate — proceed, gate on no NEW failures beyond this set. Snapshot in scratchpad/baseline-known-red.md.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extend the engine response types + `source` normalizer that BOTH US1 (derivation) and
US3 (persistence) consume. Maps to ADR D015 Decision 1.

**⚠️ CRITICAL**: US1 and US3 cannot begin until this phase is complete.

- [x] T002 [P] Added tests/contract/engine-response-provenance.test.ts (7 tests): normalizeSource table (array passthrough+dedup, legacy scalar `"both"`/`"vector"`/`"llm"`, null/empty→null, unknown dropped) + retrieve() parsing via mocked fetch (v2 no-source→null, array+scalar per-bias, top-level llm_* capture). Confirmed RED first (5 fail).
- [x] T003 Extended `BiasResult` with `source?: EngineSource[] | null` and `EngineResponse` with optional `selection_strategy`/`llm_model`/`llm_latency_ms`/`truncated_story`/`llm_scores`/`vector_scores` in src/rag/engine-client.ts (additive).
- [x] T004 Added exported `normalizeSource(raw): EngineSource[] | null` (array→dedup known; `"both"`→`["vector","llm"]`; scalar→singleton; unknown/empty/null→null) and applied it per-bias in `retrieve()` via a normalized EngineResponse; `isEngineResponse` left lenient. Correctly did NOT apply the `retrieval_score>0`⇒`["vector"]` inference here (that's context-builder, R3).
- [x] T005 Contract test GREEN (7/7); typecheck clean; full suite 333 pass / 16 known-red / 349 — no new failures. Removed the now-stale `@ts-expect-error` on the import during review.

**Checkpoint**: Engine response types + normalization ready.

---

## Phase 3: User Story 1 — Per-bias provenance (Priority: P1) 🎯 MVP

**Goal**: Every detected bias carries `engineSources: ("vector"|"llm")[]`, replacing the binary
`context_source`, with `[]` disambiguated by `ragCase`. (ADR D015 Decision 2.)

**Independent Test**: Run an assessment against an engine returning per-bias `source`; confirm each
bias's `engineSources` matches the engine signals, and an LLM-alone bias (`[]`, `ragCase="retrieved"`)
is distinguishable from a roster-fallback bias (`[]`, `ragCase!="retrieved"`) in the stored record.

### Tests for User Story 1

- [x] T006 [P] [US1] Added tests/unit/rag/context-builder-provenance.test.ts (3 tests): engineSources map with `["vector"]`/`["llm"]`/`["vector","llm"]`, underscore→hyphen ids, `["vector"]` fallback when source null but score>0, excludes score-0, empty map on roster_fallback/unavailable. RED first.
- [x] T007 [P] [US1] Added tests/unit/orchestrators/assessment-provenance.test.ts (2 tests) via runFullAssessment + MockProvider + mock stores: engine=retrieved copies sources & LLM-alone bias gets `[]`; engine=roster_fallback yields `[]` disambiguated by returned `ragCase`; asserts per-bias output has NO ragCase. RED first.

### Implementation for User Story 1

- [x] T008 [US1] Extended `BiasContextResult` with `engineSources: Map<string, EngineSource[]>` in src/rag/context-builder.ts; built from each retrieved bias's `source` with the `["vector"]` fallback (R3); empty map for roster_fallback/unavailable.
- [x] T009 [US1] Captured `ctx.engineSources` at both `buildBiasContext` call sites (runStoryOnlyAssessment, runFullAssessment) in src/orchestrators/reflection/assessment.service.ts.
- [x] T010 [US1] Extended `callProvider` signature with `engineSourcesMap: Map<string, EngineSource[]> = new Map()` and passed it from all 3 call sites (finding 1). During review, dropped the now-dead `retrievedIds` param it superseded.
- [x] T011 [US1] Replaced the `context_source` derivation with `engineSources = engineSourcesMap.get(result.id ?? "") ?? []`; kept `ragCase` request-level (not on per-bias output, finding 3); updated the stale D014 comment in context-builder.
- [x] T012 [US1] Swapped `context_source` enum for `engineSources: z.array(z.enum(["vector","llm"])).optional()` in src/contracts/reflection.schemas.ts. Re-checked the 2 known-red prompt_version failures there = orthogonal `.optional()`-vs-test divergence, unaffected by this swap.
- [x] T013 [US1] Verified prompt untouched: only post-LLM derivation + the returned map changed; `ctx.biasContext` (fed to the prompt) is unchanged (FR-011/FR-012).
- [x] T014 [US1] US1 tests GREEN (5/5); typecheck clean; full suite 338 pass / 16 known-red / 354 — identical failure set, zero regressions.

**Checkpoint**: Live assessment results carry three-way provenance; MVP demonstrable.

---

## Phase 4: User Story 2 — Fallback & backward compatibility (Priority: P2)

**Goal**: Responses without `source` (vector_only/nli_union, and legacy v1/v2) resolve provenance via
the retained `retrieval_score` inference rule with zero regressions. (ADR D015 Decision 1 "Do not".)

**Independent Test**: Run assessments under a `source`-less strategy; provenance resolves to
`["vector"]` for retrieved biases, no errors, existing behavior unchanged.

### Tests for User Story 2

- [x] T015 [P] [US2] Added tests/unit/rag/context-builder-fallback.test.ts (1 test): no-source response → `["vector"]` for every score>0 bias, excludes score=0. NOTE: passed on first run — the per-bias fallback already landed in T008, so no separate red phase (capability existed).
- [x] T016 [P] [US2] Extended context-builder-provenance.test.ts with a mixed case (source `["llm"]` / null / absent) — each bias resolves independently: `["llm"]`, `["vector"]`, `["vector"]`.

### Implementation for User Story 2

- [x] T017 [US2] Verified by inspection: `buildBiasContext` builds the map via `retrieved.map(...)` per-bias with no short-circuit — null/absent handled independently. No change needed.
- [x] T018 [US2] US2 tests GREEN (5/5); full suite 340 pass / 16 known-red / 356 — no regressions; typecheck clean.

**Checkpoint**: Non-`llm_union` and legacy responses behave exactly as before.

---

## Phase 5: User Story 3 — Persist per-source lists & confirmation counts (Priority: P2)

**Goal**: `retrieval_comparisons` stores `ragVectorList`/`ragLlmList` and `ragVectorHitFinal`/
`ragLlmHitFinal`/`ragBothHitFinal` alongside existing fields; write stays fire-and-forget.
(ADR D015 Decision 3.)

**Independent Test**: Run a full assessment with engine `source`; inspect the stored row — per-source
lists present (both-bias in both), per-source hit counts consistent with `final_list`, `rag_list` and
existing counts unchanged; forced write failure does not affect the response.

### Tests for User Story 3

- [x] T019 [P] [US3] Added tests/unit/observability/comparison-recorder-per-source.test.ts: name-keyed per-source hit counts (vector=2, llm=1, both=1) against finalList, both-bias in both lists, aggregate ragHitFinal unchanged (=2). RED first.
- [x] T020 [P] [US3] Same file: throwing store → recordComparison resolves (fire-and-forget, FR-010). Passed on first run (try/catch already existed).

### Implementation for User Story 3

- [x] T021 [US3] Added 5 additive nullable columns to `retrievalComparisons` in src/db/schema.ts: `ragVectorList`/`ragLlmList` (jsonb), `ragVectorHitFinal`/`ragLlmHitFinal`/`ragBothHitFinal` (integer).
- [x] T022 [US3] Ran `pnpm db:generate` → src/db/migrations/0007_flat_meltdown.sql. ⚠️ drizzle emitted a full CREATE TABLE (+ runs.rag_result) because meta/0006_snapshot.json is MISSING (pre-existing drift). Hand-corrected the SQL to only the 5 idempotent `ADD COLUMN IF NOT EXISTS`; kept the auto 0007_snapshot (correct full state, repairs future generate).
- [x] T023 [US3] Extended `RetrievalComparisonRecord` (persistence/types.ts) + `insertRetrievalComparison` (db/queries.ts) with the 5 optional/nullable fields; `RetrievalComparisonStore.record` uses `Omit<...Record>` so the port picks them up.
- [x] T024 [US3] Mapped the 5 fields through DrizzleRetrievalComparisonStore. Mock stores (tests) construct the record via the optional fields → unaffected.
- [x] T025 [US3] Built name-keyed `ragVectorList`/`ragLlmList` in `runFullAssessment` directly from the engine response (`srcOf(b)` with the `retrieval_score>0`⇒`["vector"]` fallback), returned alongside ragList/llmListRaw/ragCase; extended `FullAssessmentResult`. Names match finalList (finding 2).
- [x] T026 [US3] Extended `RecordComparisonParams` + `recordComparison` to compute the 3 per-source counts; kept existing counts + fire-and-forget; threaded the 2 lists from routes/reflection.ts via `fullResult`.
- [ ] T027 [US3] Unit tests GREEN (recorder 2/2); typecheck clean; full suite 342 pass / 16 known-red / 358 — no regressions. ⛔ **Migration NOT applied** — loop stop condition: awaiting explicit user go-ahead before running against the shared Supabase (also blocked on the missing-0006-snapshot drift; see T022).

**Checkpoint**: Confirmation-rate-per-source dataset is queryable (SC-003).

---

## Phase 6: Polish & Cross-Cutting

- [ ] T028 [P] Run the full quickstart in specs/005-bias-provenance-tracking/quickstart.md end-to-end (or against fixtures) and confirm SC-001..SC-006
- [ ] T029 [P] Confirm model-call count per assessment is unchanged (SC-004) — no new provider call introduced anywhere in the diff
- [ ] T030 Verify `context_source` has no live consumer before removal (review finding 4): `grep -rn "context_source" --include=*.ts --include=*.tsx . | grep -v node_modules` — only source + the generated `api/index.js` bundle should appear; regenerate the bundle if present. Then update docs/integration-map.md / docs/decisions cross-refs that enumerate `context_source` → `engineSources`, and note the engine-side contract-array follow-up from research R1

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Setup. BLOCKS US1 and US3 (both consume the extended engine types + `normalizeSource`).
- **US1 (Phase 3)**: after Foundational. Delivers the MVP. T010 (signature) BEFORE T011 (lookup).
- **US2 (Phase 4)**: after US1 (extends the same `buildBiasContext` fallback branch).
- **US3 (Phase 5)**: after Foundational; the name-keyed split (T025) reuses `normalizeSource` from Phase 2 but is independent of US1's map. Can run in parallel with US1/US2 once Phase 2 is done. Order within: schema T021 → migration T022 → port T023 → store T024 → service split T025 → recorder+route T026.
- **Polish (Phase 6)**: after all stories.

### Within Each Story

- Tests written first and failing, then implementation, then green.
- US1: T008 (map) → T009 (capture) → T010 (signature) → T011 (lookup) → T012 (schema).

### Parallel Opportunities

- T002 (contract test) is [P] until T003/T004 land.
- US1 tests T006/T007 [P]; US3 tests T019/T020 [P]; polish T028/T029 [P].
- After Phase 2: one developer takes US1+US2, another takes US3 (different files; shared only via the already-merged engine-client types + `normalizeSource`).

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 Setup → 2. Phase 2 Foundational (engine types + normalizer) → 3. Phase 3 US1 → **STOP & validate**: three-way provenance visible on results.

### Incremental Delivery

1. Foundational ready.
2. US1 → provenance on live results (MVP).
3. US2 → fallback/back-compat locked in.
4. US3 → persisted per-source dataset (the measurement payoff).

---

## Notes

- [P] = different files, no incomplete-task dependency.
- All engine-response and schema additions are additive/nullable (back-compat, D014/D011).
- Persisted per-source lists and `finalList` are keyed by bias **name** (review finding 2).
- `engineSources` is observability-only — never fed back into the assessment prompt (D015 non-goal).
- `ragCase`/`ragStatus` disambiguation of `engineSources==[]` stays storage-side (review finding 3).
- Commit cadence per repo convention: one-line `feat|fix|chore(T0XX): <desc>`, only when the user asks.
