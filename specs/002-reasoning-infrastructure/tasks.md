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

- [ ] T001 [P] Create `src/contracts/reasoning.schemas.ts` — NEW Zod schemas (all in one pass):
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

- [ ] T002 [P] Extend `src/contracts/reflection.schemas.ts`:
  - Import `EvidenceEntry` and `ReasoningTrace` from `reasoning.schemas.ts`
  - Add `evidence: EvidenceEntry[]` to `BiasItem`
  - Add `noBiasDetected: boolean` to `AssessmentOutput`
  - Add `reasoningTrace?: ReasoningTrace` optional field to `AssessmentOutput`
  - Add `inputContext: "story-only" | "full"` to `AssessmentOutput`
  - Add `modelName: string` to `AssessmentOutput`
  - Add `mode: "story_only" | "full"` to `GenerateAssessmentRequestSchema`

- [ ] T003 [P] Create `src/contracts/run.schemas.ts`:
  - NEW — Request schema for unified assessment endpoint:
  - `AssessmentRequestSchema` with:
    - `mode: "story_only" | "full"`
    - `sessionId: string` (optional for story-only, required for full)
    - `story: string` (min 50, max 3000)
    - `questions?: string[]` (required when mode=full)
    - `answers?: string[]` (required when mode=full)
  - `CreateSessionRequestSchema` with `storyId: string`

**Checkpoint**: All Zod schemas defined and unit-testable. Entity relationships clear.

---

## Phase 1: Metrics + Persistence Infrastructure

**Purpose**: Build the evaluation metrics, system metrics, and persistence write path.

- [ ] T101 [P] Create `src/evaluation/compute-evaluation-metrics.ts`:
  - `computeEvaluationMetrics(assessment, input)` — standalone pure function
  - Validates evidence excerpts against input text (verbatim substring matching)
  - Returns `{ evidence_grounded_rate: number | null, false_positive_rate: number | null }`
  - `evidence_grounded_rate` = proportion of bias items with all evidence excerpts found verbatim in input; `null` when bias list is empty
  - `false_positive_rate` = proportion of assessments returning biases for no_bias stories; `null` when no no_bias assessments in dataset
  - No side effects, no imports from production path

- [ ] T102 [P] Create `src/evaluation/compute-system-metrics.ts`:
  - `computeSystemMetrics(responses)` — standalone pure function
  - Input: `Array<{ requiredRepair: boolean }>` — one entry per LLM response
  - Returns `{ schema_parse_rate: number, repair_rate: number }`
  - `schema_parse_rate` = proportion of responses that parsed without invoking repair pipeline
  - `repair_rate` = proportion of responses that required repair (= 1 - schema_parse_rate)
  - No side effects

- [ ] T103 [P] Create `src/persistence/session-store.ts`:
  - Export `createSession(storyId: string): Promise<Session>`
  - Export `createRun(sessionId: string, runData: Omit<Run, 'id' | 'createdAt'>): Promise<Run>`
  - Export `getSession(id: string): Promise<Session | null>`
  - Export `getRunsBySession(sessionId: string): Promise<Run[]>`
  - Default implementation: JSON files in `./data/sessions/` and `./data/runs/`
  - Feature-flagged: when `PERSIST_REASONING_TRACE=supabase`, use Supabase tables

- [ ] T104 [P] Create `src/persistence/trace-store.ts`:
  - Export `persistReasoningTrace(runId: string, trace: ReasoningTrace): Promise<void>`
  - Export `getReasoningTrace(runId: string): Promise<ReasoningTrace | null>`
  - File path: `./data/reasoning-traces/{session_id}/{stage}/{run_id}.json`
  - Feature-flagged Supabase upgrade (T404)
  - Wire call added in T203 (assessment service)

