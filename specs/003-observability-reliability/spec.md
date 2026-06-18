# Spec 003 — Observability, Reliability & Evaluation Infrastructure

## Stage ID & Name

**003-observability-reliability** — Improve observability, reliability, and evaluation capabilities of the reasoning pipeline.

## Epic / Feature

**Epic:** Reasoning Infrastructure Hardening
**Feature:** Raw LLM output storage, reliability metrics, simple dataset evaluation

## User Story

As a **developer of Biassemble**, I want to **store raw LLM outputs and track reliability metrics**, so that I can **answer "why did the model produce this?", "what failed?", "how often does it fail?", and "how long does it take?"**.

## Why / Problem Statement

Currently:
- Only parsed `reasoning_trace` is saved to the database; the raw LLM response is lost after parsing.
- No systematic tracking of reliability metrics (latency, success rate, timeout rate, fallback rate) by provider/model/stage.
- No way to inspect what the LLM actually returned when parsing fails.

This makes it difficult to:
- Debug parsing failures (cannot see what the LLM actually returned).
- Identify which provider/model is underperforming or slow.
- Answer "did prompt 1.1.1 break something?"
- Know if repair is being triggered more often.

## Success Criteria

1. **Raw LLM output stored**: Every LLM call's raw response (before parsing) is persisted in the database.
2. **Reliability metrics tracked**: Latency (p50, p95, p99), success rate, timeout rate, fallback rate, and schema validation failure rate are recorded per provider, model, and pipeline stage.
3. **Dataset evaluation**: Can run a dataset through the pipeline, store raw outputs per scenario, and calculate basic stats. Attributable to provider and model.
4. **Multi-provider ready**: The data model stores `provider` and `model` on all records, enabling future comparison without schema changes.

## Requirements

### Functional Requirements

- **FR1: Store raw LLM response**
  - Save the complete raw text response from the LLM before any parsing occurs.
  - Raw response must be queryable for debugging purposes.
  - This is the primary artifact — raw output survives prompt changes, schema changes, and parser changes.

- **FR2: Track call-level metadata**
  - Record for each LLM call: provider name, model name, stage, call_type (primary/fallback), start time, end time, duration, status (success/timeout/error), failure type (schema_validation/parse_error/provider_error/timeout/other), token usage (input/output/total).
  - **One row per actual provider call.** If a call is retried, each attempt is a separate row. If `repairWithFallback()` triggers a fallback model call, both the primary and fallback calls are recorded as separate rows with different `call_type` values. This makes metrics computation clean — no ambiguity about what retry_count means.
  - This data must be aggregatable by provider, model, and stage.

- **FR3: Reliability metrics aggregation**
  - Compute from stored call data: average latency, p50/p95/p99 latency, success rate, timeout rate, fallback rate, schema validation failure rate.
  - Metrics must be filterable by time range, provider, model, and stage.
  - Expose a `computeReliabilityMetrics()` function that returns structured metrics.

- **FR4: Simple dataset evaluation**
  - Run a dataset of stories through the pipeline and store results in the existing `eval_results` table.
  - Each `runDataset()` call generates a shared `eval_run_id` (UUID) stamped on all scenario rows from that execution.
  - Each scenario row stores: `eval_run_id`, `scenario_id`, `raw_output` (raw LLM text), plus existing fields (provider, model, metrics, passed).
  - No pass/fail scoring changes in this stage — we don't yet have a stable definition of "correct".
  - Run-level aggregates (total scenarios, pass count) computed via `GROUP BY eval_run_id` queries.

- **FR5: Raw output retrieval for debugging**
  - Provide query functions to retrieve raw LLM output for a given session/stage for debugging.
  - Implement `getCallsBySession(sessionId)`, `getCallsByStage(stage)`, and `getCallsBySessionAndStage(sessionId, stage)` in `src/db/queries.ts`.

### Non-Functional Requirements

- **NFR1: Storage efficiency** — Raw LLM responses can be large; consider storage implications. Use appropriate column type (TEXT/JSONB).
- **NFR2: Query performance** — Metrics queries should not block production traffic.
- **NFR3: Backwards compatibility** — Existing sessions without raw output data must continue to work.
- **NFR4: Privacy** — Raw LLM responses may contain user data; apply same retention/privacy rules as session data.

## Data Model Changes

### New Table: `llm_calls`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID (PK) | Unique call identifier |
| `session_id` | UUID (FK, nullable) | Associated session |
| `stage` | VARCHAR | Pipeline stage: `assessment`, `question` |
| `call_type` | VARCHAR | `primary` (main provider call) or `fallback` (fallback call inside repairWithFallback) |
| `provider` | VARCHAR | Provider name: `gemini`, `openai`, etc. |
| `model` | VARCHAR | Model identifier used |
| `prompt_version` | VARCHAR | Prompt template version (consistent with `runs` table). Sourced from `PromptRegistry.getVersion()` (e.g., "assessment-v1.1.2"). |
| `raw_response` | TEXT | Complete raw LLM response before parsing |
| `parsed_output` | JSONB | Parsed/structured output (what was actually used). NULL if parsing failed completely. |
| `status` | VARCHAR | `success`, `timeout`, `error` — one row per actual provider call |
| `failure_type` | VARCHAR | `schema_validation`, `parse_error`, `provider_error`, `timeout`, `other` — NULL on success |
| `input_tokens` | INTEGER | Input token count from provider (NULL if unavailable) |
| `output_tokens` | INTEGER | Output token count from provider (NULL if unavailable) |
| `total_tokens` | INTEGER | Total token count (input + output) |
| `started_at` | TIMESTAMPTZ | Call start time |
| `ended_at` | TIMESTAMPTZ | Call end time |
| `duration_ms` | INTEGER | Call duration in milliseconds |
| `error_message` | TEXT | Error details if status is error/timeout |
| `created_at` | TIMESTAMPTZ | Record creation time |

