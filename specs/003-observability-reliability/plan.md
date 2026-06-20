# Plan 003 — Observability, Reliability & Evaluation Infrastructure

## Technical Summary

Add infrastructure to store raw LLM outputs, track reliability metrics per call, and run simple dataset evaluations. This stage is about observability — answering "why did the model produce this?", "what failed?", "how often?", and "how long?". No pass/fail scoring, no baseline comparison, no dataset creation.

## Architecture

### Folder Structure

```
biassemble-core/src/
├── db/
│   ├── schema.ts              # Add llm_calls table; extend eval_results table
│   └── queries.ts             # Add queries for new/extended tables
├── observability/
│   ├── logger.ts              # Existing
│   ├── llm-call-recorder.ts   # NEW: recordLlmCall() — persist LLM call metadata and raw responses
│   └── reliability-metrics.ts # NEW: Aggregate reliability metrics from llm_calls
├── evaluation/
│   ├── compute-evaluation-metrics.ts  # Existing
│   ├── compute-system-metrics.ts      # Existing
│   ├── compute-trace-analytics.ts     # Existing
│   ├── run-eval.ts                    # Existing
│   └── eval-runner.ts                 # NEW: Simple dataset runner (runDataset)
├── persistence/
│   ├── ports.ts               # Add LlmCallStore interface; extend EvalResultStore
│   └── types.ts               # Add LlmCallRecord; extend EvalResultRecord
└── jobs/
    ├── inngest-functions.ts   # Existing
    └── eval-run.ts            # NEW: Eval run job definition
```

### Key Design Decisions

1. **Raw LLM storage**: Store in PostgreSQL TEXT column. At current scale (development/evaluation), this is simpler and more reliable than external storage. Revisit if storage costs become significant.

2. **Call recording helper**: Create a `recordLlmCall()` function that every pipeline stage calls after completing an LLM call. This function:
   - Persists provider, model, stage, prompt_version (from `PromptRegistry.getVersion()`), raw response, parsed output, status, failure_type, token usage, timing
   - Inserts into `llm_calls` table
   - Fire-and-forget: errors in recording are logged but do not propagate
   - This is a simple helper function, not an event bus — naming reflects what it actually does

3. **One row per actual provider call**: Each LLM attempt (including retries and fallback calls) is a separate row. If a call times out and is retried twice before succeeding, there are 3 rows. If `repairWithFallback()` triggers a fallback model call, both the primary and fallback calls are recorded with `call_type: primary | fallback`. This eliminates ambiguity and makes metrics computation straightforward. Status enum is `success | timeout | error` (no `retry` status).

4. **Token usage tracking**: Store `input_tokens`, `output_tokens`, `total_tokens` on each `llm_calls` row. Token counts come from provider response metadata. NULL if provider doesn't return them. This enables future cost analysis without schema migration.

5. **Indexes for query performance**: Add indexes on `llm_calls(provider)`, `llm_calls(model)`, `llm_calls(stage)`, `llm_calls(created_at)`, `llm_calls(session_id)`. Metrics queries filter by these columns frequently.

6. **Failure type categorization**: Every non-success call records a `failure_type` (`schema_validation`, `parse_error`, `provider_error`, `timeout`, `other`). This enables the schema validation failure rate metric without parsing error messages.

7. **Extend `eval_results` instead of new tables**: Rather than creating separate `eval_runs` and `eval_scenario_results` tables, extend the existing `eval_results` table with three columns: `eval_run_id` (groups scenarios from same execution), `scenario_id` (identifies the story/scenario), and `raw_output` (final parsed `AssessmentOutput` JSON for debugging). This avoids table proliferation and keeps the schema simple. Run-level aggregates are computed via `GROUP BY eval_run_id` queries. Note: `raw_output` stores the final parsed output, distinct from `llm_calls.raw_response` which stores raw LLM text pre-parse.

8. **Simple eval runner — `runDataset()`**: Takes a dataset of stories, runs each through the pipeline, stores results in `eval_results` with a shared `eval_run_id` and `raw_output`. No pass/fail changes, no diff engine, no baseline comparison. Just: run stories → store outputs with raw text. We don't yet know what "correct" means for all bias categories.