- [ ] T105 [P] Create `src/persistence/eval-results-store.ts`:
  - Export `persistEvalResult(result: EvalResult): Promise<void>`
  - Export `getEvalResultByHash(inputHash: string, promptVersion: string): Promise<EvalResult | null>`
  - Export `getLatestEvalResults(promptVersion: string, limit: number): Promise<EvalResult[]>`
  - File path: `./data/eval-results/{input_hash}_{prompt_version}.json`
  - Required persistence (not optional)
  - Feature-flagged Supabase upgrade (T404)

**Checkpoint**: All persistence write paths exist. Metrics functions return correct values for known test cases. Traces generated from Phase 2 forward are stored.

---

## Phase 2: Reasoning Pipeline — Orchestrator Upgrade

**Purpose**: Upgrade the assessment orchestrator to two-phase flow with intermediate reasoning + evidence binding.

- [ ] T201 [P] Update `src/prompts/reflection/assessment/system.md`:
  - Update assessment prompt to emit structured reasoning steps:
    - story analysis → interpretations → bias hypotheses → evidence mapping → final assessment
  - Include instructions for evidence binding (each bias claim must reference specific story/answer excerpts)
  - Include instructions for `no_bias_detected` signal when no biases found
  - Ensure prompt instructs LLM to assign `stage` and `scope` context in output

- [ ] T202 [P] Update `src/prompts/reflection/assessment/schema.md`:
  - Update output schema to include reasoning trace + evidence per bias
  - Document the `no_bias_detected` signal format
  - Document that `stage` and `scope` are output fields

- [ ] T203 Upgrade `src/orchestrators/reflection/assessment.service.ts`:
  - Refactor into two entry points:
    - `runStoryOnlyAssessment(session, story)` → creates run with stage=initial_assessment, scope=story_only
    - `runFullAssessment(session, story, questions, answers)` → creates run with stage=post_questions_assessment, scope=story_plus_answers
  - Both:
    - Call provider once with output schema that includes reasoning trace
    - Parse trace + evidence from response
    - Validate each step with Zod schemas from `reasoning.schemas.ts`
    - Validate `prompt_version` is present on every step — throw if missing
    - Stamp `model_name` from provider config
    - Stamp `stage`, `scope`, `prompt_version` on run and trace
    - Call persistReasoningTrace() from T104 after trace is generated
    - Return structured result with trace + assessment

- [ ] T204 Ensure `reasoning_trace` is always computed and persisted:
  - Trace is generated on every run (FR-003)
  - `includeReasoningTrace` query param controls response body only, not computation or persistence
  - Both story-only and full runs produce and persist traces

- [ ] T205 Handle `no_bias_detected` signal in assessment service:
  - When LLM returns no biases, return empty bias array with `noBiasDetected: true` status flag
  - `computeEvaluationMetrics` returns `null` for empty bias lists (eval-only, not called here)

- [ ] T206 Wire evidence validation into assessment service:
  - Drop/flag bias items without valid evidence (FR-001)
  - Uses `validateEvidence()` from T301 (import from `src/parsers/evidence-validator.ts`)
  - If T301 is not yet implemented, leave a documented stub: `// TODO: wire evidence validation — blocked on T301 (evidence-validator.ts)`

- [ ] T207 Update `src/orchestrators/reflection/question.service.ts`:
  - Accept `story_analysis` and `interpretations` from Trace 1 as input context (FR-018)
  - Signature changes from `generateQuestions(story: string)` to `generateQuestions(story: string, storyAnalysis: StoryAnalysis, interpretations: InterpretationSchema[])`
  - Questions should be reasoning-aware, not text-surface-level
  - Also update `src/prompts/reflection/questions/system.md` to receive `story_analysis.themes`, `emotional_tone`, `key_events`, and the highest-plausibility interpretations as context. Questions should probe the user's interpretations, not just surface-level story details.

**Checkpoint**: Two-phase assessment works end-to-end. Questions are reasoning-context-aware. Both traces persisted. Evidence validation wired (or stubbed with documented TODO).

---

## Phase 3: Evidence Validation + `no_bias` Dataset + CI

**Purpose**: Build the adversarial testing infrastructure, evidence validation, and CI gating.

