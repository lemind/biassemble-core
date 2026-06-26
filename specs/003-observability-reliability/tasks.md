# Tasks 003 — Observability, Reliability & Evaluation Infrastructure

**Input**: Design documents from `/specs/003-observability-reliability/`

**Prerequisites**: plan.md, spec.md

**Path convention**: `src/...` at repository root (`biassemble-core/`)

**Tests**: Required — unit + integration for all new functionality. Tests are written before implementation within each phase (TDD).

## Format

- **[ID]**: Unique task identifier
- **[P]**: Can run in parallel with other P-marked tasks in the same phase
- Include exact file paths in descriptions

---

## Phase 1: Database Schema, Types & Ports

**Purpose**: Define all new DB tables, TypeScript types, persistence port interfaces, and migration. This is the foundation all subsequent phases depend on.

### Tests for Phase 1

- [x] T101 [P] Write type-level tests for new persistence types — verify `LlmCallRecord` shape correctness, enum constraints, nullable fields; verify extended `EvalResultRecord` has new fields
  - File: `biassemble-core/tests/unit/persistence/observability-types.test.ts`

- [x] T102 [P] Write port contract tests — verify `LlmCallStore` interface matches the types, all required methods exist with correct signatures; verify extended `EvalResultStore` has new query methods
  - File: `biassemble-core/tests/unit/persistence/observability-ports.test.ts`

### Implementation for Phase 1

- [x] T103 [P] Add `llm_calls` table definition to `src/db/schema.ts`
  - Columns: id (uuid PK), session_id (uuid, nullable), stage (enum: `assessment`, `question`), call_type (enum: `primary`, `fallback`), provider, model, prompt_version, raw_response (text, nullable), parsed_output (jsonb, nullable), status (enum: `success`, `timeout`, `error`), failure_type (enum: `schema_validation`, `parse_error`, `provider_error`, `timeout`, `other`, nullable), input_tokens (integer, nullable), output_tokens (integer, nullable), total_tokens (integer, nullable), started_at, ended_at, duration_ms (integer), error_message (text, nullable), created_at
  - Indexes: provider, model, stage, created_at, session_id
  - One row per actual provider call (including retries and fallback calls) — no retry_count column
  - File: `biassemble-core/src/db/schema.ts`

- [x] T104 [P] Extend `eval_results` table in `src/db/schema.ts`
  - Add columns: `eval_run_id` (uuid, not null), `scenario_id` (text, not null), `raw_output` (text, nullable)
  - `eval_run_id` groups all scenarios from the same `runDataset()` execution
  - `scenario_id` identifies the story/scenario within the dataset
  - `raw_output` stores the raw LLM text for debugging
  - File: `biassemble-core/src/db/schema.ts`

- [x] T105 Add TypeScript types to `src/persistence/types.ts`
  - Add `LlmCallRecord` type: stage is `assessment` | `question`, has `callType` field (`primary` | `fallback`), has `failureType` field, has `promptVersion` field, has `inputTokens`/`outputTokens`/`totalTokens` fields (nullable), status is `success` | `timeout` | `error` (no `retry`), no `retryCount` field
  - Extend `EvalResultRecord` with: `evalRunId: string`, `scenarioId: string`, `rawOutput: string | null`
  - File: `biassemble-core/src/persistence/types.ts`

- [x] T106 Add persistence port interfaces to `src/persistence/ports.ts`
  - Add `LlmCallStore`: `recordCall()`, `getCallsBySession()`, `getCallsByStage()`, `getCallsByProvider()`, `getCallsBySessionAndStage()`
  - Extend `EvalResultStore` with: `getResultsByEvalRunId(evalRunId)`, `getEvalRunAggregates()` (for GROUP BY queries)
  - File: `biassemble-core/src/persistence/ports.ts`

- [x] T107 Implement query functions in `src/db/queries.ts`
  - `recordLlmCall(data)`: insert into llm_calls
  - `getCallsBySession(sessionId)`: retrieve all calls for a session (for debugging)
  - `getCallsByStage(stage)`: retrieve calls filtered by stage
  - `getCallsByProvider(provider)`: retrieve calls filtered by provider
  - `getCallsBySessionAndStage(sessionId, stage)`: retrieve calls for a session filtered by stage
  - Extend `persistEvalResult()` to accept `evalRunId`, `scenarioId`, `rawOutput`
  - Add `getEvalResultsByRunId(evalRunId)`: retrieve all results for an eval run
  - File: `biassemble-core/src/db/queries.ts`

- [x] T108 Create Drizzle migration for schema changes
  - File: `biassemble-core/src/db/migrations/0003_observability_reliability.sql`
  - Also update `meta/_journal.json`

**Checkpoint**: Run `pnpm db:migrate` locally, verify tables exist with correct columns. Run `pnpm test` — type and port tests pass, no regressions.

---

## Phase 2: LLM Call Recording

**Purpose**: Build `recordLlmCall()` — a helper function that `repairWithFallback()` calls to persist raw LLM responses and call metadata. Only `repairWithFallback()` records calls (not services), since it's the real LLM boundary and sees both primary and fallback calls.

