# Tasks: RAG Integration

**Input**: Design documents from `specs/004-rag-integration/`

**Prerequisites**: plan.md, spec.md, data-model.md

**Path convention**: `src/` at repository root (`biassemble-core/`)

**Tests**: Not requested. No test tasks generated.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = Tiered Context, US2 = Graceful Degradation, US3 = Comparison Recording
- Include exact file paths in descriptions

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: DB schema, ports, migration, env vars — blocks all three user stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T001 Add `ragResult: jsonb("rag_result")` nullable column to `runs` table in `src/db/schema.ts`
- [ ] T002 Add `retrievalComparisons` table to `src/db/schema.ts` — columns: id (uuid PK), sessionId (uuid notNull), runId (uuid FK→runs.id nullable), ragList (jsonb notNull), llmList (jsonb notNull), finalList (jsonb notNull), overlap (integer notNull), ragOnly (integer notNull), llmOnly (integer notNull), ragHitFinal (integer notNull), llmHitFinal (integer notNull), normalizationAdditions (integer notNull), ragStatus (text notNull), createdAt (timestamptz notNull defaultNow); index on sessionId
- [ ] T003 [P] Add `RetrievalComparisonRecord` type to `src/persistence/types.ts` matching the table columns (camelCase fields, ragStatus: `"retrieved" | "roster_fallback" | "unavailable"`)
- [ ] T004 Extend `RunStore` interface in `src/persistence/ports.ts` — add `storeRagResult(runId: string, result: unknown): Promise<void>` and `getRagResultForSession(sessionId: string): Promise<unknown | null>`
- [ ] T005 Add `RetrievalComparisonStore` interface to `src/persistence/ports.ts` — `record(data: Omit<RetrievalComparisonRecord, "id" | "createdAt">): Promise<void>`
- [ ] T006 Add query functions to `src/db/queries.ts`: `updateRunRagResult(runId, ragResult)` (update runs.rag_result), `getRagResultBySession(sessionId)` (select rag_result from most recent initial_assessment run for session), `insertRetrievalComparison(data)` (insert into retrieval_comparisons)
- [ ] T007 Create `src/db/migrations/0004_rag_integration.sql` — ALTER TABLE core.runs ADD COLUMN rag_result JSONB; CREATE TABLE core.retrieval_comparisons with all columns and session_id index; update meta/_journal.json
- [ ] T008 [P] Add `RAG_ENGINE_URL: z.string().url()` (required), `RAG_API_KEY: z.string().min(1)` (required), `RAG_TIMEOUT_MS: z.coerce.number().int().positive().default(500)` to `src/lib/env.ts`

**Checkpoint**: Run `pnpm typecheck`. Schema compiles, ports compile, migration file exists. No regressions on `pnpm test`.

---

## Phase 2: User Story 1 — Tiered Context Injection (Priority: P1) 🎯 MVP

**Goal**: Assessment prompt uses full documents for retrieved biases (Tier 1) + roster for all 38 (Tier 2) when retrieval returns real candidates.

**Independent Test**: Mock `RagEngineClient.retrieve()` to return a response with 2 biases having `retrieval_score > 0`; verify `prompts.render()` receives a `biasContext` string containing the full document fields (examples, indicators, etc.) for those biases and name+definition for all 38; verify returned `AssessmentOutput.biases` have `context_source: "retrieved"` for the matched biases.

