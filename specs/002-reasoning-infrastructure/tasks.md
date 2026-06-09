# Tasks: Reasoning Infrastructure for Auditable Assessment

**Input**: Design documents from `/specs/002-reasoning-infrastructure/`

**Prerequisites**: plan.md, spec.md

**Path convention**: `src/...` at repository root (`biassemble-core/`)

**Tests**: Required — unit + integration for all new functionality.

## Format

- **[ID]**: Unique task identifier
- **[P]**: Can run in parallel with other P-marked tasks in the same phase
- Include exact file paths in descriptions

---

## Phase 0: Schema + Entity Definitions

**Purpose**: Define all new Zod schemas and DB entities before implementation begins. No dependencies between these tasks.

- [x] T001 [P] Create `src/contracts/reasoning.schemas.ts` — NEW Zod schemas (all in one pass):
  - `PromptVersionSchema` as `z.string().min(1).brand("PromptVersion")`
  - `StoryAnalysis` (themes: string[], emotional_tone: string, key_events: string[], prompt_version: PromptVersion)
  - `InterpretationSchema` (interpretation: string, plausibility: number 0.0–1.0, supporting_evidence: string[], rejected?: boolean)
  - `BiasHypothesis` (bias_name: string, confidence: number 0.0–1.0, supporting_excerpts: string[], uncertainty_reasons: string[], prompt_version: PromptVersion)
  - `EvidenceMapping` (bias_id: string, evidence: EvidenceEntry[], prompt_version: PromptVersion)
  - `ReasoningTrace` (story_analysis: StoryAnalysis, interpretations: InterpretationSchema[], bias_hypotheses: BiasHypothesis[], evidence_mapping: EvidenceMapping[], prompt_version: PromptVersion)
  - `EvidenceEntry` (source: "story" | "answer", excerpt: string, relevance: string)
  - `ReflectionSessionSchema` (id: uuid, story_id: uuid, created_at: timestamptz)
  - `RunSchema` (id: uuid, session_id: uuid, model_name: string, stage: "initial_assessment" | "post_questions_assessment", scope: "story_only" | "story_plus_answers", prompt_version: PromptVersion, input_hash: string, created_at: timestamptz)
  - `EvalResultSchema` (id: uuid, run_id?: uuid, prompt_version: string, model_name: string, dataset: "golden" | "no_bias" | "all", evaluation_metrics: z.object({ evidence_grounded_rate: number | null, false_positive_rate: number | null }), system_metrics: z.object({ schema_parse_rate: number, repair_rate: number }), input_hash: string, passed: boolean, run_at: timestamptz)
  - `ClaimSchema` stub (claim: string, source: "story" | "answer") — reserved only, NOT in ReasoningTrace
  - `ProviderComparisonSchema` stub (prompt_version: PromptVersion, results: Record<string, unknown>, disagreement_score?: number) — reserved, NOT populated in MVP
  - `ContradictionSchema` stub (statement_a: string, statement_b: string, severity: "low" | "medium" | "high") — reserved, NOT populated in MVP
  - NOTE: `stage` and `scope` are Zod enums. `stage` enum: `["initial_assessment", "post_questions_assessment"]`, `scope` enum: `["story_only", "story_plus_answers"]`
  - NOTE: `prompt_version` is required on every step schema and on `ReasoningTrace` itself. Missing prompt_version MUST throw at runtime.

- [x] T002 [P] Extend `src/contracts/reflection.schemas.ts`:
  - Import `EvidenceEntry` and `ReasoningTrace` from `reasoning.schemas.ts`
  - Add `evidence: EvidenceEntry[]` to `BiasItem`
  - Add `noBiasDetected: boolean` to `AssessmentOutput`
  - Add `reasoningTrace?: ReasoningTrace` optional field to `AssessmentOutput`
  - Add `inputContext: "story-only" | "full"` to `AssessmentOutput`
  - Add `modelName: string` to `AssessmentOutput`
  - Add `mode: "story_only" | "full"` to `GenerateAssessmentRequestSchema`

- [x] T003 [SKIPPED] No new schema needed:
  - `GenerateAssessmentRequestSchema` already has all fields (`sessionId`, `story`, `questions`, `answers`, `mode`)
  - `CreateSessionRequestSchema` is dead code — sessions are created server-side, not via a separate endpoint
  - No new file or schema required