### Tests for Phase 2

- [x] T201 Write unit tests for `recordLlmCall()` — test successful recording with all fields, duration calculation from timestamps, error handling when DB insert fails (fire-and-forget), failure_type categorization, nullable raw_response handling, prompt_version storage, token usage fields (input_tokens, output_tokens, total_tokens), call_type field (primary/fallback)
  - File: `biassemble-core/tests/unit/observability/llm-call-recorder.test.ts`

- [x] T202 Write integration test for LLM call recording in assessment flow — verify full assessment flow creates `llm_calls` record with raw response, prompt_version, correct stage, provider, model
  - File: `biassemble-core/tests/integration/llm-call-recording-assessment.test.ts`

- [x] T203 Write integration test for LLM call recording in question flow — same pattern as T202 but for question service
  - File: `biassemble-core/tests/integration/llm-call-recording-question.test.ts`

### Implementation for Phase 2

- [x] T204 Create `src/observability/llm-call-recorder.ts`
  - Export `recordLlmCall()` function and `LlmCallInput` interface
  - File: `biassemble-core/src/observability/llm-call-recorder.ts`

- [x] T205 Implement `recordLlmCall()` function
  - Accept: provider, model, stage, callType (primary/fallback), promptVersion, rawResponse, parsedOutput, status, failureType, inputTokens, outputTokens, startTime, endTime, errorMessage
  - Compute duration_ms from timestamps
  - Compute total_tokens = input_tokens + output_tokens (if both present)
  - Insert into `llm_calls` table via `LlmCallStore.recordCall()`
  - Wrap in try/catch — log errors but never throw (fire-and-forget)
  - File: `biassemble-core/src/observability/llm-call-recorder.ts`

- [x] T205a Integrate `recordLlmCall()` into service layer
  - **Note**: Integrated into `assessment.service.ts` and `question.service.ts` instead of `repairWithFallback()` to maintain separation of concerns (parser layer stays pure)
  - Record primary call before attempting repair (call_type=primary)
  - If repair fails and fallback provider is called, record fallback call (call_type=fallback)
  - Both calls have the same stage (assessment or question) but different call_type values
  - Services call `executeAndRecordLlmCall()` directly, not through `repairWithFallback()`
  - Files: `biassemble-core/src/orchestrators/reflection/assessment.service.ts`, `biassemble-core/src/orchestrators/reflection/question.service.ts`

- [x] T304 Fix layer violation — move DB updates outside fallback callback
  - **Problem**: Services call `updateLlmCallParsedOutput()` directly inside fallback callback, mixing observability concerns with parser logic
  - **Solution**: Fallback callback returns `{ result, llmCallId }`, outer service scope handles all DB updates
  - Validate fallback output through schema before returning
  - Update both primary and fallback call records after `repairWithFallback()` succeeds
  - Files: `biassemble-core/src/parsers/repair.ts`, `biassemble-core/src/orchestrators/reflection/assessment.service.ts`, `biassemble-core/src/orchestrators/reflection/question.service.ts`

**Checkpoint**: Run assessment flow manually, verify `llm_calls` rows are created in DB with raw response, prompt_version, and correct failure_type. Verify both primary and fallback calls are recorded when fallback is triggered. Run `pnpm test` — all unit and integration tests pass.

### Port Wiring Fix

- [x] T300 Wire `llm-call-recorder.ts` via `LlmCallStore` port instead of calling `queries.ts` directly — accept `LlmCallStore` as a constructor dependency, mock the port in tests

---

## Phase 3: Reliability Metrics Aggregation

**Purpose**: Build the metrics computation layer that aggregates `llm_calls` data into reliability metrics (p50/p95/p99 latency, success/timeout/retry/failure rates).

### Tests for Phase 3

- [x] T301 Write unit tests for `computeReliabilityMetrics()` — test with fixture data: empty dataset, single call, mixed statuses, filtering by provider/model/stage/time range, percentile accuracy (p50/p95/p99), schema validation failure rate calculation
  - File: `biassemble-core/tests/unit/observability/reliability-metrics.test.ts`

### Implementation for Phase 3

- [x] T302 Create `src/observability/reliability-metrics.ts`
  - Export `computeReliabilityMetrics()` function and `ReliabilityMetricsFilter` / `ReliabilityMetrics` interfaces
  - File: `biassemble-core/src/observability/reliability-metrics.ts`

- [x] T303 Implement `computeReliabilityMetrics()` function
  - Accept filter: timeRange, provider, model, stage
  - Query `llm_calls` table with filters
  - Compute: avg latency, p50/p95/p99 latency, success rate, timeout rate, fallback rate, schema_validation failure rate, total call count
  - Return structured `ReliabilityMetrics` object
  - File: `biassemble-core/src/observability/reliability-metrics.ts`

**Checkpoint**: Run `pnpm test` — metrics tests pass with fixture data. Manually verify metrics computation against known `llm_calls` data.

---

## Phase 4: Simple Eval Runner & Integration