- [ ] T009 [P] [US1] Create `src/rag/engine-client.ts` — define `BiasResult` (id, name, retrieval_score, definition, examples, indicators, false_positives, related_biases), `EngineResponse` (biases, retrieved_chunks, taxonomy_version, embedding_model, request_id), `RagClientResult` discriminated union (`{ status: "ok"; data: EngineResponse } | { status: "unavailable" } | { status: "auth_error" }`), and `RagEngineClient` class constructor accepting `(url: string, apiKey: string, timeoutMs: number)`; stub `retrieve(story: string): Promise<RagClientResult>` — success path only: fetch POST with Bearer auth and AbortController timeout, return `{ status: "ok", data }` on 200 with valid `EngineResponse` shape
- [ ] T010 [P] [US1] Create `src/rag/context-builder.ts` — define `RagCase` (`"retrieved" | "roster_fallback" | "unavailable"`), `BiasContextResult` (`{ biasContext: string; ragCase: RagCase; retrievedIds: Set<string> }`), and `buildBiasContext(result: RagClientResult, catalog: BiasEntry[]): BiasContextResult` — Case A only: when `result.status === "ok"` and at least one bias has `retrieval_score > 0`, format Tier 1 block (name + definition + examples + indicators + false_positives + related_biases for each retrieved bias) followed by Tier 2 block (name + definition for all 38 from catalog); `retrievedIds` = Set of ids with score > 0
- [ ] T011 [US1] Implement `DrizzleRunStore.storeRagResult()` and `getRagResultForSession()` in `src/persistence/run-store.ts` using `updateRunRagResult()` and `getRagResultBySession()` from `src/db/queries.ts`
- [ ] T012 [US1] Update `AssessmentService` constructor in `src/orchestrators/reflection/assessment.service.ts` — add optional `ragClient?: RagEngineClient` parameter (last param, so existing call sites compile unchanged)
- [ ] T013 [US1] Update `runStoryOnlyAssessment` in `src/orchestrators/reflection/assessment.service.ts` — after run created: if `ragClient` present, `const ragResult = await ragClient.retrieve(story)`; kick off `runStore.storeRagResult(runId, ragResult.status === "ok" ? ragResult.data : null)` without await (fire-and-forget — stores raw `EngineResponse` or null, matching the data model); call `buildBiasContext(ragResult, catalog.getAll())`; pass `{ biasContext }` to `prompts.render("assessment", { biasContext })` (replaces `{ biasShortlist }`)
- [ ] T014 [US1] Thread `ragCase` and `retrievedIds` from `buildBiasContext` result into `callProvider()` signature in `src/orchestrators/reflection/assessment.service.ts` — after `normalizedBiases` is computed, derive `context_source` per bias: `retrievedIds?.has(bias.biasCatalogId ?? "") ? "retrieved" : "roster"`; add inline comment: `// Engine BiasResult.id and local BiasEntry.id must share the same format (e.g. "confirmation_bias") — see ADR D014`
- [ ] T015 [P] [US1] Rename `{{biasShortlist}}` → `{{biasContext}}` in `src/prompts/reflection/assessment/system.md`
- [ ] T016 [P] [US1] Bump `version` to `"1.2.0"` in `src/prompts/reflection/assessment/system.json`
- [ ] T017 [US1] Add `context_source: z.enum(["retrieved", "roster"]).optional()` to `BiasItem` schema in `src/contracts/reflection.schemas.ts`
- [ ] T018 [US1] Construct `RagEngineClient(env.RAG_ENGINE_URL, env.RAG_API_KEY, env.RAG_TIMEOUT_MS)` in `src/server.ts` and inject into `AssessmentService` constructor

**Checkpoint**: `pnpm typecheck` passes. Assessment service compiles with the new optional `ragClient` param. Prompt version is 1.2.0. `generate()` backward-compat path still works.

> **Coupling note**: T013 and T015 must both be complete before integration testing — the template variable rename (`{{biasShortlist}}` → `{{biasContext}}`) and the render call update are atomic; deploying one without the other breaks rendering.

---

## Phase 3: User Story 2 — Graceful Degradation (Priority: P2)

**Goal**: Assessment continues with roster-only context when retrieval fails (Case C) or returns no real candidates (Case B). User never sees a RAG error.

**Independent Test**: Mock `ragClient.retrieve()` to return `{ status: "unavailable" }` (Case C) and a response with all `retrieval_score: 0.0` (Case B); in both cases assessment must succeed, `biasContext` must equal the plain roster string, all biases must have `context_source: "roster"`, and logs must contain the correct `rag_context` field.