- [ ] T301 [P] Create `src/parsers/evidence-validator.ts`:
  - `validateEvidence(assessment, input)` — checks every excerpt exists verbatim in story or answers
  - Returns `{ valid: boolean, violations: Violation[] }`
  - `Violation` type: `{ biasName: string, excerpt: string, reason: string }`

- [ ] T302 [P] Create `evaluations/no_bias/`:
  - 10+ neutral stories — situations without cognitive bias triggers (e.g., routine errands, neutral observations)
  - JSON format (same shape as golden set):
    ```json
    {
      "story": "I went to the grocery store to buy milk and bread, paid with my credit card, and drove home without incident.",
      "questions": [],
      "expected_biases": []
    }
    ```
  - NOTE: The `questions` field is unused for no_bias dataset but kept for format compatibility with golden set.
  - Each file should contain one story with `expected_biases: []`.

- [ ] T303 Extend `scripts/eval-reflection.ts`:
  - Run assessments against golden dataset
  - Run assessments against no_bias dataset
  - Compute both metric groups:
    - evaluation_metrics: evidence_grounded_rate, false_positive_rate
    - system_metrics: schema_parse_rate, repair_rate
  - Accept CLI flags for thresholds:
    - `--grounded-rate-threshold` (default: 0.9)
    - `--false-positive-threshold` (default: 0.1)
    - `--schema-parse-threshold` (default: 0.95)
  - Report pass/fail for each threshold

- [ ] T304 Add determinism check to eval script:
  - Compute `input_hash` as SHA-256 of `(prompt_version, model_name, story, answers_json)`
  - Before running eval, check if identical hash + prompt_version already exists in eval_results
  - If exists, skip and warn (unless `--force` flag provided)
  - If exists with different metrics, fail CI (non-determinism detected)

- [ ] T305 Create `src/jobs/eval-assessment.ts`:
  - NEW — Inngest eval function
  - Accepts `triggerType: "gate" | "monitor"`
  - Gate mode: runs golden + no_bias eval, persists results to eval_results, returns pass/fail
  - Monitor mode: runs golden + no_bias eval, persists results, alerts on failure (does not block)
  - Both modes compute all 4 metrics (evidence_grounded_rate, false_positive_rate, schema_parse_rate, repair_rate)
  - Both modes check determinism via input_hash
  - Returns structured result: `{ passed: boolean, metrics: EvaluationMetrics, systemMetrics: SystemMetrics, dataset: string }`

- [ ] T306 Create `.github/workflows/prompt-eval.yml`:
  - NEW — GitHub Action workflow
  - Triggers on PRs modifying `src/prompts/**`
  - Calls Inngest eval function with `triggerType: "gate"`
  - Fails the PR check on any metric below threshold
  - Comment on PR with evaluation results

- [ ] T307 Add Inngest cron schedule:
  - Daily cron calling Inngest eval with `triggerType: "monitor"`
  - Alert on metric degradation (Slack/webhook if configured)
  - Does not block deploys

**Checkpoint**: `no_bias` dataset exists. Eval script runs all metric dimensions. CI gate blocks bad prompt changes. Daily monitoring alerts on degradation.

---

## Phase 4: API + Persistence Upgrade

**Purpose**: Wire unified assessment endpoint and upgrade persistence to Supabase.

- [ ] T401 Refactor `src/routes/reflection.ts`:
  - `POST /v1/reflection/assessment` accepts `mode: "story_only" | "full"` in body
  - When mode=story_only:
    - Create session and initial run (stage=initial_assessment, scope=story_only)
    - Call `runStoryOnlyAssessment()`
    - Return assessment + trace (if requested)
  - When mode=full:
    - Create post-questions run (stage=post_questions_assessment, scope=story_plus_answers)
    - Call `runFullAssessment()`
    - Return assessment + trace (if requested)
  - Both modes persist session + run + trace automatically via orchestrator
  - Add `includeReasoningTrace` query param — controls response body only (trace always persisted)

