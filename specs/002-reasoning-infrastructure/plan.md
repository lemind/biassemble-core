# Implementation Plan: Reasoning Infrastructure for Auditable Assessment

**Branch**: `002-reasoning-infrastructure` | **Date**: 2026-06-03 (v2) | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-reasoning-infrastructure/spec.md`

**Depends on**: `001-reflection-core` (flat assessment pipeline MVP)

---

## Summary

Upgrade the flat assessment pipeline from `001-reflection-core` into a **structured reasoning engine** with auditable intermediate representations. Instead of a single LLM call from story→biases, the pipeline produces explicit reasoning artifacts (intermediate schemas, evidence traces) that can be inspected, scored, and adversarially tested.

Four concepts form the architecture:

1. **Structured intermediate schemas** — typed reasoning steps between story input and bias output
2. **Evidence binding** — each bias claim is traceable to specific story/answer excerpts
3. **`evidence_grounded_rate` metric** — quantitative measure of how tightly bias output is anchored to user input
4. **`no_bias` adversarial datasets** — stories that intentionally lack bias triggers, to test false-positive resistance

### Key architectural change: Two-phase assessment per session

Instead of one LLM call per session, each session produces **two runs**:

| Run | Stage | Scope | Input |
|---|---|---|---|
| 1 | `initial_assessment` | `story_only` | Story text only |
| 2 | `post_questions_assessment` | `story_plus_answers` | Story + Q&A answers |

Both runs produce a full `reasoning_trace` and `assessment`. Both are persisted immutably alongside a `sessions` parent record and a `runs` entity that captures `stage`, `scope`, `model_name`, `prompt_version`, and `input_hash`.

---

## What Already Exists (from `001-reflection-core`)

- Fastify server (`src/server.ts`), Zod contracts (`src/contracts/reflection.schemas.ts`)
- Gemini provider (`src/providers/gemini.ts`), retry orchestrator (`src/orchestrators/retry.ts`), repair pipeline (`src/parsers/repair.ts`)
- Question + assessment orchestrators with prompt registry
- Golden evaluation set (5 stories in `evaluations/golden/reflection/`), eval script (`scripts/eval-reflection.ts`)
- Bias catalog (~30 biases in `datasets/biases/taxonomy.v1.json`)
- `prompt_version` / `schema_version` stamping on outputs
- Bias name normalization (`src/catalog/normalize.ts`)
- Contracts served at `GET /v1/contracts`

## What This Feature Adds

- **Intermediate reasoning schemas** — new Zod types: `StoryAnalysis`, `InterpretationSchema`, `BiasHypothesis`, `EvidenceMapping`, `ReasoningTrace`, `ReflectionSessionSchema`, `RunSchema`
- **Evidence binding** — `evidence` array on each bias item (`source`, `excerpt`, `relevance`)
- **`reasoning_trace`** — always computed and persisted; opt-in response inclusion
- **Two-phase assessment** — story-only assessment before questions, full assessment after answers
- **Session + Run entities** — `sessions` table, `runs` table with `stage`/`scope`/`model_name`/`input_hash`
- **Unified assessment endpoint** — `POST /assessment` with `mode: "story_only" | "full"` body field
- **Question service receives Trace 1** — `story_analysis` + `interpretations` passed to question generation
- **`computeEvaluationMetrics()`** — post-hoc evaluation function returning `{ evidence_grounded_rate, false_positive_rate }`
- **`computeSystemMetrics()`** — post-hoc function returning `{ schema_parse_rate, repair_rate }`
- **`no_bias` dataset** — 10+ neutral stories in `evaluations/no_bias/`
- **`no_bias_detected` response signal** — empty bias array with status flag
- **Evidence validation** — verbatim excerpt matching, rejection of hallucinated quotes
- **Extended eval script** — runs golden-set, no_bias, computes all metrics, accepts per-metric thresholds
- **Inngest eval job** — scheduled + CI-gate triggers, persists to `eval_results`
- **GitHub Action CI gate** — triggers on PRs modifying `src/prompts/`, blocks merge on metric failures
- **Interpretation layer** — `InterpretationSchema` between story analysis and bias hypotheses
- **Schema stubs** — `ProviderComparisonSchema`, `ContradictionSchema`, `ClaimSchema` reserved

---

## Technical Context

**Language/Version**: TypeScript 5.x strict (same as `001-reflection-core`)

**Existing Dependencies**: Fastify 5, Zod 4, `@google/generative-ai`, pino, vitest

**New Dependencies**: None — all additions use existing stack

**Testing**: Vitest — unit (schemas, evidence validator, evaluation metrics, system metrics), integration (full pipeline with mocked provider, two-phase session flow)

**Target Platform**: Same as `001-reflection-core` — Vercel Functions (Fastify entry `src/server.ts`)

**Performance Goals**: Reasoning trace adds < 500ms to assessment latency (single LLM call with structured output, not multi-turn). Metrics computed post-hoc in eval scripts, not in production path.

---

## Design Decisions

### Single LLM call with structured output (not multi-turn chain)

Each assessment run emits a single JSON that includes both the reasoning trace and the final assessment. This avoids latency amplification and keeps the pipeline simple. The LLM produces:

```json
{
  "reasoning_trace": {
    "story_analysis": { "themes": [], "emotional_tone": "", "key_events": [] },
    "interpretations": [{ "interpretation": "", "plausibility": 0.0, "supporting_evidence": [] }],
    "bias_hypotheses": [{ "bias_name": "", "confidence": 0.0, "supporting_excerpts": [] }],
    "evidence_mapping": [{ "bias_id": "", "evidence": [] }]
  },
  "assessment": {
    "biases": [{ "name": "", "evidence": [], "explanation": "", ... }],
    "reflection_prompt": "",
    "no_bias_detected": false
  }
}
```

### Two-phase assessment per session

Story-only assessment runs first. Question generation receives `story_analysis` + `interpretations` from Trace 1 — not raw story text. After user answers questions, full assessment runs with story + answers. Both traces persisted immutably. This enables before/after comparison: *"Confirmation Bias was 0.82 before questions, 0.41 after"*.

### `stage` and `scope` are orthogonal

| Field | Values | Purpose |
|---|---|---|
| `stage` | `initial_assessment` \| `post_questions_assessment` | Pipeline position |
| `scope` | `story_only` \| `story_plus_answers` | Input composition |

Both stamped on every `run`. Enables querying: *"All runs with initial_assessment/story_only vs post_questions_assessment/story_plus_answers"*.

### Unified assessment endpoint

Single route: `POST /v1/reflection/assessment` with `mode: "story_only" | "full"` in request body. No separate `/assessment/story-only` route — forward-compatible with future modes (e.g., `"adversarial"`, `"multi_model"`).

### Evidence validation is post-hoc

`computeEvaluationMetrics` runs in evaluation scripts, not in the production API path. The production path trusts the LLM output (with repair pipeline as safety net). Evidence validation in the production path drops/flags bias items without valid evidence (FR-001).

### Reasoning trace always computed

`includeReasoningTrace` controls response body only. The trace is always generated and persisted internally (FR-003).

### Persistence path exists from day one

File-based persistence in Phase 1 (`./data/reasoning-traces/{session_id}/{stage}/{run_id}.json`), upgraded to Supabase Postgres under `PERSIST_REASONING_TRACE` feature flag. Without persistence, eval on historical outputs is impossible.

### Metric groups are separated

| Group | Functions | Thresholds |
|---|---|---|
| `evaluation_metrics` | `computeEvaluationMetrics()` | evidence_grounded_rate ≥ 0.9, false_positive_rate < 0.1 |
| `system_metrics` | `computeSystemMetrics()` | schema_parse_rate ≥ 0.95, repair_rate < 0.05 |

Separated because they measure different things: model reasoning quality vs pipeline stability. One bad metric in either group fails the CI gate.

### Evaluation determinism

Same `prompt_version + model_name + dataset_version + input` must produce same metrics. Implemented via `input_hash` (SHA-256). Eval job checks for existing matching hash before rerunning. Non-determinism detected at runtime causes CI failure.

### Interpretation layer precedes bias hypotheses

Before the pipeline proposes bias candidates, it generates ranked interpretations of what happened in the story. Bias labels are then applied to the most plausible interpretations, not directly to raw story text. This prevents the common failure mode where the system labels a bias before considering alternative explanations.

### `no_bias` dataset is manually curated

Same format as golden set. Automated generation deferred.

### Backward-compatible

Existing assessment endpoint remains the primary API. Evidence binding and reasoning trace are additive. Existing clients that don't request `reasoningTrace` get the same response shape (plus `evidence` array on bias items).

---

## Implementation Phases

### Phase 0: Schema + Entity Definitions (new)

**Purpose**: Define all new Zod schemas and DB entities before implementation begins.

| Task | File(s) | Description |
|---|---|---|
| T001 | `src/contracts/reasoning.schemas.ts` | NEW — All new Zod schemas in one pass: `PromptVersionSchema` (branded), `StoryAnalysis`, `InterpretationSchema`, `BiasHypothesis`, `EvidenceMapping`, `ReasoningTrace`, `EvidenceEntry`, `ReflectionSessionSchema` (id, story_id, created_at), `RunSchema` (id, session_id, model_name, stage, scope, prompt_version, input_hash, created_at), `EvalResultSchema` (id, run_id?, prompt_version, model_name, dataset, evaluation_metrics, system_metrics, input_hash, passed, run_at). Plus stubs: `ClaimSchema`, `ProviderComparisonSchema`, `ContradictionSchema` (reserved, not in ReasoningTrace). `stage` and `scope` as Zod enums. |
| T002 | `src/contracts/reflection.schemas.ts` | Extend `BiasItem` with `evidence: EvidenceEntry[]` (imported from reasoning.schemas.ts). Add `noBiasDetected: boolean` to `AssessmentOutput`. Add `reasoningTrace?: ReasoningTrace` optional field. Add `inputContext: "story-only" | "full"` (derived from mode). Add `model_name: string`. |
| T003 | `src/contracts/run.schemas.ts` | NEW — Request schema for unified assessment endpoint: `AssessmentRequestSchema` with `mode: "story_only" | "full"`, `sessionId`, `story`, `questions?`, `answers?`. |

**Checkpoint**: All Zod schemas defined and unit-testable. Entity relationships clear.

---

### Phase 1: Metrics + Persistence Infrastructure

**Purpose**: Build the evaluation metrics, system metrics, and persistence write path.

| Task | File(s) | Description |
|---|---|---|
| T101 | `src/evaluation/compute-evaluation-metrics.ts` | NEW — `computeEvaluationMetrics(assessment, input)` — standalone pure function. Validates evidence excerpts against input text (verbatim substring matching). Returns `{ evidence_grounded_rate: number \| null, false_positive_rate: number \| null }`. No side effects. |
| T102 | `src/evaluation/compute-system-metrics.ts` | NEW — `computeSystemMetrics(responses)` — standalone pure function. Computes `schema_parse_rate` (proportion of responses that parsed without repair) and `repair_rate` (proportion that required repair). Takes an array of `{ requiredRepair: boolean }`. Returns `{ schema_parse_rate: number | null, repair_rate: number | null }`. Both are `null` when responses array is empty. |
| T103 | `src/persistence/session-store.ts` | NEW — Persistence for sessions and runs. Create session, create run, link traces. Default: JSON files in `./data/sessions/` and `./data/runs/`. Feature-flagged Supabase upgrade. |
| T104 | `src/persistence/trace-store.ts` | NEW — Persistence for reasoning traces. File path: `./data/reasoning-traces/{session_id}/{stage}/{run_id}.json`. Feature-flagged Supabase upgrade (T404). |
| T105 | `src/persistence/eval-results-store.ts` | NEW — Persistence for evaluation results. Required (not optional). File path: `./data/eval-results/{input_hash}_{prompt_version}.json`. Feature-flagged Supabase upgrade (T404). |

**Checkpoint**: All persistence write paths exist. Metrics functions return correct values. Traces generated from Phase 2 forward are stored.

---

### Phase 2: Reasoning Pipeline — Orchestrator Upgrade

**Purpose**: Upgrade the assessment orchestrator to two-phase flow with intermediate reasoning + evidence binding.

| Task | File(s) | Description |
|---|---|---|
| T201 | `src/prompts/reflection/assessment/system.md` | Update assessment prompt to emit structured reasoning steps + evidence binding. |
| T202 | `src/prompts/reflection/assessment/schema.md` | Update output schema to include reasoning trace + evidence per bias + `no_bias_detected` signal. |
| T203 | `src/orchestrators/reflection/assessment.service.ts` | Refactor into two entry points: `runStoryOnlyAssessment(session, story)` and `runFullAssessment(session, story, questions, answers)`. Both: call provider once with structured output schema; parse trace + evidence; validate each step with Zod; stamp `model_name`, `stage`, `scope`, `prompt_version`; persist reasoning trace. |
| T204 | `src/orchestrators/reflection/assessment.service.ts` | Ensure `reasoning_trace` is always computed and persisted on both runs. Trace is generated even if `includeReasoningTrace` is false in response. |
| T205 | `src/orchestrators/reflection/assessment.service.ts` | Handle `no_bias_detected` signal — return empty bias array with `noBiasDetected: true` status flag. |
| T206 | `src/orchestrators/reflection/assessment.service.ts` | Wire evidence validation into pipeline — drop/flag bias items without valid evidence (FR-001). Documented stub if T301 not yet implemented. |
| T207 | `src/orchestrators/reflection/question.service.ts` | Update to accept `story_analysis` and `interpretations` from Trace 1 as input context alongside raw story text (FR-018). |

**Checkpoint**: Two-phase assessment works end-to-end. Questions are reasoning-context-aware. Both traces persisted.

---

### Phase 3: Evidence Validation + `no_bias` Dataset + CI

**Purpose**: Build the adversarial testing infrastructure, evidence validation, and CI gating.

| Task | File(s) | Description |
|---|---|---|
| T301 | `src/parsers/evidence-validator.ts` | NEW — `validateEvidence(assessment, input)` — checks every excerpt exists verbatim in story or answers. Returns `{ valid: boolean, violations: Violation[] }`. |
| T302 | `evaluations/no_bias/` | Create 10+ neutral stories (same format as golden set). |
| T303 | `scripts/eval-reflection.ts` | Extend to run both golden-set and no_bias evaluations. Compute both metric groups. Accept CLI flags: `--grounded-rate-threshold`, `--false-positive-threshold`, `--schema-parse-threshold`. |
| T304 | `scripts/eval-reflection.ts` | Add determinism check: compute `input_hash` before eval, skip if identical hash + prompt_version already exists in `eval_results` (unless `--force`). |
| T305 | `src/jobs/eval-assessment.ts` | NEW — Inngest eval function. Accepts `triggerType: "gate" | "monitor"`. Gate mode: runs eval, blocks if thresholds not met. Monitor mode: runs eval, alerts on failure, does not block. Persists results to `eval_results`. |
| T306 | `.github/workflows/prompt-eval.yml` | NEW — GitHub Action workflow. Triggers on PRs modifying `src/prompts/`. Calls Inngest eval with `triggerType: "gate"`. Fails the PR check on metric failure. |
| T307 | Inngest config | Add daily cron schedule calling Inngest eval with `triggerType: "monitor"`. |

**Checkpoint**: `no_bias` dataset exists. Eval script runs all metric dimensions. CI gate blocks bad prompt changes. Daily monitoring alerts on degradation.

---

### Phase 4: API + Persistence Upgrade

**Purpose**: Wire unified assessment endpoint and upgrade persistence to Supabase.

| Task | File(s) | Description |
|---|---|---|
| T401 | `src/routes/reflection.ts` | Refactor `POST /v1/reflection/assessment` to accept `mode: "story_only" | "full"` in body. When mode=story_only: create session + initial run, run story-only assessment, return trace. When mode=full: create post-questions run, run full assessment, return trace. Both persist. |
| T402 | `src/routes/reflection.ts` | Return `noBiasDetected` status and `reasoningTrace` (when requested) in assessment response. |
| T403 | `src/contracts/reflection.schemas.ts` | Add `AssessmentResponse` type with `biases`, `reflectionPrompt`, `reasoningTrace?`, `noBiasDetected?`, `inputContext`, `modelName`, `stage`, `scope`. |
| T404 | `src/persistence/` (all stores) | Upgrade to Supabase write path: `sessions`, `runs`, `reasoning_traces`, `eval_results` tables. Feature-flagged via `PERSIST_REASONING_TRACE` env var. Both paths (file + supabase) testable via flag toggle. Supabase migration: see `src/persistence/migrations/002_reasoning_infra.sql`. |

**Checkpoint**: Unified API endpoint handles both modes. Persistence works with both file and Supabase backends.

---

### Phase 5: Tests

**Purpose**: Unit + integration tests for all new functionality.

| Task | File(s) | Description |
|---|---|---|
| T501 | `tests/unit/contracts/reasoning.schemas.test.ts` | NEW — Zod validation for all schemas: sessions, runs, traces, eval_results. Verify stage/scope enums, model_name, prompt_version branded type. |
| T502 | `tests/unit/parsers/evidence-validator.test.ts` | NEW — Evidence validation: verbatim match, hallucination rejection, empty edge cases. |
| T503 | `tests/unit/evaluation/compute-evaluation-metrics.test.ts` | NEW — `computeEvaluationMetrics` unit tests (all grounded, partially, none, empty bias list → null). |
| T504 | `tests/unit/evaluation/compute-system-metrics.test.ts` | NEW — `computeSystemMetrics` unit tests (all parsed, some repaired, all repaired). |
| T505 | `tests/integration/assessment.test.ts` | Extend — verify reasoning trace shape, evidence binding, `no_bias_detected` signal, two-phase flow. |
| T506 | `tests/integration/evidence-pipeline.test.ts` | NEW — Full pipeline with mocked provider: trace generation, evidence validation, hallucination rejection, two-phase session. |
| T507 | `tests/unit/evaluations/no-bias.test.ts` | NEW — Verify no_bias dataset loads and has correct format. |
| T508 | `tests/integration/two-phase-session.test.ts` | NEW — Full two-phase session flow: story-only assessment → questions → post-questions assessment. Verify both traces exist, stage/scope correct, question service received Trace 1 context. |
| T509 | `tests/integration/assessment.test.ts` | Add prompt_version enforcement test — verify pipeline throws when `prompt_version` is missing. |
| T510 | `tests/integration/inngest-eval.test.ts` | NEW — Verify Inngest eval function runs both datasets, computes all metrics, persists results, returns correct pass/fail. |

**Checkpoint**: All tests green.

---

## Execution Order

### Dependency Chain

1. **Phase 0** (Schema definitions) — no dependencies, pure Zod
2. **Phase 1** (Metrics + persistence) — depends on Phase 0 (schemas)
3. **Phase 2** (Orchestrator upgrade) — depends on Phase 0 + Phase 1
4. **Phase 3** (Evidence validation + no_bias + CI) — depends on Phase 2
5. **Phase 4** (API + persistence upgrade) — depends on Phase 2
6. **Phase 5** (Tests) — depends on Phase 0–4

### Parallel Opportunities

- T001, T002, T003 (Phase 0) — can run in parallel
- T101, T102, T103, T104, T105 (Phase 1) — can run in parallel once Phase 0 schemas exist
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

## Entity Relationship Summary

```
sessions
  id uuid PK
  created_at timestamptz
     ↑
  runs
  id uuid PK
  session_id uuid FK → sessions.id
  model_name text NOT NULL
  stage "initial_assessment" | "post_questions_assessment"
  scope "story_only" | "story_plus_answers"
  prompt_version text NOT NULL
  input_hash text NOT NULL
  created_at timestamptz
     ├── reasoning_traces (run_id FK → runs.id)
     ├── questions (run_id FK → runs.id)
     └── answers (run_id FK → questions.id + runs.id)
     