**Indexes on `llm_calls`:** `provider`, `model`, `stage`, `created_at`, `session_id`

**Retry semantics:** One row per actual provider call. If a call times out and is retried twice before succeeding, there are 3 rows: two with `status=timeout` and one with `status=success`. Fallback rate is computed as: (count of calls with `call_type=fallback`) / (count of calls with `call_type=primary`).

**Fallback call semantics:** When `repairWithFallback()` triggers a fallback model call, both the primary call and the fallback call are recorded as separate rows. Example:

```
Call 1: call_type=primary,   status=error, failure_type=schema_validation
Call 2: call_type=fallback,  status=success, failure_type=NULL
```

The primary call's `parsed_output` is NULL (parsing failed). The fallback call's `parsed_output` contains the successfully parsed result.

**Relationship to `reasoning_traces` table:** The `llm_calls` table is the **observability layer** — it stores raw LLM outputs for debugging and replay. The `reasoning_traces` table is the **product data layer** — it stores validated, parsed traces used by the application. Both tables coexist:
- `llm_calls.raw_response` = raw LLM text (pre-parse)
- `llm_calls.parsed_output` = parsed result from this specific call (may be partial if repair succeeded)
- `reasoning_traces.trace` = canonical parsed trace (post-parse, validated by Zod)

If a call fails completely (no successful parse), `reasoning_traces` has no row, but `llm_calls` still has the raw response for debugging.

### Extended Table: `eval_results`

Instead of creating new `eval_runs` and `eval_scenario_results` tables, extend the existing `eval_results` table with three columns to support run-level grouping and raw output storage:

| Column | Type | Description |
|--------|------|-------------|
| `eval_run_id` | UUID | Groups all scenarios from the same eval execution. Generated as randomUUID() in application code per `runDataset()` call. |
| `scenario_id` | VARCHAR | Identifier for the story/scenario within the dataset |
| `raw_output` | TEXT | Final parsed `AssessmentOutput` JSON for this scenario (nullable). Enables debugging of eval results. Distinct from `llm_calls.raw_response` (which stores raw LLM text pre-parse). |

The existing columns remain unchanged:
- `id`, `run_id`, `provider`, `model_name`, `prompt_version`, `dataset`, `evaluation_metrics`, `system_metrics`, `input_hash`, `passed`, `run_at`

**Run-level grouping:** All scenarios from a single `runDataset()` call share the same `eval_run_id`. Query run-level aggregates with:

```sql
SELECT eval_run_id, COUNT(*) as total_scenarios, 
       SUM(CASE WHEN passed THEN 1 ELSE 0 END) as passed_count
FROM eval_results
GROUP BY eval_run_id;
```

**No separate run table needed:** Run-level metadata (dataset, provider, model, timing) is already on each `eval_results` row. Status tracking (running/completed/failed) is an application-level concern during execution, not a persisted state.

## UX / Flow Changes

- No direct user-facing UI changes in this stage.
- Raw LLM output is accessible via API for debugging (internal tooling).
- Eval run results are accessible for inspection (no scoring/dashboard yet).

## Edge Cases

- **EC1: Very large raw responses** — Some LLM responses may exceed typical column sizes. Use TEXT type which handles unlimited size in PostgreSQL.
- **EC2: Missing raw response** — If recording fails (e.g., crash before save), the row should still exist with `raw_response = NULL` and appropriate status.
- **EC3: Backwards compatibility** — Existing sessions without `llm_calls` records must still function. Queries for raw output should handle NULL gracefully.

## Open Questions

- **OQ1:** Should raw responses be stored in a separate storage (S3, etc.) for cost efficiency, or is PostgreSQL TEXT sufficient for current scale? **Decision**: PostgreSQL TEXT is sufficient for current scale. Revisit if storage exceeds 10GB.
- **OQ2:** Should we store the raw prompt text as well, or is prompt_version sufficient? **Decision**: `prompt_version` is sufficient. The prompt is rendered from versioned templates + story text (already stored in session data). Storing the full rendered prompt would be redundant — it can be reconstructed from `prompt_version` + story + catalog.

## Dependencies

- Depends on existing `sessions` table for FK relationship.
- Depends on existing prompt hashing utility (`src/lib/hash.ts`).
- Depends on existing evaluation infrastructure (`src/evaluation/`).
- No new external dependencies required.

## Out of Scope

- Real-time metrics dashboard UI (data layer only in this stage).
- Multi-provider A/B testing logic (data model supports it, logic is future).
- Automated alerting on metric thresholds (future).
- Cost tracking per call (future — token counts are stored, but cost calculation is out of scope).
- **Baseline snapshots and regression comparison** (future — we don't have stable datasets or pass/fail criteria yet).
- **Pass/fail scoring for eval scenarios** (future — we don't yet know what "correct" means for all bias categories).
- **Dataset creation** (no-bias, adversarial, ambiguous datasets belong to later roadmap items).
- **Diff engine / regression framework** (future).