- [ ] T402 Return metadata in assessment response:
  - `noBiasDetected` boolean
  - `reasoningTrace` (when `includeReasoningTrace=true` query param set)
  - `modelName`, `stage`, `scope` on response

- [ ] T403 [P] Add `AssessmentResponse` type in `src/contracts/reflection.schemas.ts`:
  - Fields: `biases: BiasItem[]`, `reflectionPrompt: string`, `reasoningTrace?: ReasoningTrace`, `noBiasDetected?: boolean`, `inputContext: "story-only" | "full"`, `modelName: string`, `stage: string`, `scope: string`
  - Import `ReasoningTrace` from `reasoning.schemas.ts`

- [ ] T404 Upgrade all persistence stores to Supabase write path:
  - `src/persistence/session-store.ts` — implement `PERSIST_REASONING_TRACE=supabase` branch
  - `src/persistence/trace-store.ts` — implement `PERSIST_REASONING_TRACE=supabase` branch
  - `src/persistence/eval-results-store.ts` — implement `PERSIST_REASONING_TRACE=supabase` branch
  - Create migration file `src/persistence/migrations/002_reasoning_infra.sql`:
    ```sql
    CREATE TABLE sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      story_id uuid NOT NULL,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES sessions(id),
      model_name text NOT NULL,
      stage text NOT NULL CHECK (stage IN ('initial_assessment', 'post_questions_assessment')),
      scope text NOT NULL CHECK (scope IN ('story_only', 'story_plus_answers')),
      prompt_version text NOT NULL,
      input_hash text NOT NULL,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE reasoning_traces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES runs(id),
      trace jsonb NOT NULL,
      trace_type text NOT NULL CHECK (trace_type IN ('story_only', 'full')),
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE eval_results (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid REFERENCES runs(id),
      prompt_version text NOT NULL,
      model_name text NOT NULL,
      dataset text NOT NULL CHECK (dataset IN ('golden', 'no_bias', 'all')),
      evaluation_metrics jsonb NOT NULL,
      system_metrics jsonb NOT NULL,
      input_hash text NOT NULL,
      passed boolean NOT NULL,
      run_at timestamptz DEFAULT now()
    );

    CREATE INDEX idx_runs_session ON runs(session_id);
    CREATE INDEX idx_traces_run ON reasoning_traces(run_id);
    CREATE INDEX idx_eval_hash ON eval_results(input_hash, prompt_version);
    ```
  - Wire into `src/server.ts` as plugin/hook
  - Both paths (file + supabase) testable via feature flag toggle

**Checkpoint**: Unified API endpoint handles both modes. Persistence works with both file and Supabase backends.

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

- [ ] T503 [P] Create `tests/unit/evaluation/compute-evaluation-metrics.test.ts`:
  - `computeEvaluationMetrics` known cases: all grounded, partially grounded, none grounded
  - Empty bias list → evidence_grounded_rate is null
  - No no_bias assessments → false_positive_rate is null

- [ ] T504 [P] Create `tests/unit/evaluation/compute-system-metrics.test.ts`:
  - `computeSystemMetrics` known cases: all parsed, some repaired, all repaired
  - Edge case: empty responses array
  - Edge case: single response

- [ ] T505 Extend `tests/integration/assessment.test.ts`:
  - Verify reasoning trace shape in response
  - Verify evidence binding on bias items
  - Verify `no_bias_detected` signal
  - Verify `stage` and `scope` on output
  - Verify `modelName` present on output

- [ ] T506 [P] Create `tests/integration/evidence-pipeline.test.ts`:
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
| 2 | T201, T202, T203, T204, T205, T206, T207 | Two-phase assessment with reasoning trace |
| 3 | T301, T302, T303, T304, T305, T306, T307 | no_bias + eval script + CI gate + daily monitor |
| 4 | T401, T402, T403, T404 | Unified API + Supabase persistence |
| 5 | T501, T502, T503, T504, T505, T506, T507, T508, T509, T510, T511 | All tests green. READMEs updated. |

**Total: 34 tasks across 6 phases (0–5)**
