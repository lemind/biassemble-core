# Tasks: Async RAG — Fire at Story Submission

**Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Data model**: [data-model.md](data-model.md)

## Format: `[ID] [P?] [Story?] Description — file path`

- **[P]**: Safe to run in parallel (different files, no incomplete dependencies)
- **[US1/2/3]**: User story this task belongs to
- No label = Setup or Foundational (runs before any user story work)

---

## Phase 1: Foundational — DB Schema + RunStore Extension

**Purpose**: `rag_started_at` column and new RunStore methods are required by all three user stories. No user story work can begin until this phase is complete.

**⚠️ CRITICAL**: Blocks all downstream phases.

- [x] T001 [P] Create migration file `src/db/migrations/0005_async_rag_submission.sql` — single statement: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS rag_started_at TIMESTAMPTZ;` (shipped as `0007_async_rag_submission.sql` — next available number; migrations 0005–0006 were already taken)
- [x] T002 [P] Add `ragStartedAt: timestamp("rag_started_at")` nullable column to the `runs` table definition in `src/db/schema.ts`
- [x] T003 [P] Add `updateRagStartedAt(runId: string, startedAt: Date): Promise<void>` and `getRagStartedAtBySession(sessionId: string): Promise<Date | null>` to `src/db/queries.ts` — `getRagStartedAtBySession` reads from the most recent `initial_assessment` run for the session
- [x] T004 [P] Extend `RunStore` interface in `src/persistence/ports.ts` with `recordRagStarted(runId: string, startedAt: Date): Promise<void>` and `getRagStartedAtForSession(sessionId: string): Promise<Date | null>` — add Stage 005 comment
- [x] T005 Implement `recordRagStarted()` and `getRagStartedAtForSession()` in `src/persistence/run-store.ts` — both best-effort, non-throwing; wrap in try/catch, log warn on failure, never propagate (D011 discipline)

**Checkpoint**: Migration, schema, queries, and RunStore interface all ready — user story implementation can begin.

---

## Phase 2: User Story 1 — Questions appear immediately after story submission (P1) 🎯 MVP

**Goal**: Fire RAG as a background Inngest job at story submission. Remove the blocking `await ragClient.retrieve()` from the story_only path. LLM question generation and initial assessment return in ~3s.

**Independent Test**: Call `POST /v1/reflection/assessment` with `mode: "story_only"`. Verify response arrives in < 5s. Verify `RagEngineClient.retrieve` is never called (Inngest send called instead). Verify `rag_job_fired` appears in logs.

- [x] T006 [US1] Create `src/jobs/rag-retrieve.ts` — Inngest function for background RAG retrieval:
  - Event name: `"rag/retrieve.requested"`, data: `{ story: string; sessionId: string; runId: string; startedAt: string }`
  - Function body: `ragClient.retrieve(story)` → `runStore.storeRagResult(runId, result.status === "ok" ? result.data : null)` → log `rag_retrieve_complete` with `{ status, sessionId, runId, durationMs }`
  - Entire body wrapped in try/catch — never throws; log failures at warn level
  - Implemented as a `createRagRetrieveJob(ragClient, runStore)` factory rather than a static export — the job needs `ragClient`/`runStore` injected from `server.ts` (see T009)
- [x] T007 [US1] Register `ragRetrieveJob` in `src/jobs/inngest-functions.ts` — `inngestFunctions` became `buildInngestFunctions(ragRetrieveJob?)` since the job instance is constructed in `server.ts`, not statically importable; omits the job when RAG isn't configured
- [x] T008 [US1] Update `runStoryOnlyAssessment` in `src/orchestrators/reflection/assessment.service.ts`:
  - Added optional `inngestClient?: Inngest` to `AssessmentService` constructor
  - **Removed** `await this.ragClient.retrieve(story)` — the blocking call
  - **Added** `inngestClient.send({ name: "rag/retrieve.requested", data: { story, sessionId, runId, startedAt: startedAt.toISOString() } })` with `.then()` logging `rag_job_fired` and `.catch()` logging `rag_job_fire_failed` — fire-and-forget, always logs
  - **Added** `runStore.recordRagStarted(runId, startedAt)` immediately after — best-effort, non-blocking (`.catch()` no-op since the store already logs internally)
  - **Changed context**: story_only always uses roster-only context (`buildBiasContext({ status: "unavailable" }, catalog)`)
  - Logs `rag_job_fired` at info level after successful send
- [x] T009 [US1] Update `src/server.ts` — passes `ragClient` to `createRagRetrieveJob` factory (only when `ragClient` is configured) and `inngestClient` (the `inngest` client instance) to `AssessmentService` constructor

**Checkpoint**: Story submission returns questions in < 5s. RAG runs in Inngest background. US1 independently testable.

---

## Phase 3: User Story 2 — Assessment uses enriched context when RAG completed during think time (P2)

**Goal**: Full assessment checks whether RAG completed (adaptive wait ≤ 2s), builds a bias workspace from the stored result, and passes structured candidate context to the assessment LLM.

**Independent Test**: Write a mock `rag_result` directly to `runs` for a session (bypassing Inngest). Call `POST /v1/reflection/assessment` with `mode: "full"` after 90s (simulated). Verify the assessment response contains bias evidence from the stored result and `context_source: "retrieved"` on matched biases. Verify `rag_available: true` in logs.

- [x] T010 [US2] Create `src/rag/workspace-builder.ts`:
  - Types: `WorkspaceCase = "retrieved" | "unavailable"`, `BiasCandidate = { bias_id, name, confidence, evidence, source }`, `BiasWorkspace = { candidates, workspaceCase, retrievedIds }`
  - `buildBiasWorkspace(result: RagClientResult, catalog: BiasEntry[]): BiasWorkspace` — Case READY: build candidates from retrieved biases (confidence = retrieval_score, evidence = indicators); Case unavailable/roster_fallback: `candidates = []`, `workspaceCase = "unavailable"`
  - `renderWorkspaceToPrompt(workspace: BiasWorkspace, catalog: BiasEntry[]): string` — READY: render candidate table + roster; unavailable: render roster-only
- [x] T011 [US2] Updated `runFullAssessment` in `src/orchestrators/reflection/assessment.service.ts` — adaptive wait implemented exactly as specced: `getRagResultForSession` → if null, `getRagStartedAtForSession` (skip wait if null) → if `elapsedMs >= RAG_POLL_THRESHOLD_MS` poll every 200ms up to a 2s ceiling. `RAG_POLL_THRESHOLD_MS`/`RAG_POLL_INTERVAL_MS`/`RAG_POLL_CEILING_MS` extracted as named module-level constants; narrow-poll-window tradeoff documented in a comment at the poll site.
- [x] T012 [US2] Renamed `{{biasContext}}` → `{{candidateBiases}}` in `src/prompts/reflection/assessment/system.md` **and also in `src/prompts/reflection/assessment/system.json`'s `content` field** — the spec only named `system.md`, but `PromptRegistry.render()` actually reads `system.json`'s `content` string at runtime (`system.md` is unused/doc-only, already stale relative to `system.json` before this change). Renaming only `system.md` would have left the live template's `{{biasContext}}` placeholder unsubstituted once T014 landed. Landed together with T014 as specified.
- [x] T013 [P] [US2] Bumped `version` to `"1.3.0"` in `src/prompts/reflection/assessment/system.json`. Also updated 3 tests that hardcoded the old prompt version (`assessment.test.ts`, `llm-call-recording-assessment.test.ts`, `llm-call-recording-question.test.ts`) — not in the original task list, but a direct, mechanical consequence of this version bump; left unfixed they'd fail.
- [x] T014 [US2] Updated all `prompts.render("assessment", { biasContext: ... })` call sites to `{ candidateBiases: ... }` — both in T008's story_only roster render and T011's full assessment workspace render. Landed together with T012 as specified.
- [x] T015 [P] [US2] Updated `context_source` enum in `src/contracts/reflection.schemas.ts` to `z.enum(["retrieved", "llm", "both"])` with backward-compat comment (pre-005 rows have `"roster"`, treat as `"llm"` on read — comment only, no runtime mapping code, per spec wording)
- [x] T016 [US2] Updated `context_source` derivation in `callProvider()` — `"retrieved"` if `retrievedIds.has(biasCatalogId)`, otherwise `"llm"` (no longer gated on `ragCase`, since `retrievedIds` is only ever non-empty in the retrieved case). Comment added noting `"both"` is unreachable dead-code-in-enum pending a follow-on spec.

**Checkpoint**: Full assessment uses retrieved bias workspace when RAG finished in time. Degrades to roster-only silently when not. US2 independently testable without US3.

---

## Phase 4: User Story 3 — Race outcome recorded for analytics (P3)

**Goal**: Every completed full assessment logs whether RAG was available in time (`rag_available`) and how long the system waited (`rag_wait_ms`). This data validates the ~76s latency assumption and miss-rate estimate from D015.

**Independent Test**: Call full assessment (both with and without stored RAG result). Check Pino structured log output — verify `rag_available: true/false` and `rag_wait_ms: <number>` are present on the assessment completion log line.

- [ ] T017 [US3] Add telemetry logging in `runFullAssessment` in `src/orchestrators/reflection/assessment.service.ts` — after the adaptive wait block resolves, log at info level: `{ rag_available: workspace.workspaceCase === "retrieved", rag_wait_ms: <ms spent polling> }` — `rag_wait_ms` is 0 if READY on first read, 0 if adaptive wait skipped, elapsed poll time otherwise

**Checkpoint**: All three user stories complete. `rag_available` and `rag_wait_ms` visible in production logs.

---

## Phase 5: Polish & Deployment

**Purpose**: Tests, deployment steps, and smoke validation.

- [ ] T018 [P] Write unit tests for `src/rag/workspace-builder.ts` in `tests/unit/rag/workspace-builder.test.ts` — retrieved case (candidates built, confidence = retrieval_score), unavailable case (empty candidates, roster-only render), Case B / roster_fallback (all scores = 0.0 → maps to unavailable)
- [ ] T019 [P] Write unit tests for `src/jobs/rag-retrieve.ts` in `tests/unit/jobs/rag-retrieve.test.ts` — success path calls `storeRagResult(runId, engineData)` and does not throw; failure path calls `storeRagResult(runId, null)` and does not throw; log `rag_retrieve_complete` on success; log warn on catch
- [ ] T020 [P] Write integration test in `tests/integration/async-rag-assessment.test.ts` — three scenarios:
  1. story_only fast path: mock `inngestClient.send` called, `ragClient.retrieve` NOT called, response < 5s
  2. full assessment READY immediately: mock `getRagResultForSession` returns stored result on first read, `rag_available: true, rag_wait_ms: 0` logged
  3. full assessment RUNNING-then-completes: `getRagResultForSession` returns null on first read, `getRagStartedAtForSession` returns `Date.now() - 72_000` (elapsed ≥ 70s), poll returns result within 2s, `rag_available: true, rag_wait_ms > 0` logged — this covers US3 acceptance scenario 2 and the polling loop ceiling
  4. full assessment never ready: `getRagResultForSession` always null, `rag_available: false` logged, assessment completes with roster-only context
- [ ] T021 Run `pnpm db:migrate` against Supabase to apply `0007_async_rag_submission.sql` — verify `rag_started_at` column present on `runs` table
- [ ] T022 [P] Set `RAG_TIMEOUT_MS=120000` in Vercel environment dashboard (currently 5000 in Vercel — already correct locally and on HF Space)
- [ ] T023 Smoke test on staging: submit story → verify questions return in < 5s; wait 90s → submit assessment → verify `rag_available: true` in Vercel function logs

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately. T001–T004 parallelizable; T005 sequential after T003+T004.
- **US1 (Phase 2)**: Requires Phase 1 complete. T006 first; T007+T008 can overlap after T006 exists; T009 after T008.
- **US2 (Phase 3)**: Requires Phase 1 complete. T010 independent; T011 after T010; T012+T013+T015 parallel (different files); T014 after T011+T012; T016 after T015.
- **US3 (Phase 4)**: Requires T011 (touches same function in assessment.service.ts) — T017 after T011+T016.
- **Polish (Phase 5)**: T018 after T010; T019 after T006; T020 after T008+T011; T021–T023 after all implementation.

### Within assessment.service.ts (touches same file — sequence carefully)

T008 → T011 → T014 → T016 → T017 (all modify `assessment.service.ts`; apply in this order to avoid conflicts)

### Parallel Opportunities

```
Phase 1:  T001 ‖ T002 ‖ T003 ‖ T004 → T005
Phase 2:  T006 → T007 ‖ T008 → T009
Phase 3:  T010 → T011 → T014
          T012 + T014 (atomic — same commit; T012 not [P])
          T013 ‖ T015 (parallel, different files)
          T016