**Checkpoint**: All Zod schemas defined and unit-testable. Entity relationships clear.

---

## Phase 1: Metrics + Persistence Infrastructure

**Purpose**: Build the evaluation metrics, system metrics, and persistence write path.

- [x] T101 [P] Create `src/evaluation/compute-evaluation-metrics.ts`:
  - `computeEvaluationMetrics(assessment, input)` — standalone pure function
  - Validates evidence excerpts against input text (verbatim substring matching)
  - Returns `{ evidence_grounded_rate: number | null, false_positive_rate: number | null }`
  - `evidence_grounded_rate` = proportion of bias items with all evidence excerpts found verbatim in input; `null` when bias list is empty
  - `false_positive_rate` = proportion of assessments returning biases for no_bias stories; `null` when no no_bias assessments in dataset
  - No side effects, no imports from production path

- [x] T102 [P] Create `src/evaluation/compute-system-metrics.ts`:
  - `computeSystemMetrics(responses)` — standalone pure function
  - Input: `Array<{ requiredRepair: boolean }>` — one entry per LLM response
  - Returns `{ schema_parse_rate: number | null, repair_rate: number | null }`
  - `schema_parse_rate` = proportion of responses that parsed without invoking repair pipeline; `null` when responses array is empty
  - `repair_rate` = proportion of responses that required repair (= 1 - schema_parse_rate); `null` when responses array is empty
  - No side effects

- [SKIPPED] T103 [P] Create `src/persistence/session-store.ts`:
  > **Actual**: Superseded. File-based session-store was rejected. Instead defined typed ports in [`src/persistence/types.ts`](/src/persistence/types.ts) + [`src/persistence/ports.ts`](/src/persistence/ports.ts) (camelCase store boundary). Backend Drizzle implementation in [`biassemble/backend/src/drizzle/schema.ts`](/../backend/src/drizzle/schema.ts) (tables: `runs`, `reasoning_traces`, `eval_results`) + queries in [`biassemble/backend/src/lib/db/queries.ts`](/../backend/src/lib/db/queries.ts) (createRun, getRunsBySession, persistTrace, getTrace, persistEvalResult, getEvalResultByHash, getLatestEvalResults). Drizzle-first from day one — no file fallback, no feature flag. See also spec.md "Actual Implementation" section and plan.md "Actual Implementation" section.
  - Export `createSession(storyId: string): Promise<Session>`
  - Export `createRun(sessionId: string, runData: Omit<Run, 'id' | 'createdAt'>): Promise<Run>`
  - Export `getSession(id: string): Promise<Session | null>`
  - Export `getRunsBySession(sessionId: string): Promise<Run[]>`
  - Default implementation: JSON files in `./data/sessions/` and `./data/runs/`
  - Feature-flagged: when `PERSIST_REASONING_TRACE=supabase`, use Supabase tables

- [SKIPPED] T104 [P] Create `src/persistence/trace-store.ts`:
  > **Actual**: Superseded. Same pattern as T103 — types/ports in [`src/persistence/types.ts`](/src/persistence/types.ts) + [`src/persistence/ports.ts`](/src/persistence/ports.ts), Drizzle tables in [`biassemble/backend/src/drizzle/schema.ts`](/../backend/src/drizzle/schema.ts). No file-based persistence, no `trace_type` column (removed from schema). Reasoning traces stored as `jsonb` on `reasoning_traces` table. Write/read via `persistTrace` / `getTrace` in [`biassemble/backend/src/lib/db/queries.ts`](/../backend/src/lib/db/queries.ts).
  - Export `persistReasoningTrace(runId: string, trace: ReasoningTrace): Promise<void>`
  - Export `getReasoningTrace(runId: string): Promise<ReasoningTrace | null>`
  - File path: `./data/reasoning-traces/{session_id}/{stage}/{run_id}.json`
  - Feature-flagged Supabase upgrade (T404)
  - Wire call added in T203 (assessment service)

