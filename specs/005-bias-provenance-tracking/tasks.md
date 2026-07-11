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

- [ ] T006 [P] [US1] Unit test in tests/unit/context-builder-provenance.test.ts: `buildBiasContext` returns an `engineSources` map with `["vector"]`/`["llm"]`/`["vector","llm"]`, normalizes ids underscore→hyphen, and falls back to `["vector"]` when `source` is null but `retrieval_score>0` — must FAIL first
- [ ] T007 [P] [US1] Unit test in tests/unit/assessment-provenance.test.ts: per-bias `engineSources` resolves via `map.get(id) ?? []` inside `callProvider`, and the two `[]` cases stay separable via `ragCase` (data-model.md §2 table) — must FAIL first

### Implementation for User Story 1

- [ ] T008 [US1] Extend `BiasContextResult` in src/rag/context-builder.ts with `engineSources: Map<string, ("vector"|"llm")[]>`; build it in `buildBiasContext` from each retrieved bias's normalized `source` (hyphenated id), applying the `retrieval_score>0` ⇒ `["vector"]` fallback when `source` is null (research R3); return empty map for Case B/C
- [ ] T009 [US1] In src/orchestrators/reflection/assessment.service.ts: capture `ctx.engineSources` at both `buildBiasContext` call sites (~L93 in `runStoryOnlyAssessment`, ~L175 in `runFullAssessment`) into a local, alongside the existing `retrievedIds`
- [ ] T010 [US1] In src/orchestrators/reflection/assessment.service.ts: **extend `callProvider`'s signature** (~L209) with `engineSourcesMap: Map<string, ("vector"|"llm")[]> = new Map()` and pass it from BOTH call sites (~L100, ~L198) — WITHOUT this the L371 lookup reads an undefined map and yields `[]` for every bias (review finding 1)
- [ ] T011 [US1] In src/orchestrators/reflection/assessment.service.ts (~L371): replace the `context_source: "retrieved"|"roster"` derivation with `engineSources = engineSourcesMap.get(result.id ?? "") ?? []` on each normalized bias; keep `ragCase` available for downstream disambiguation (do NOT collapse the two `[]` meanings; do NOT add `ragCase` to the per-bias output — storage-only, review finding 3)
- [ ] T012 [US1] Update src/contracts/reflection.schemas.ts (~L61): replace `context_source: z.enum(["retrieved","roster"]).optional()` with `engineSources: z.array(z.enum(["vector","llm"])).optional()` per data-model.md §2
- [ ] T013 [US1] Confirm no prompt/context change: the provenance is computed AFTER the model call; verify the prompt builder path is untouched (FR-011/FR-012)
- [ ] T014 [US1] Run US1 tests green (T006, T007) and `pnpm typecheck`

**Checkpoint**: Live assessment results carry three-way provenance; MVP demonstrable.

---

## Phase 4: User Story 2 — Fallback & backward compatibility (Priority: P2)

**Goal**: Responses without `source` (vector_only/nli_union, and legacy v1/v2) resolve provenance via
the retained `retrieval_score` inference rule with zero regressions. (ADR D015 Decision 1 "Do not".)

**Independent Test**: Run assessments under a `source`-less strategy; provenance resolves to
`["vector"]` for retrieved biases, no errors, existing behavior unchanged.

### Tests for User Story 2

- [ ] T015 [P] [US2] Unit test in tests/unit/context-builder-fallback.test.ts: engine response with NO `source` on any bias yields `engineSources` = `["vector"]` for every `retrieval_score>0` bias and excludes `retrieval_score=0` biases (Case B unchanged) — must FAIL first
- [ ] T016 [P] [US2] Unit test in tests/unit/context-builder-provenance.test.ts (extend): mixed response (some biases with `source`, some null) resolves each bias independently — must FAIL first

### Implementation for User Story 2

- [ ] T017 [US2] Verify the T008 fallback branch handles null/absent `source` **per-bias** (not per-response) so mixed responses are correct; adjust `buildBiasContext` if the map-build short-circuits on the first null
- [ ] T018 [US2] Run US2 tests green and re-run the full suite to confirm no regression in existing RAG/context tests (`pnpm vitest run`)

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

- [ ] T019 [P] [US3] Unit test in tests/unit/comparison-recorder-per-source.test.ts: given name-keyed `ragVectorList`/`ragLlmList`, `recordComparison` computes `ragVectorHitFinal`/`ragLlmHitFinal`/`ragBothHitFinal` against `finalList` (all **names**), a both-bias appears in both lists, without inflating aggregate `ragHitFinal` — must FAIL first
- [ ] T020 [P] [US3] Unit test in tests/unit/comparison-recorder-per-source.test.ts (extend): store throwing still resolves without propagating (fire-and-forget, FR-010) — must FAIL first

### Implementation for User Story 3

- [ ] T021 [US3] Add additive nullable columns to `retrievalComparisons` in src/db/schema.ts: `ragVectorList`/`ragLlmList` (jsonb), `ragVectorHitFinal`/`ragLlmHitFinal`/`ragBothHitFinal` (integer), all nullable (data-model.md §3)
- [ ] T022 [US3] Generate the additive migration (`pnpm drizzle-kit generate`) producing src/db/migrations/0007_*.sql; confirm it only ADDs nullable columns (no drop/rename)
- [ ] T023 [US3] Extend `RetrievalComparisonStore.record()` param type in src/persistence/ports.ts with the five new nullable fields
- [ ] T024 [US3] Map the new fields through the Drizzle store in src/persistence/retrieval-comparison-store.ts; confirm the mock/noop store path ignores them unchanged
- [ ] T025 [US3] Build the name-keyed split in src/orchestrators/reflection/assessment.service.ts `runFullAssessment`: from the engine response, `ragVectorList = biases.filter(b => src(b).includes("vector")).map(b => b.name)` and `ragLlmList` for `"llm"` (where `src(b)` is the normalized `source` with the `retrieval_score>0` ⇒ `["vector"]` fallback), and return them alongside `ragList`/`llmListRaw`/`ragCase` — lists MUST be **names** to match `finalList` (review finding 2)
- [ ] T026 [US3] Extend `RecordComparisonParams` + `recordComparison` in src/observability/comparison-recorder.ts to accept `ragVectorList`/`ragLlmList` (names) and compute `ragVectorHitFinal`/`ragLlmHitFinal`/`ragBothHitFinal` against `finalList`, keeping existing counts and the try/catch fire-and-forget path intact; thread the two lists from src/routes/reflection.ts (~L124 `recordComparison(...)`) via `fullResult`
- [ ] T027 [US3] Run US3 tests green, `pnpm typecheck`, and apply the migration against a local/dev DB to confirm it applies cleanly

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