- [ ] T019 [US2] Extend `RagEngineClient.retrieve()` error paths in `src/rag/engine-client.ts` — 401/403 → log `rag_auth_error` at warn, return `{ status: "auth_error" }`; 5xx / network error / AbortError timeout → log `rag_fallback` at info, return `{ status: "unavailable" }`; response body parses as JSON but fails `EngineResponse` shape check (missing or invalid `biases` array) → log `rag_invalid_response` at warn, return `{ status: "unavailable" }`; never throw
- [ ] T020 [US2] Add Cases B and C to `buildBiasContext()` in `src/rag/context-builder.ts` — Case B: `result.status === "ok"` and all `retrieval_score === 0.0` → roster-only, `ragCase: "roster_fallback"`, `retrievedIds: new Set()`; add comment: `// Case B detection: all retrieval_score=0.0 means engine returned roster fallback — see ADR D014`; Case C: `result.status !== "ok"` → roster-only, `ragCase: "unavailable"`, `retrievedIds: new Set()`
- [ ] T021 [US2] Update `runFullAssessment` in `src/orchestrators/reflection/assessment.service.ts` — fetch stored `EngineResponse | null` via `runStore.getRagResultForSession(sessionId)`; reconstruct `RagClientResult`: `null → { status: "unavailable" }`, non-null (stored `EngineResponse`) → `{ status: "ok", data: stored }`; call `buildBiasContext()`; pass `{ biasContext }` to render; when `ragCase` is `"roster_fallback"` or `"unavailable"`, set `context_source: "roster"` on all output biases unconditionally
- [ ] T022 [US2] Add `rag_context: ragCase` to the info-level LLM call log in both `runStoryOnlyAssessment` and `runFullAssessment` in `src/orchestrators/reflection/assessment.service.ts`

**Checkpoint**: `pnpm typecheck` and `pnpm test` pass. `generate()` path compiles. Both `runStoryOnlyAssessment` and `runFullAssessment` handle null ragResult without error.

---

## Phase 4: User Story 3 — Comparison Recording (Priority: P3)

**Goal**: One `retrieval_comparisons` row written fire-and-forget per completed `runFullAssessment`, tracking retrieval-vs-LLM alignment.

**Independent Test**: Complete a full session; query `SELECT * FROM core.retrieval_comparisons WHERE session_id = $1`; verify one row with correct `rag_status`, non-null `rag_list`, `llm_list`, `final_list`, and that count fields are internally consistent (overlap ≤ min(|rag_list|, |llm_list|)).

- [ ] T023 [US3] Implement `DrizzleRetrievalComparisonStore` in `src/persistence/retrieval-comparison-store.ts` — `record()` calls `insertRetrievalComparison()` from `src/db/queries.ts`; export class
- [ ] T024 [US3] Create `src/observability/comparison-recorder.ts` — define `RecordComparisonParams` (`sessionId, runId, ragList, llmListRaw, finalList, ragCase`); implement `recordComparison(params, store: RetrievalComparisonStore)`: compute overlap (`|rag ∩ llm|`), ragOnly (`|rag - llm|`), llmOnly (`|llm - rag|`), ragHitFinal (`|rag ∩ final|`), llmHitFinal (`|llm ∩ final|`), normalizationAdditions (`|final - rag - llm|`); call `store.record()` wrapped in try/catch — log warn on error, never throw
- [ ] T025 [US3] Move comparison recording out of `callProvider()` and into the route: (1) extend `callProvider()` return type to `{ output: AssessmentOutput; llmListRaw: string[] }`, capturing `parsed.biases.map(b => b.name)` before normalization; (2) extend `runFullAssessment` return type to `{ output: AssessmentOutput; runId: string; ragCase: RagCase; ragList: string[]; llmListRaw: string[] }` — no `ragCase`/`ragList` in `callProvider` signature; (3) in `src/routes/reflection.ts`, after `runFullAssessment` returns, call `recordComparison({ sessionId, runId, ragList, llmListRaw, finalList: output.biases.map(b => b.name), ragCase }, comparisonStore)` without await; (4) add `comparisonStore: RetrievalComparisonStore` to `AssessmentService` constructor
- [ ] T026 [US3] Construct `DrizzleRetrievalComparisonStore` in `src/server.ts` and inject into `AssessmentService`