- [SKIPPED] T105 [P] Create `src/persistence/eval-results-store.ts`:
  > **Actual**: Superseded. Same pattern as T103/T104. `eval_results` table defined in [`biassemble/backend/src/drizzle/schema.ts`](/../backend/src/drizzle/schema.ts) with `provider` column (not in original plan) and Drizzle enum constraint on `dataset`. Query functions in [`biassemble/backend/src/lib/db/queries.ts`](/../backend/src/lib/db/queries.ts) (persistEvalResult, getEvalResultByHash, getLatestEvalResults). File-based persistence not implemented.
  - Export `persistEvalResult(result: EvalResult): Promise<void>`
  - Export `getEvalResultByHash(inputHash: string, promptVersion: string): Promise<EvalResult | null>`
  - Export `getLatestEvalResults(promptVersion: string, limit: number): Promise<EvalResult[]>`
  - File path: `./data/eval-results/{input_hash}_{prompt_version}.json`
  - Required persistence (not optional)
  - Feature-flagged Supabase upgrade (T404)

**Checkpoint**: All persistence write paths exist. Metrics functions return correct values for known test cases. Traces generated from Phase 2 forward are stored.

---

## Phase 1b: DB Schema + Queries + Eval Job (extra, not in original plan)

**Purpose**: Core-owned DB schema (`core` schema), query functions, and Inngest eval job. Schema defined but not wired into production path yet — ready for T404.

- [x] T1b1 Create `src/db/schema.ts`:
  - Drizzle schema for `runs`, `reasoning_traces`, `eval_results` in `core` schema via `pgSchema("core")`
  - `runs`: id (uuid PK), session_id (uuid, not null), provider (text), model_name (text), stage (enum: initial_assessment | post_questions_assessment), scope (enum: story_only | story_plus_answers), prompt_version (text), input_hash (text), created_at (timestamp)
  - `reasoning_traces`: id (uuid PK), run_id (uuid, not null), trace (jsonb), created_at (timestamp)
  - `eval_results`: id (uuid PK), run_id (uuid, optional), provider (text), model_name (text), prompt_version (text), dataset (enum: golden | no_bias | all), evaluation_metrics (jsonb), system_metrics (jsonb), input_hash (text), passed (boolean), run_at (timestamp)

- [x] T1b2 Create `src/db/config.ts`:
  - Drizzle connection config using `DATABASE_URL` env var
  - Export `db` instance for use in queries

- [x] T1b3 Create `src/db/queries.ts`:
  - `createRun(data)` — insert run, return created run
  - `getRunsBySession(sessionId)` — list runs for a session
  - `persistTrace(runId, trace)` — insert reasoning trace
  - `getTrace(runId)` — get trace by run ID
  - `persistEvalResult(data)` — insert eval result
  - `getEvalResultByHash(inputHash, promptVersion)` — check determinism
  - `getLatestEvalResults(promptVersion, limit)` — latest N results

- [x] T1b4 Create `drizzle.config.ts`:
  - Drizzle Kit config: schema `./src/db/schema.ts`, out `./src/db/migrations`, dialect postgresql, schemaFilter `["core"]`

- [x] T1b5 Create `src/jobs/client.ts`:
  - Inngest client init with `INNGEST_APP_NAME` and `INNGEST_EVENT_KEY` env vars

- [x] T1b6 Create `src/jobs/eval-job.ts`:
  - Inngest eval function: runs golden + no_bias datasets, computes metrics, persists to eval_results
  - Accepts `triggerType: "gate" | "monitor"`

**Checkpoint**: DB schema defined, queries work, eval job exists. Not wired into production path yet.

---

## Phase 1c: Pre-Phase 2 Preparation

**Purpose**: Resolve schema and interface discrepancies discovered during Phase 2 readiness review. Must be complete before Phase 2 implementation begins.

- [x] T200 [P] Resolve `noBiasDetected` schema conflict in `src/contracts/reflection.schemas.ts`:
  - Remove `.min(1)` from `biases: z.array(BiasItemSchema).min(1)` → `biases: z.array(BiasItemSchema)`
  - Allow empty `biases` array when `noBiasDetected: true` (Pattern A: simple)
  - Keep `noBiasDetected: z.boolean()` as-is — consumers check this flag to determine if biases array may be empty
  - Rationale: KISS-compliant, backward-compatible, avoids discriminated union complexity

