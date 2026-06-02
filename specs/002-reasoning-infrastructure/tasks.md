# Tasks: Reasoning Infrastructure for Auditable Assessment

**Input**: Design documents from `/specs/002-reasoning-infrastructure/`

**Prerequisites**: plan.md, spec.md

**Path convention**: `src/...` at repository root (`biassemble-core/`)

**Tests**: Required — unit + integration for all new functionality.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Intermediate Reasoning Schemas + Evidence Contracts + Persistence

**Purpose**: Define the typed reasoning pipeline. Every assessment produces structured intermediate steps, not just a flat bias list. Persistence write path exists from day one.

- [ ] T101 Create `src/contracts/reasoning.schemas.ts` — NEW Zod schemas (all in one pass):
  - `PromptVersionSchema` as `z.string().min(1).brand("PromptVersion")`
  - `StoryAnalysis` (themes: string[], emotional_tone: string, key_events: string[], prompt_version: PromptVersion)
  - `InterpretationSchema` (interpretation: string, plausibility: number 0.0–1.0, supporting_evidence: string[], rejected?: boolean)
  - `BiasHypothesis` (bias_name: string, confidence: number 0.0–1.0, supporting_excerpts: string[], uncertainty_reasons: string[], prompt_version: PromptVersion)
    - NOTE: `uncertainty_reasons` is recommended whenever confidence < 1.0, not required at a specific threshold
  - `EvidenceMapping` (bias_id: string, evidence: EvidenceEntry[], prompt_version: PromptVersion)
  - `ReasoningTrace` (story_analysis: StoryAnalysis, interpretations: InterpretationSchema[], bias_hypotheses: BiasHypothesis[], evidence_mapping: EvidenceMapping[], prompt_version: PromptVersion)
  - `EvidenceEntry` (source: "story" | "answer", excerpt: string, relevance: string)
  - `ClaimSchema` stub (claim: string, source: "story" | "answer") — reserved only, NOT in ReasoningTrace. Future pipeline: Story → Claims → Interpretations → Biases.
  - `ProviderComparisonSchema` stub (prompt_version: PromptVersion, results: Record<string, unknown>, disagreement_score?: number) — NOT populated in MVP, reserved for future provider divergence logging
  - `ContradictionSchema` stub (statement_a: string, statement_b: string, severity: "low" | "medium" | "high") — NOT populated in MVP, reserved for future contradiction detection
  - NOTE: `AssessmentResponse` is NOT defined here — it belongs in `reflection.schemas.ts` (T403)
  - NOTE: `prompt_version` is required on every step schema and on `ReasoningTrace` itself. At runtime, if `prompt_version` is missing from any step, the pipeline MUST throw (not warn, not default). This is enforced by Zod validation during parsing — `z.string().min(1)` ensures non-empty at runtime, and the branded type ensures type-level safety at compile time.

- [ ] T102 [P] Extend `src/contracts/reflection.schemas.ts`:
  - Import `EvidenceEntry` and `ReasoningTrace` from `reasoning.schemas.ts`
  - Add `evidence: EvidenceEntry[]` to `BiasItem`
  - Add `noBiasDetected: boolean` to `AssessmentOutput`
  - Add `reasoningTrace?: ReasoningTrace` optional field to `AssessmentOutput`

- [ ] T103 [P] Create `src/evaluation/evidence-grounded-rate.ts`:
  - `computeEvidenceGroundedRate(assessment, input)` — standalone pure function
  - Validates evidence excerpts against input text (verbatim substring matching)
  - Returns float 0.0–1.0 or `null` when bias list is empty
  - No side effects, no imports from production path

- [ ] T104 [P] Create `src/persistence/reasoning-trace.ts`:
  - Export `persistReasoningTrace(trace: ReasoningTrace): Promise<void>`
  - Default implementation: JSON file write to `./data/reasoning-traces/{session_id}/{trace_id}.json`
  - Feature-flagged upgrade: when `PERSIST_REASONING_TRACE=supabase`, insert into `reasoning_traces` table (schema in T404)
  - Wire call added in T204 (assessment service)
  - Reason: traces generated during development are evaluation material — file persistence costs nothing and starts corpus accumulation immediately

**Checkpoint**: All new Zod schemas defined and unit-testable. Persistence write path exists. Traces generated from this point forward are stored.

---