**Checkpoint**: `pnpm typecheck` and `pnpm test` pass. Full suite green. No regressions.

---

## Phase 5: Deployment

**Purpose**: Apply schema migration to production and set environment variables.

- [ ] T027 Run `pnpm db:migrate` against production Supabase to apply `0004_rag_integration.sql` — verify `rag_result` column exists on `core.runs` and `core.retrieval_comparisons` table exists
- [ ] T028 Set `RAG_ENGINE_URL`, `RAG_API_KEY`, `RAG_TIMEOUT_MS` in Vercel environment (production + preview)
- [ ] T029 Smoke test: trigger one full assessment session in staging; confirm `retrieval_comparisons` row written with correct `rag_status`; confirm `rag_result` populated on the story-only `runs` row

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately
- **Phase 2 (US1)**: Depends on Phase 1 complete
- **Phase 3 (US2)**: Depends on Phase 2 complete — extends same files (engine-client, context-builder, assessment.service)
- **Phase 4 (US3)**: Depends on Phase 1 (schema) and Phase 3 complete (needs ragCase + normalized biases in callProvider)
- **Phase 5 (Deployment)**: Depends on Phase 1 (migration file) — deploy only after all phases tested

### Within-Phase Parallel Opportunities

**Phase 1**: T001→T002 (same file, sequential); T003 and T008 [P] with each other and with T001-T007; T004→T005 (same file, sequential); T006 after T001-T002; T007 after T001-T002

**Phase 2**: T009 [P] T010 (different new files); T015 [P] T016 (different prompt files); T011-T014 and T017-T018 are sequential

**Phase 3**: T019-T022 are sequential (all extend Phase 2 files)

**Phase 4**: T023 [P] with T024 (different new files); T025-T026 sequential

### Parallel Launch — Phase 1

```
# These can run simultaneously:
T003 — src/persistence/types.ts
T008 — src/lib/env.ts

# After T001+T002 complete:
T006 — src/db/queries.ts
T007 — src/db/migrations/0004_rag_integration.sql
```

### Parallel Launch — Phase 2

```
# These can run simultaneously:
T009 — src/rag/engine-client.ts (new file)
T010 — src/rag/context-builder.ts (new file)
T015 — src/prompts/reflection/assessment/system.md
T016 — src/prompts/reflection/assessment/system.json
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Complete Phase 1 (Foundational)
2. Complete Phase 2 (US1 — Tiered Context)
3. **STOP and VALIDATE**: `pnpm typecheck && pnpm test`; manually trigger assessment with engine returning real candidates; confirm tiered prompt structure
4. Deploy Phase 5 if validated

### Incremental Delivery

1. Phase 1 → foundation ready
2. Phase 2 (US1) → tiered context works on Case A
3. Phase 3 (US2) → degradation handles Cases B/C, logging correct
4. Phase 4 (US3) → comparison rows written
5. Phase 5 → production deploy

---

## Notes

- `generate()` backward-compat: the optional `ragClient` param (T012) ensures existing call sites compile unchanged; `generate()` will use roster-only context
- T015 + T013 are coupled: renaming `{{biasShortlist}}` → `{{biasContext}}` in the template (T015) must happen in the same deploy as updating the render call (T013); T009/T010/T015/T016 are safe to develop in parallel but T013 and T015 must both be complete before integration testing
- T025 threads `ragCase` and `ragList` into `callProvider()` — `ragList` is bias names from `EngineResponse.biases` where `retrieval_score > 0` (or `[]` on Cases B/C); extract before `buildBiasContext()` returns its `retrievedIds`