**Purpose**: Build a simple `runDataset()` function that runs stories through the pipeline and stores results in the extended `eval_results` table. No pass/fail changes, no baselines, no diff engine. Just: run stories → store outputs with raw text.

**Sequencing note**: Phase 4 can start after Phase 1 (schema exists), but T409 (run golden dataset) requires T205a (integrate `recordLlmCall()` into `repairWithFallback()`) to be complete first. Otherwise eval runs won't produce `llm_calls` rows.

### Tests for Phase 4

- [x] T401 Write unit tests for `runDataset()` — test with mock pipeline: successful run creates `eval_results` rows with shared `eval_run_id`, `scenario_id`, `raw_output`, provider/model correct
  - File: `biassemble-core/tests/unit/evaluation/eval-runner.test.ts`

- [x] T402 Write integration test for eval run flow — run eval on small dataset, verify `eval_results` rows created with `eval_run_id`, `scenario_id`, `raw_output` populated, provider/model correct
  - File: `biassemble-core/tests/integration/eval-run.test.ts`

- [x] T403 Write backwards compatibility tests — verify existing sessions without `llm_calls` records still work, existing eval scripts still work, no regressions in existing test suite
  - File: `biassemble-core/tests/integration/backwards-compatibility.test.ts`

### Implementation for Phase 4

- [x] T404 Create `src/evaluation/eval-runner.ts`
  - Export `runDataset()` function and `DatasetRunConfig` interface
  - File: `biassemble-core/src/evaluation/eval-runner.ts`

- [x] T405 Implement `runDataset()` function
  - Accept: dataset name, stories array, provider, model
  - Generate `eval_run_id` (randomUUID()) for this execution
  - For each story: run through pipeline, store result in `eval_results` with shared `eval_run_id`, `scenario_id`, `raw_output` (raw LLM text)
  - No separate run record to manage — all metadata is on `eval_results` rows
  - No pass/fail changes — just store what the pipeline produced
  - File: `biassemble-core/src/evaluation/eval-runner.ts`

- [x] T406 Create `src/jobs/eval-run.ts` job definition
  - Define Inngest job for async eval runs
  - File: `biassemble-core/src/jobs/eval-run.ts`

- [x] T407 Register eval run job in `src/jobs/inngest-functions.ts`
  - Add import and export for eval run job
  - File: `biassemble-core/src/jobs/inngest-functions.ts`

- [x] T408 Add CLI script to trigger eval run
  - Accept dataset name and provider/model as arguments
  - File: `biassemble-core/scripts/trigger-eval-run.ts`

- [ ] T409 Run existing golden dataset through new eval infrastructure
  - Use existing golden dataset files in `evaluations/golden/reflection/`
  - Verify `eval_results` rows created with `eval_run_id`, `scenario_id`, `raw_output`
  - Verify raw outputs stored in `raw_output` column

- [ ] T410 Verify backwards compatibility
  - Run full existing test suite — no regressions
  - Verify existing sessions work without `llm_calls` records
  - Verify existing eval scripts still function

**Checkpoint**: Full test suite passes. Golden eval runs successfully. `eval_results` populated with `eval_run_id`, `scenario_id`, and `raw_output`.

---

## Phase 5: Deployment

**Purpose**: Deploy database schema changes to production.

### Implementation for Phase 5

- [ ] T501 Deploy database migration to production
  - Run `pnpm db:migrate` to apply schema changes (new `llm_calls` table, extended `eval_results` columns)
  - Verify migration completes successfully
  - Verify new tables/columns exist in production database
  - File: `biassemble-core/src/db/migrations/0003_observability_reliability.sql`

**Checkpoint**: Production database has `llm_calls` table and extended `eval_results` columns. Application continues to function normally.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (Schema): No dependencies — start immediately
- **Phase 2** (LLM Recording): Depends on Phase 1 (schema must exist)
- **Phase 3** (Metrics): Depends on Phase 1 (schema must exist). Can proceed in parallel with Phase 2.
- **Phase 4** (Eval Runner): Depends on Phase 1 (schema must exist). Can proceed in parallel with Phases 2 and 3, **but T409 (run golden dataset) requires T205a to be complete first**.
- **Phase 5** (Deployment): Depends on Phase 1 (migration must be generated). Deploy after all other phases are complete and tested.

### Parallel Opportunities

- Phase 2 and Phase 3 can run in parallel (both only depend on Phase 1)
- Phase 4 can start after Phase 1, in parallel with Phases 2 and 3
- Within each phase, [P]-marked tasks can run in parallel
- Tests within each phase should be written before implementation tasks

### Implementation Strategy

1. Complete Phase 1 → Schema foundation ready
2. Launch Phases 2, 3, 4 in parallel (if capacity allows) or sequentially
3. **Before T409**: Ensure T205a (integrate `recordLlmCall()` into `repairWithFallback()`) is complete
4. **STOP and VALIDATE**: Run full test suite, verify golden eval, verify raw outputs stored
5. **Deploy**: Run Phase 5 to apply migration to production