## Phase 2: Reasoning Pipeline — Orchestrator Upgrade

**Purpose**: Upgrade the assessment orchestrator to produce intermediate reasoning steps + evidence binding.

- [ ] T201 [P] Update `src/prompts/reflection/assessment/system.md`:
  - Update assessment prompt to emit structured reasoning steps: story analysis → interpretations → bias hypotheses → evidence mapping → final assessment
  - Include instructions for evidence binding (each bias claim must reference specific story/answer excerpts)

- [ ] T202 [P] Update `src/prompts/reflection/assessment/schema.md`:
  - Update output schema to include reasoning trace + evidence per bias
  - Document the `no_bias_detected` signal format

- [ ] T203 Upgrade `src/orchestrators/reflection/assessment.service.ts`:
  - Call provider once with output schema that includes reasoning trace
  - Parse trace + evidence from response
  - Validate each step with Zod schemas from `reasoning.schemas.ts`
  - Validate `prompt_version` is present on every step — throw if missing

- [ ] T204 Ensure `reasoning_trace` is always computed and persisted in `src/orchestrators/reflection/assessment.service.ts`:
  - Trace is generated on every assessment call (FR-003)
  - `includeReasoningTrace` query param controls response body only, not computation
  - Pass trace to persistence layer: call `persistReasoningTrace(trace)` from `src/persistence/reasoning-trace.ts` after trace is generated (T104 must exist before this runs)

- [ ] T205 Handle `no_bias_detected` signal in `src/orchestrators/reflection/assessment.service.ts`:
  - When LLM returns no biases, return empty bias array with `noBiasDetected: true` status flag
  - `computeEvidenceGroundedRate` returns `null` for empty bias lists (eval-only, not called here)

- [ ] T206 Wire evidence validation into `src/orchestrators/reflection/assessment.service.ts`:
  - Drop/flag bias items without valid evidence (FR-001)
  - Uses `validateEvidence()` from T301 (import from `src/parsers/evidence-validator.ts`)
  - If T301 is not yet implemented, leave a documented stub: `// TODO: wire evidence validation — blocked on T301 (evidence-validator.ts)`

**Checkpoint**: Assessment endpoint produces reasoning trace + evidence binding. Evidence validation wired (or stubbed with documented TODO).

---

## Phase 3: Evidence Validation + `no_bias` Dataset

**Purpose**: Build the adversarial testing infrastructure and evidence validation.

- [ ] T301 [P] Create `src/parsers/evidence-validator.ts`:
  - `validateEvidence(assessment, input)` — checks every excerpt exists verbatim in story or answers
  - Returns `{ valid: boolean, violations: Violation[] }`
  - `Violation` type: `{ biasName: string, excerpt: string, reason: string }`

- [ ] T302 [P] Create `evaluations/no_bias/`:
  - 10+ neutral stories — situations without cognitive bias triggers (e.g., routine errands, neutral observations)
  - Use the same JSON format as `evaluations/golden/reflection/` — inspect the golden set files first to determine the exact shape, then replicate it for no_bias stories with `expected_biases: []`

- [ ] T303 Extend `scripts/eval-reflection.ts`:
  - Run assessments against `no_bias` dataset
  - Compute false-positive rate (threshold: < 10% per SC-003, configurable via CLI flag `--no-bias-threshold`)
  - Report `evidence_grounded_rate` for each assessment

- [ ] T304 Add `computeEvidenceGroundedRate()` call to golden-set evaluation in `scripts/eval-reflection.ts`:
  - Compare against configurable threshold (SC-001: ≥ 0.9 CI gate, configurable via CLI flag `--grounded-rate-threshold`)
  - Import from `src/evaluation/evidence-grounded-rate.ts`

**Checkpoint**: `no_bias` dataset exists. Eval script runs both dimensions. Evidence validation rejects hallucinated excerpts.

---

## Phase 4: API + Persistence Upgrade

**Purpose**: Wire reasoning trace into the API response (opt-in) and upgrade persistence to Supabase.

- [ ] T401 Add `includeReasoningTrace` query param to `POST /v1/reflection/assessment` in `src/routes/reflection.ts`:
  - Controls response inclusion only (trace always computed per FR-003)
  - Default: `false` (backward-compatible)

- [ ] T402 Return `noBiasDetected` status in assessment response in `src/routes/reflection.ts`:
  - When assessment has `noBiasDetected: true`, include in response body