- [x] T200a [P] Add `modelName` to service constructors:
  - `src/orchestrators/reflection/assessment.service.ts` — add `modelName: string` constructor param, stamp on output
  - `src/orchestrators/reflection/question.service.ts` — add `modelName: string` constructor param, stamp on output
  - Provider interface (`src/providers/types.ts`) remains unchanged
  - Caller (server.ts or wherever services are instantiated) passes `env.GEMINI_MODEL` as `modelName`

- [x] T200b [P] Update unit tests for schema change:
  - `tests/unit/contracts/reflection.schemas.test.ts` — update "should reject empty biases array" test to instead verify `biases: []` with `noBiasDetected: true` passes validation
  - Add test: `biases: []` with `noBiasDetected: false` still validates (no constraint on that combo at schema level)

- [x] T200c [P] Correct Phase 2 task descriptions:
  - T202: Remove "Document that stage and scope are output fields" — these are orchestrator stamps, not LLM output fields
  - T203: Replace "Call persistReasoningTrace() from T104" with "Call `persistTrace()` from `src/db/queries.ts`"; add `requestId` to method signatures
  - T207: Fix prompt path from `questions/system.md` to `question-batch/system.md`; add `requestId` to `generate()` signature

**Checkpoint**: Schema allows empty biases with `noBiasDetected`. `modelName` available on services. All existing tests pass. Task descriptions corrected.

---

## Phase 2: Reasoning Pipeline — Orchestrator Upgrade

**Purpose**: Upgrade the assessment orchestrator to two-phase flow with intermediate reasoning + evidence binding.

- [x] T201 [P] Update `src/prompts/reflection/assessment/system.md`:
  - Update assessment prompt to emit structured reasoning steps:
    - story analysis → interpretations → bias hypotheses → evidence mapping → final assessment
  - Include instructions for evidence binding (each bias claim must reference specific story/answer excerpts)
  - Include instructions for `no_bias_detected` signal when no biases found
  - Ensure prompt instructs LLM to produce reasoning trace + assessment in a single JSON response

- [x] T202 [P] Update `src/prompts/reflection/assessment/schema.md`:
  - Update output schema to include reasoning trace + evidence per bias
  - Document the `no_bias_detected` signal format
  - NOTE: `stage` and `scope` are NOT LLM output fields — they are stamped by the orchestrator on runs

- [x] T203 Upgrade `src/orchestrators/reflection/assessment.service.ts`:
  - Refactor into two entry points:
    - `runStoryOnlyAssessment(session, story)` → creates run with stage=initial_assessment, scope=story_only
    - `runFullAssessment(session, story, questions, answers)` → creates run with stage=post_questions_assessment, scope=story_plus_answers
  - Both:
    - Call provider once with output schema that includes reasoning trace
    - Parse trace + evidence from response
    - Validate each step with Zod schemas from `reasoning.schemas.ts`
    - Validate `prompt_version` is present on every step — throw if missing
    - Stamp `modelName` from service constructor param
    - Stamp `stage`, `scope`, `prompt_version` on run and trace
    - Call `persistTrace()` from `src/db/queries.ts` after trace is generated
    - Return structured result with trace + assessment

- [x] T204 Ensure `reasoning_trace` is always computed and persisted:
  - `persistTrace()` called unconditionally — if LLM returns no trace, a stub is persisted
  - Both story-only and full runs always produce and persist a trace record

- [x] T205 Handle `no_bias_detected` signal in assessment service:
  - Enforced: when `parsed.biases.length === 0 && !parsed.noBiasDetected`, service sets `noBiasDetected: true`
  - `computeEvaluationMetrics` returns `null` for empty bias lists (eval-only, not called here)

- [x] T206 Wire evidence validation into assessment service:
  - Imported `validateEvidence` from `src/parsers/evidence-validator.ts` (T301)
  - Called `validateEvidence()` in `callProvider()` after bias name normalization
  - Logs warnings for violations (bias items with missing/hallucinated evidence)
  - Accepts story/answers via new params on `callProvider()`
  - Full implementation complete (T301 dependency resolved)