Phase 4:  T017 (after T016; separate checkpoint)
Phase 5:  T018 ‖ T019 ‖ T020 (parallel, different test files)
          T021 ‖ T022 (parallel, independent)
```

---

## Implementation Strategy

### MVP (US1 only — latency fix)

1. Complete Phase 1 (Foundational)
2. Complete Phase 2 (US1) — questions return in < 5s
3. **STOP and VALIDATE**: story_only fast; Inngest job fires; no errors
4. Ship — core latency problem solved

### Incremental Delivery

1. Phase 1 + Phase 2 → story submission fast (MVP)
2. Phase 3 (US2) → full assessment enriched when RAG ready
3. Phase 4 (US3) → telemetry confirms miss-rate estimates
4. Phase 5 → tests + deployment hardened

---

## Notes

- T005 must not throw — `recordRagStarted` failure must not prevent story_only from returning questions (best-effort discipline from D011)
- Inngest `.catch()` in T008 must log — bare `.catch(() => {})` is not acceptable per plan review
- `ragStartedAt === null` guard in T011 is required — `recordRagStarted` is best-effort; null crash was a pre-review bug
- `"both"` is in the enum (T015) but will not be emitted by T016 — reserved for future merge of story_only LLM candidates
- Pre-005 DB rows with `context_source = "roster"` remain valid — treat as `"llm"` on read (no DB migration needed for enum change)
