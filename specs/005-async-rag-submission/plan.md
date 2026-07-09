# Implementation Plan: Async RAG — Fire at Story Submission

**Branch**: `005-async-rag-submission` | **Date**: 2026-07-09 | **Spec**: [spec.md](spec.md)

**ADR**: [D015](../../docs/decisions/015-async-rag-fire-at-submission.md)

## Summary

Move RAG off the critical path. Currently `runStoryOnlyAssessment` awaits `ragClient.retrieve()` for ~76s before the LLM call, making story submission unusable. Fix: fire an Inngest background job at story submission, return LLM questions/initial assessment in ~3s, read the RAG result (written by Inngest) at full-assessment time with an adaptive ≤2s wait. Replace the tiered `{{biasContext}}` prompt with a structured `{{candidateBiases}}` workspace at full-assessment time.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 22 LTS

**Primary Dependencies**: Fastify 5, Zod 4, Drizzle ORM, Pino, Vitest, Inngest

**Storage**: PostgreSQL (Supabase) via Drizzle — `runs` table gains `rag_started_at TIMESTAMPTZ`

**Testing**: Vitest (unit + integration), same pattern as Stages 003–004

**Target Platform**: Node.js server, Vercel Functions (Inngest handles background lifecycle)

**Performance Goals**: Story submission ≤ 5s to questions; full assessment adaptive wait ≤ 2s

**Constraints**: RAG failures never fail the assessment (D011/D014 discipline). Inngest event send is fire-and-forget — if it fails, story_only proceeds with roster-only context silently.

**Key facts confirmed from codebase**:
- `RagEngineClient` (`src/rag/engine-client.ts`) — unchanged; used only by the Inngest function
- `buildBiasContext()` (`src/rag/context-builder.ts`) — kept for story_only roster-only path; workspace builder is a new file
- `runStore.storeRagResult()` / `getRagResultForSession()` — already exist; Inngest function uses them
- `inngest` client (`src/jobs/client.ts`) — already exported; `inngest.send()` is the pattern
- `inngestFunctions` array (`src/jobs/inngest-functions.ts`) — new function registered here
- `AssessmentService` already accepts optional `ragClient?: RagEngineClient` — add `inngestClient?: Inngest`
- `context_source` derivation in `callProvider()` — enum + logic update required

## Constitution Check

Constitution not filled in for this project (template placeholder). No gates to evaluate.

## Project Structure

### Documentation (this feature)

```text
specs/005-async-rag-submission/
├── plan.md              ← this file
├── spec.md
├── research.md
├── data-model.md
├── checklists/
│   └── requirements.md
└── tasks.md             ← /speckit-tasks output (not created here)
```

### Source Code

```text
src/
├── jobs/
│   ├── client.ts                         # unchanged
│   ├── inngest-functions.ts              # add ragRetrieveJob
│   └── rag-retrieve.ts                   # NEW: Inngest function for background RAG
├── rag/
│   ├── engine-client.ts                  # unchanged
│   ├── context-builder.ts                # unchanged (story_only roster path still uses it)
│   └── workspace-builder.ts              # NEW: buildBiasWorkspace() for full assessment
├── orchestrators/reflection/
│   └── assessment.service.ts             # fire Inngest; add adaptive wait; use workspace builder
├── persistence/
│   ├── ports.ts                          # extend RunStore: recordRagStarted(), getRagStartedAtForSession()
│   └── run-store.ts                      # implement new RunStore methods
├── db/
│   ├── schema.ts                         # add rag_started_at to runs
│   ├── queries.ts                        # updateRagStartedAt(), getRagStartedAtBySession()
│   └── migrations/
│       └── 0005_async_rag_submission.sql # ADD COLUMN rag_started_at
├── contracts/
│   └── reflection.schemas.ts             # context_source: "retrieved" | "llm" | "both"
├── server.ts                             # pass inngestClient to AssessmentService
└── prompts/
    └── reflection/assessment/
        ├── system.json                   # bump version to 1.3.0
        └── system.md                    # {{biasContext}} → {{candidateBiases}}

tests/
├── unit/
│   ├── rag/
│   │   └── workspace-builder.test.ts    # NEW
│   └── jobs/
│       └── rag-retrieve.test.ts         # NEW (mock ragClient + runStore)
└── integration/
    └── async-rag-assessment.test.ts     # NEW: story_only fast-path; full assessment with stored result
```

---

## Phases

### Phase 1: DB Schema + Migration

Foundation for adaptive wait timing. All later phases depend on this.