- [x] T207 Update `src/orchestrators/reflection/question.service.ts`:
  - Signature: `generate(story, requestId, storyAnalysis?, interpretations?)` — optional params, backward-compatible
  - When reasoning context provided, prepends themes/emotional_tone/key_events + top 2 interpretations to user message
  - Prompt template unchanged — context delivered via user message, no coupling to template variables
  - Route continues working unchanged (params optional)

**Checkpoint**: Two-phase assessment works end-to-end. Questions are reasoning-context-aware. Both traces persisted. Evidence validation wired (or stubbed with documented TODO).

---

## Phase 3: Evidence Validation + `no_bias` Dataset + CI

**Purpose**: Build the adversarial testing infrastructure, evidence validation, and CI gating.

- [x] T301 [P] Create `src/parsers/evidence-validator.ts`:
  - `validateEvidence(assessment, input)` — checks every excerpt exists verbatim in story or answers
  - Returns `{ valid: boolean, violations: Violation[] }`
  - `Violation` type: `{ biasName: string, excerpt: string, reason: string }`
  - Wired into assessment service (T206) — import + call in `callProvider()`

- [x] T302 [P] Create `evaluations/no_bias/`:
  - 13 neutral stories — situations without cognitive bias triggers (grocery run, commute, laundry, doctor visit, library, car maintenance, coffee shop, home repair, mall parking, weather check, email sorting, plant watering, bus ride)
  - JSON format: `{ id, title, story, isNoBias: true, confidenceThreshold: 0.5, notes, tags }`
  - `confidenceThreshold` is 0.5 for all stories except doctor-appointment (0.4 — stricter gate for medical framing).
  - `isFalsePositive` in computeEvaluationMetrics uses confidence > threshold (not just `biases.length > 0`), allowing LLM hedging below threshold as acceptable behavior.

- [x] T303 Extend `scripts/eval-reflection.ts`:
  - Runs golden + no_bias datasets through real services
  - MockProvider (`pnpm eval`) for fast CI sanity check; `--provider real` for Gemini quality gate
  - Computes evaluation_metrics (evidence_grounded_rate, false_positive_rate) and system_metrics (schema_parse_rate, repair_rate)
  - CLI flags: `--min-evidence-grounded` (0.9), `--max-false-positive` (0.1), `--min-schema-parse` (0.95), `--max-repair-rate` (0.05)
  - No_bias stories skip question generation (assessment only); determinism hashes logged but DB check deferred to T305
  - Per-story failure breakdown in output

- [x] T304 Add determinism check to eval script:
  - Computes `input_hash` for each story via `computeInputHash`
  - Hashes logged to console — DB-based determinism check (same hash = same metrics) deferred to Inngest eval job (T305)
  - No `--force` flag needed (no DB access from CLI script)

- [x] T305 Create `src/jobs/eval-assessment.ts`:
  - Inngest eval function (`event: "eval/assessment"`) — always uses real GeminiProvider
  - Runs golden + no_bias datasets via shared `runEval()` from `src/evaluation/run-eval.ts`
  - Determinism check: `getEvalResultByHash()` — same hash with different outcome fails gate mode
  - Persists results to `eval_results` via `persistEvalResult()`
  - Gate mode: returns `{ passed: false, reason: "non_determinism" }` on mismatch; fails CI
  - Monitor mode: logs errors, does not block
  - Shared runner extracted: CLI (`scripts/eval-reflection.ts`) and Inngest job share same eval logic
  - CLI refactored to use `runEval()` — zero DB imports in CLI script

- [x] T306 Create `.github/workflows/prompt-eval.yml`:
  - GitHub Action workflow triggered on PRs modifying `src/prompts/**`
  - Runs `pnpm eval` (mock) + `pnpm test` — fast pipeline integrity check
  - No API keys required, no real Gemini calls

- [x] T307 Manual real eval via CLI:
  - `pnpm eval --provider real` — runs real Gemini against golden + no_bias datasets
  - Run manually before deploy or prompt changes
  - No cron schedule — triggered by developer when needed

**Checkpoint**: `no_bias` dataset exists. Eval script runs all metric dimensions. CI gate blocks bad prompt changes. Daily monitoring alerts on degradation.

---

## Phase 4: API + Persistence Upgrade