- [ ] T403 [P] Add `AssessmentResponse` type in `src/contracts/reflection.schemas.ts`:
  - Fields: `biases: BiasItem[]`, `reflectionPrompt: string`, `reasoningTrace?: ReasoningTrace`, `noBiasDetected?: boolean`
  - Import `ReasoningTrace` from `reasoning.schemas.ts`

- [ ] T404 Upgrade `src/persistence/reasoning-trace.ts` to Supabase write path:
  - Implement `PERSIST_REASONING_TRACE=supabase` branch
  - Add migration: `reasoning_traces (id uuid PK, session_id uuid FK, trace jsonb NOT NULL, prompt_version text NOT NULL, created_at timestamptz DEFAULT now())`
  - Wire into `src/server.ts` as plugin/hook
  - Both paths (file + supabase) testable via feature flag toggle
  - Depends on T104

**Checkpoint**: API returns reasoning trace on opt-in. Persistence path exists with both file and Supabase backends.

---

## Phase 5: Tests

**Purpose**: Unit + integration tests for all new functionality.

- [ ] T501 [P] Create `tests/unit/contracts/reasoning.schemas.test.ts`:
  - Zod validation for all intermediate reasoning schemas
  - Valid data passes, invalid data fails
  - `prompt_version` branded type enforcement
  - Verify that multiple bias items MAY reference the same excerpt, but each must include a distinct relevance explanation

- [ ] T502 [P] Create `tests/unit/parsers/evidence-validator.test.ts`:
  - Verbatim match success cases
  - Hallucination rejection (excerpt not in input)
  - Empty edge cases (no biases, empty excerpts)

- [ ] T503 [P] Create `tests/unit/orchestrators/evidence-grounded-rate.test.ts`:
  - `computeEvidenceGroundedRate` known cases (all grounded, partially grounded, none grounded)
  - Empty bias list → `null`

- [ ] T504 Extend `tests/integration/assessment.test.ts`:
  - Verify reasoning trace shape in response
  - Verify evidence binding on bias items
  - Verify `no_bias_detected` signal

- [ ] T505 [P] Create `tests/integration/evidence-pipeline.test.ts`:
  - Full pipeline with mocked provider
  - Trace generation, evidence validation, hallucination rejection

- [ ] T506 [P] Create `tests/unit/evaluations/no-bias.test.ts`:
  - Verify no_bias dataset loads and has correct format
  - Each file has expected structure

- [ ] T507 Add test case to `tests/integration/assessment.test.ts`:
  - Verify pipeline throws (not warns, not defaults) when `prompt_version` is missing from any reasoning trace step
  - Mock provider returns valid assessment JSON but omits `prompt_version` from `StoryAnalysis`
  - Assert that the orchestrator throws with a descriptive error message (FR-013 enforcement)

**Checkpoint**: All tests green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Schemas + persistence)**: No dependencies — pure Zod + file I/O, can start immediately
- **Phase 2 (Orchestrator upgrade)**: Depends on Phase 1 (schemas must exist before orchestrator can use them)
- **Phase 3 (Evidence validation + no_bias dataset)**: Depends on Phase 2 (orchestrator must produce evidence before it can be validated)
- **Phase 4 (API + persistence upgrade)**: Depends on Phase 2 (API needs reasoning trace from orchestrator)
- **Phase 5 (Tests)**: Depends on Phase 1–4 (tests need implemented code)

### Parallel Opportunities

- T102, T103, T104 (Phase 1) — can run in parallel with T101 once T101 is complete
- T201, T202 (Phase 2) — can run in parallel with T203–T206
- T301 (evidence validator) can start alongside Phase 2
- T302 (no_bias dataset creation) can start immediately — independent of code
- T403 (Phase 4) can run in parallel with T401, T402
- T501–T507 (Phase 5) can be written in parallel with implementation

### Execution Strategy

1. **Phase 1 first**: All schemas defined, persistence path exists, testable before any implementation
2. **Phase 2 + T301/T302 in parallel**: Orchestrator upgrade while evidence validator and no_bias dataset are built
3. **Phase 3**: Wire eval script with both dimensions
4. **Phase 4**: API changes and persistence upgrade to Supabase
5. **Phase 5**: Tests last, but individual test files can be written alongside their corresponding implementation