9. **No baseline system**: Baseline snapshots, regression detection, and diff engines are deferred. We don't have stable datasets, enough eval volume, or a defined pass/fail framework yet.

10. **Reliability metrics aggregation**: `computeReliabilityMetrics()` queries `llm_calls` and returns p50/p95/p99 latency, success rate, timeout rate, fallback rate, and schema validation failure rate — filterable by time range, provider, model, and stage. Aggregation is performed in the application layer (load calls, compute in memory) to avoid overengineering with SQL aggregations at current scale.

11. **Raw output retrieval queries**: Implement `getCallsBySession()`, `getCallsByStage()`, and `getCallsBySessionAndStage()` in `src/db/queries.ts` for debugging access to raw LLM outputs.

12. **`llm_calls` vs `reasoning_traces`**: The `llm_calls` table is the observability layer (raw LLM outputs for debugging). The `reasoning_traces` table is the product data layer (validated, parsed traces used by the application). Both coexist: `llm_calls` captures partial failures where `reasoning_traces` has no row.

13. **Backwards compatibility**: All new tables are additive. Existing code continues to work. `llm_calls` records are created as a side effect of pipeline execution, not a requirement.

14. **Tests inline with implementation**: Each phase includes its tests before the implementation tasks (TDD approach).

## Phases

### Phase 1: Database Schema, Types & Tests
- Add `llm_calls` table to `src/db/schema.ts` (with indexes on provider, model, stage, created_at, session_id)
- Extend `eval_results` table with `eval_run_id`, `scenario_id`, `raw_output` columns
- Add `LlmCallRecord` type to `src/persistence/types.ts`; extend `EvalResultRecord` with new fields
- Add `LlmCallStore` interface to `src/persistence/ports.ts`; extend `EvalResultStore` with new query methods
- Implement query functions in `src/db/queries.ts` (recordLlmCall, getCallsBySession, getCallsByStage, etc.)
- Create Drizzle migration for schema changes
- Write unit tests for type correctness and port contracts

### Phase 2: LLM Call Recording & Tests
- Create `src/observability/llm-call-recorder.ts`
- Implement `recordLlmCall()` helper function (with failure_type support, token usage, call_type, stores prompt_version, one row per call)
- Integrate into `repairWithFallback()` to record both primary and fallback calls with correct `call_type`
- `repairWithFallback()` is the sole owner of LLM call recording — services do not call `recordLlmCall()` directly
- Write unit tests for call recorder (TDD: tests first)
- Write integration tests for recording flow

### Phase 3: Reliability Metrics & Tests
- Create `src/observability/reliability-metrics.ts`
- Implement `computeReliabilityMetrics()` with percentile calculation
- Write unit tests with fixture data
- Verify filtering by provider, model, stage, time range

### Phase 4: Simple Eval Runner & Integration
- Create `src/evaluation/eval-runner.ts`
- Implement `runDataset()` — generates `eval_run_id` (UUID), runs stories through pipeline, stores results in `eval_results` with shared `eval_run_id`, `scenario_id`, and `raw_output`
- Write unit tests for eval runner (TDD: tests first)
- Create `src/jobs/eval-run.ts` job definition
- Register eval run job in `src/jobs/inngest-functions.ts`
- Write integration test for eval run flow
- Verify backwards compatibility

**Sequencing note:** Phase 4 can start after Phase 1 (schema exists), but the golden dataset eval run task (T409) requires Phase 2 integration task (T205a — integrating `recordLlmCall()` into `repairWithFallback()`) to be complete first. Otherwise, eval runs won't produce `llm_calls` rows.

## Environment Variables

No new environment variables required for this stage.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Large raw responses bloat DB | Use TEXT type, monitor table size, plan for archival |
| Recording adds latency | `recordLlmCall()` is fire-and-forget (async, catch errors) |
| Eval runs block other traffic | Run evals via Inngest async jobs |
| Backwards compatibility breaks | All new tables are additive, no schema changes to existing tables |
| Percentile computation is expensive at scale | Current scale is small; revisit if needed |