**Purpose**: Wire unified assessment endpoint and upgrade persistence to Supabase.

- [x] T401 Refactor `src/routes/reflection.ts`:
  - `POST /v1/reflection/assessment` accepts `mode: "story_only" | "full"` in body (default "full")
  - When mode=story_only:
    - Call `runStoryOnlyAssessment()` (creates run with stage=initial_assessment, scope=story_only)
  - When mode=full:
    - Validate questions/answers match
    - Call `runFullAssessment()` (creates run with stage=post_questions_assessment, scope=story_plus_answers)
  - Add `includeReasoningTrace=true` query param — controls response body only (trace always persisted)
  - Made `mode` optional with `.default("full")` in schema so existing backend callers (which don't send mode) continue working

- [x] T402 [SUPERSEDED] Incorporated into T401:
  - `noBiasDetected` and `reasoningTrace` were already in `AssessmentOutputSchema` from Phase 2
  - `modelName` already in `AssessmentOutputSchema` from Phase 2
  - `stage` and `scope` are persistence-only metadata on `runs` table — not exposed in API response
  - `includeReasoningTrace` query param handled in T401

- [x] T403 [DONE] No separate work needed:
  - `AssessmentOutputSchema` already contains all required response fields: `biases`, `reflectionPrompt`, `reasoningTrace?`, `noBiasDetected`, `inputContext`, `modelName`
  - No stage/scope in public API — those are DB concerns, not API contract
  - Completed during Phase 2 orchestrator refactor

- [x] T404 [SUPERSEDED] Implemented via Phase 1b Drizzle infrastructure:
  - Drizzle schema (`src/db/schema.ts`): `runs`, `reasoning_traces`, `eval_results` in `core` schema
  - Queries (`src/db/queries.ts`): all CRUD functions exist
  - Config (`src/db/config.ts`): connection via `DATABASE_URL`, migration via `drizzle-kit generate`
  - No handwritten SQL migration, no file-based persistence, no feature flag
  - See spec.md "Actual Implementation" section for deviations

**Checkpoint**: Unified API endpoint dispatches by mode. Persistence via Drizzle (Phase 1b). Tests passing at 125/125.

---

## Phase 5: Tests

**Purpose**: Unit + integration tests for all new functionality.

- [ ] T501 [P] Create `tests/unit/contracts/reasoning.schemas.test.ts`:
  - Zod validation for all schemas: sessions, runs, traces, eval_results, evidence entries
  - Verify stage/scope enum values
  - Verify model_name, prompt_version branded type enforcement
  - Valid data passes, invalid data fails
  - Verify that multiple bias items MAY reference the same excerpt, but each must include a distinct relevance explanation

- [ ] T502 [P] Create `tests/unit/parsers/evidence-validator.test.ts`:
  - Verbatim match success cases
  - Hallucination rejection (excerpt not in input)
  - Empty edge cases (no biases, empty excerpts)

- [x] T503 [P] Create `tests/unit/evaluation/compute-evaluation-metrics.test.ts`:
  - `computeEvaluationMetrics` known cases: all grounded, partially grounded, none grounded
  - Empty bias list → evidence_grounded_rate is null
  - No no_bias assessments → false_positive_rate is null

- [x] T504 [P] Create `tests/unit/evaluation/compute-system-metrics.test.ts`:
  - `computeSystemMetrics` known cases: all parsed, some repaired, all repaired
  - Edge case: empty responses array
  - Edge case: single response

^- [x] T505 Extend `tests/integration/assessment.test.ts`:
  - Verify reasoning trace shape in response
  - Verify evidence binding on bias items
  - Verify `no_bias_detected` signal
  - Verify `stage` and `scope` on output
  - Verify `modelName` present on output

^- [x] T506 [P] Create `tests/integration/evidence-pipeline.test.ts`:
  - Full pipeline with mocked provider
  - Trace generation with evidence binding
  - Evidence validation with hallucination rejection
  - Verify dropped bias items when evidence invalid

- [ ] T507 [P] Create `tests/unit/evaluations/no-bias.test.ts`:
  - Verify no_bias dataset loads and has correct format
  - Each file has expected structure matching golden set

- [ ] T508 [P] Create `tests/integration/two-phase-session.test.ts`:
  - Full two-phase session flow:
    1. Create session
    2. Run story-only assessment → Trace 1
    3. Verify Trace 1 has stage=initial_assessment, scope=story_only
    4. Run question service with Trace 1 context
    5. Verify questions received story_analysis + interpretations (not just raw story)
    6. Run full assessment with answers → Trace 2
    7. Verify Trace 2 has stage=post_questions_assessment, scope=story_plus_answers
    8. Verify both traces persisted and retrievable

- [ ] T509 Add test case to `tests/integration/assessment.test.ts`:
  - Verify pipeline throws (not warns, not defaults) when `prompt_version` is missing from any reasoning trace step
  - Mock provider returns valid assessment JSON but omits `prompt_version` from `StoryAnalysis`
  - Assert that the orchestrator throws with a descriptive error message (FR-014 enforcement)

- [ ] T510 [P] Create `tests/integration/inngest-eval.test.ts`:
  - Verify Inngest eval function runs both datasets (golden + no_bias)
  - Computes all 4 metrics correctly
  - Persists results to eval_results
  - Gate mode: returns pass/fail correctly
  - Determinism check: same hash skips, different hash runs
  - Determinism failure: same hash, different metrics → fails

- [ ] T511 [P] Update READMEs with stage 002 completion status:
  - `biassemble-core/README.md`: Add section listing stage 002 deliverables — reasoning traces, evidence binding, two-phase assessment, split metrics (evaluation_metrics + system_metrics), Inngest CI eval, no_bias dataset. Link to `specs/002-reasoning-infrastructure/`.
  - `biassemble/README.md`: Add one-liner noting reasoning infrastructure is complete (auditable traces, evidence-based assessment). Link to core README.

**Checkpoint**: All tests green. READMEs updated with stage 002 status.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 0** (Schema definitions): No dependencies — pure Zod, can start immediately
- **Phase 1** (Metrics + persistence): Depends on Phase 0 (schemas must exist)
- **Phase 2** (Orchestrator upgrade): Depends on Phase 0 + Phase 1
- **Phase 3** (Evidence validation + no_bias + CI): Depends on Phase 2
- **Phase 4** (API + persistence upgrade): Depends on Phase 2
- **Phase 5** (Tests): Depends on Phase 0–4

### Parallel Opportunities

- T001, T002, T003 (Phase 0) — can run in parallel
- T101–T105 (Phase 1) — can run in parallel once Phase 0 schemas exist
- T201, T202 (Phase 2) — can run in parallel with T203–T207
- T301, T302 (Phase 3) — can start alongside Phase 2
- T305, T306, T307 (Phase 3) — can run after T303
- T403 (Phase 4) — can run in parallel with T401, T402
- T501–T510 (Phase 5) — can be written in parallel with implementation

### Execution Strategy

1. **Phase 0 first**: All schemas defined, testable before any implementation
2. **Phase 1 parallel**: Metrics + persistence ready before orchestrator needs them
3. **Phase 2 + T301/T302 parallel**: Orchestrator upgrade while evidence validator and no_bias dataset built
4. **Phase 3**: Wire eval script + Inngest job + CI gate
5. **Phase 4**: API changes and persistence upgrade to Supabase
6. **Phase 5**: Tests last, but individual test files can be written alongside their corresponding implementation

---

## Task Summary

| Phase | Tasks | Checkpoint |
|---|---|---|
| 0 | T001, T002, T003 | All Zod schemas defined |
| 1 | T101, T102, T103, T104, T105 | Metrics + persistence write paths exist |
| 1b | T1b1, T1b2, T1b3, T1b4, T1b5, T1b6 | Core DB schema + queries + eval job defined |
| 2 | T201, T202, T203, T204, T205, T206, T207 | Two-phase assessment with reasoning trace |
| 3 | T301, T302, T303, T304, T305, T306, T307 | no_bias + eval script + CI gate + daily monitor |
| 4 | T401, T402, T403, T404 | Unified API + Supabase persistence |
| 5 | T501, T502, T503, T504, T505, T506, T507, T508, T509, T510, T511 | All tests green. READMEs updated. |

**Total: 40 tasks across 7 phases (0–5 + 1b)**