- Add `ragStartedAt` TIMESTAMPTZ nullable column to `runs` in `src/db/schema.ts`
- Add DB query functions to `src/db/queries.ts`:
  - `updateRagStartedAt(runId: string, startedAt: Date): Promise<void>`
  - `getRagStartedAtBySession(sessionId: string): Promise<Date | null>` — reads from the most recent `initial_assessment` run for the session
- Extend `RunStore` interface in `src/persistence/ports.ts`:
  - `recordRagStarted(runId: string, startedAt: Date): Promise<void>` — best-effort, non-throwing
  - `getRagStartedAtForSession(sessionId: string): Promise<Date | null>`
- Implement both methods in `src/persistence/run-store.ts`
- Create `src/db/migrations/0005_async_rag_submission.sql`: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS rag_started_at TIMESTAMPTZ;`

### Phase 2: Inngest RAG Background Job

Standalone. No dependency on Phase 1 beyond the `runStore` interface.

- Create `src/jobs/rag-retrieve.ts`:
  - Event name: `"rag/retrieve.requested"`
  - Event data type: `{ story: string; sessionId: string; runId: string; startedAt: string }`
  - Function body:
    1. `ragClient.retrieve(story)` — full 120s timeout budget (no HTTP deadline from the handler)
    2. `runStore.storeRagResult(runId, result.status === "ok" ? result.data : null)` — best-effort
    3. Log `rag_retrieve_complete` with `status`, `sessionId`, `runId`, `durationMs`
  - Never throws — wrap in try/catch, log failures at warn level
- Register in `src/jobs/inngest-functions.ts`: add `ragRetrieveJob` to `inngestFunctions` array
- `src/server.ts`: pass `ragClient` to the Inngest function via closure or DI at function-definition time

### Phase 3: Decouple RAG from story_only Path

Depends on Phases 1 and 2.

- Extend `AssessmentService` constructor: add optional `inngestClient?: Inngest` parameter
- Update `runStoryOnlyAssessment`:
  - **Remove**: `await this.ragClient.retrieve(story)` — the blocking call
  - **Add**: `inngestClient.send({ name: "rag/retrieve.requested", data: { story, sessionId, runId, startedAt: new Date().toISOString() } })` — fire-and-forget; `.catch((err) => logger.warn({ sessionId, err }, "rag_job_fire_failed"))` so send failure is non-fatal and always logged
  - **Add**: `runStore.recordRagStarted(runId, startedAt)` — best-effort, non-blocking
  - **Change context**: story_only now uses roster-only context always (call `buildBiasContext({ status: "unavailable" }, catalog)` or inline roster build — same result as Case C)
  - Log `rag_job_fired` at info level on successful send
- Update `src/server.ts`: construct `AssessmentService` with `inngestClient`

### Phase 4: Bias Workspace Builder

Depends on Phase 1 (`RagClientResult` types already exist from spec-004). Standalone otherwise.

- Create `src/rag/workspace-builder.ts`:
  - `WorkspaceCase` type: `"retrieved" | "unavailable"` (roster_fallback maps to unavailable — no RAG evidence)
  - `BiasCandidate` type: `{ bias_id: string; name: string; confidence: number; evidence: string; source: "retrieved" | "llm" | "both" }`
  - `BiasWorkspace` type: `{ candidates: BiasCandidate[]; workspaceCase: WorkspaceCase; retrievedIds: Set<string> }`
  - `buildBiasWorkspace(result: RagClientResult, catalog: BiasEntry[]): BiasWorkspace`
    - Case READY (`result.status === "ok"` and at least one `retrieval_score > 0`): build candidates from retrieved biases; `workspaceCase = "retrieved"`
    - Case unavailable (roster_fallback or non-ok status): `candidates = []`, `workspaceCase = "unavailable"` — caller falls back to roster-only context
  - `renderWorkspaceToPrompt(workspace: BiasWorkspace, catalog: BiasEntry[]): string`
    - If `workspaceCase === "retrieved"`: render candidate table + roster (replaces Tier 1 + Tier 2 text)
    - If `workspaceCase === "unavailable"`: render roster-only (same as current Case C output)

### Phase 5: Adaptive Wait + Full Assessment Wiring

**⚠️ Superseded post-implementation**: the adaptive wait described below (steps 2 and part of 6) was implemented as written, then removed — the 70s/2s constants were tuned to one specific deployment's measured latency and judged too fragile to keep. Current behavior is just step 1 + step 3 onward, with `ragResult` used as-read (no poll). See `spec.md` → "Implementation Notes (post-implementation deviation)" for the full rationale. Steps below are kept for historical record.

Depends on Phases 1, 3, 4.

- Update `runFullAssessment` in `assessment.service.ts`:
  1. Read stored RAG result: `ragResult = await runStore.getRagResultForSession(sessionId)` (existing)
  2. **If `ragResult === null`**: read `ragStartedAt = await runStore.getRagStartedAtForSession(sessionId)`
     - If `ragStartedAt === null`: skip adaptive wait entirely — `recordRagStarted` failed silently (best-effort); proceed without RAG
     - If `ragStartedAt !== null`: compute `elapsedMs = Date.now() - ragStartedAt.getTime()`
       - If `elapsedMs >= 70_000`: poll DB for `ragResult` every 200ms up to 2s ceiling; update `ragResult` if found
       - If `elapsedMs < 70_000`: skip — RAG won't finish within the 2s budget
     - **Note on FAILED vs RUNNING**: `storeRagResult(runId, null)` on Inngest job failure writes the same `null` as the in-flight RUNNING state. The adaptive wait may therefore poll for up to 2s on a job that already failed. This is intentional: the assessment proceeds correctly in both cases; the ≤2s waste is acceptable against the alternative of a sentinel write that adds error-path complexity to the Inngest function. The collapsed FAILED/RUNNING distinction is a deliberate spec-005 scope decision (D015 Decision 2 defines the full state machine; the null-as-RUNNING inference here is a valid simplification at this traffic volume).
  3. Build workspace: `buildBiasWorkspace(isEngineResponse(ragResult) ? { status: "ok", data: ragResult } : { status: "unavailable" }, catalog)`
  4. `renderWorkspaceToPrompt(workspace, catalog)` → `candidateBiases` string
  5. Render prompt: `prompts.render("assessment", { candidateBiases })`
  6. After LLM returns: log `rag_available: workspace.workspaceCase === "retrieved"` and `rag_wait_ms: <elapsed wait>` (D015 Decision 5 telemetry)
  7. Derive `context_source` per bias (see Phase 6)

### Phase 6: context_source Enum Update + Prompt

Depends on Phase 5.

- Update `BiasItem` in `src/contracts/reflection.schemas.ts`:
  - `context_source: z.enum(["retrieved", "llm", "both"]).optional()`
  - Remove `"roster"` from enum (backward-compat note in comment: pre-005 DB rows have `"roster"`, treat as `"llm"` on read)
- Update `context_source` derivation in `callProvider()` in `assessment.service.ts`:
  - For each bias in LLM output: if `retrievedIds.has(biasCatalogId)` → `"retrieved"`. Otherwise → `"llm"`.
  - When `workspaceCase === "unavailable"`: all biases get `"llm"` (was `"roster"`)
  - **`"both"` deferred**: D015 Decision 3 defines `"both"` for biases appearing in both RAG results and the story_only LLM candidate list. This requires storing the story_only LLM bias list (a new `initial_bias_result` DB column + RunStore methods) and bridging it to `runFullAssessment`. That persistence work is out of scope for spec-005 to keep the change set bounded. `"both"` is in the enum for type-system correctness; it will not be emitted until the merge is implemented. This is the planned divergence from D015 Decision 6 documented in research.md.
- Rename `{{biasContext}}` → `{{candidateBiases}}` in `src/prompts/reflection/assessment/system.md`
- Bump version to `"1.3.0"` in `src/prompts/reflection/assessment/system.json`
- Update all `prompts.render("assessment", { biasContext: ... })` call sites to `{ candidateBiases: ... }`

### Phase 7: Tests

- Unit: `src/rag/workspace-builder.test.ts` — retrieved case (candidates built correctly), unavailable case (roster-only), empty biases (Case B maps to unavailable)
- Unit: `src/jobs/rag-retrieve.test.ts` — mocked ragClient + runStore; confirm storeRagResult called on success; confirm failure is swallowed
- Integration: `tests/integration/async-rag-assessment.test.ts`:
  - story_only path: Inngest send is called (mock inngestClient); RAG client is NOT called; response returned fast
  - full assessment with READY result: stored ragResult read, workspace built, `rag_available: true` logged
  - full assessment with no result: proceeds with roster-only, `rag_available: false` logged

### Phase 8: Deployment

- Run `pnpm db:migrate` — applies `0005_async_rag_submission.sql` on Supabase
- Set `RAG_TIMEOUT_MS=120000` in Vercel environment (currently 5000 in Vercel, already updated locally and on HF Space)
- Verify `ragRetrieveJob` registered in Inngest dashboard
- Smoke test: submit story → verify questions return in < 5s; wait 90s → submit assessment → verify `rag_available: true` in logs

## Complexity Tracking

No constitution violations.