eval_results (standalone — linked to run optionally)
  id uuid PK
  run_id uuid FK → runs.id (optional)
  prompt_version text NOT NULL
  model_name text NOT NULL
  dataset text NOT NULL
  evaluation_metrics jsonb
  system_metrics jsonb
  input_hash text NOT NULL
  passed boolean NOT NULL
  run_at timestamptz
```

---

## Performance and storage implications

- Each trace averages 2–5KB JSON (structured steps, not raw text)
- Two traces per session: ~4–10KB total per user interaction
- Eval results: ~0.5KB per run, daily monitoring = ~30KB/year
- File persistence in development is essentially zero-cost; Supabase storage negligible

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM produces hallucinated evidence excerpts | Evidence validator rejects non-verbatim excerpts; pipeline drops/flags invalid bias items |
| Reasoning trace makes response too large | Trace always persisted; response inclusion is opt-in; pagination/truncation for large traces |
| `no_bias` dataset too small to catch false positives | Start with 10 stories; expand as evaluation reveals gaps |
| Multi-step reasoning degrades assessment quality | Single LLM call per run, not multi-turn chain; quality measured by metrics |
| Persistence adds complexity to MVP | File-based persistence in Phase 1 (zero infra); Supabase upgrade in Phase 4 |
| Two-phase session doubles API calls per user | Each call is still a single LLM invocation; latency per call unchanged; two calls total per session |
| Non-deterministic evaluation results | `input_hash` detection; CI fails if same hash produces different metrics |

---

## Phase Mapping

| Phase | Outcome |
|---|---|
| 0 | All new Zod schemas defined. Session, run, trace, eval_result entity relationships clear. |
| 1 | Metrics functions (evaluation + system) exist. Persistence write paths for sessions, runs, traces, eval_results. |
| 2 | Assessment endpoint produces two traces per session. Questions receive Trace 1 reasoning context. Both traces persisted. |
| 3 | Evidence validation. no_bias dataset. Eval script runs all dimensions. Inngest eval job. CI gate + daily monitor. |
| 4 | Unified API endpoint. Supabase persistence upgrade. |
| 5 | All tests green. |

---

### Actual Implementation (deviations from plan)

**Persistence**: Rejected file-based persistence. Instead defined typed ports in `src/persistence/types.ts` + `src/persistence/ports.ts` (camelCase store boundary) and implemented Drizzle ORM tables in `biassemble/backend/src/drizzle/schema.ts` with query functions in `biassemble/backend/src/lib/db/queries.ts`. No feature flag, no file fallback, no Supabase migration step — Drizzle-first from day one.

**Schema changes vs plan**:
- `runs` includes `provider` column (not in original plan)
- `reasoning_traces` has NO `trace_type` column (was planned but removed)
- `eval_results` includes `provider` column
- `stage`, `scope`, `dataset` use Drizzle enum constraints

---

## Constitution Check

*GATE: Pass*

| Principle | Plan compliance |
|---|---|
| I Proprietary isolation | All additions in `biassemble-core` (private); no prompts/keys in public repo |
| II Contract-first | Zod schemas for all new types; backward-compatible with existing contracts |
| III Evaluation-first | `no_bias` dataset + extended eval script + CI gate before production deployment |
| IV Modular simplicity | Single LLM call per run (not multi-turn chain); two runs per session; metrics post-hoc |
| V Structured outputs | JSON + Zod + repair pipeline for reasoning trace + evidence |
| VI Non-clinical | Existing `guardrails.md` applies to all new prompts |

No complexity tracking violations.