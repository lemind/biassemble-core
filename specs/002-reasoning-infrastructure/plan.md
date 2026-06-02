# Implementation Plan: Reasoning Infrastructure for Auditable Assessment

**Branch**: `002-reasoning-infrastructure` | **Date**: 2026-06-02 | **Spec**: [spec.md](spec.md)

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

**All requirements are P0** — evidence binding, intermediate schemas, evidence_grounded_rate, and no_bias datasets are equally critical for auditable reasoning.

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

- **Intermediate reasoning schemas** — new Zod types for reasoning steps (`StoryAnalysis`, `InterpretationSchema`, `BiasHypothesis`, `EvidenceMapping`, `ReasoningTrace`)
- **Evidence binding** — `evidence` array on each bias item (`source`, `excerpt`, `relevance`)
- **`reasoning_trace`** — always computed and persisted; opt-in response inclusion
- **`computeEvidenceGroundedRate()`** — post-hoc evaluation metric
- **`no_bias` dataset** — 10+ neutral stories in `evaluations/no_bias/`
- **`no_bias_detected` response signal** — empty bias array with status flag
- **Evidence validation** — verbatim excerpt matching, rejection of hallucinated quotes
- **Extended eval script** — runs both golden-set recall and no_bias precision
- **Interpretation layer** — `InterpretationSchema` between story analysis and bias hypotheses; biases are proposed against ranked interpretations, not raw story text. Stored as `interpretations: InterpretationSchema[]` inside `ReasoningTrace`.
- **Schema stubs** — `ProviderComparisonSchema`, `ContradictionSchema`, `ClaimSchema` reserved in `reasoning.schemas.ts` for future use. `ClaimSchema` is NOT included in `ReasoningTrace`.

---

## Technical Context

**Language/Version**: TypeScript 5.x strict (same as `001-reflection-core`)

**Existing Dependencies**: Fastify 5, Zod 4, `@google/generative-ai`, pino, vitest

**New Dependencies**: None — all additions use existing stack

**Testing**: Vitest — unit (schemas, evidence validator, evidence_grounded_rate), integration (full pipeline with mocked provider)

**Target Platform**: Same as `001-reflection-core` — Vercel Functions (Fastify entry `src/server.ts`)

**Performance Goals**: Reasoning trace adds < 500ms to assessment latency (single LLM call with structured output, not multi-turn). `evidence_grounded_rate` computed post-hoc in eval scripts, not in production path.

---

## Design Decisions

### Single LLM call with structured output (not multi-turn chain)

The assessment prompt emits a single JSON that includes both the reasoning trace and the final assessment. This avoids latency amplification and keeps the pipeline simple. The LLM produces:

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

### Evidence validation is post-hoc

`computeEvidenceGroundedRate` runs in evaluation scripts, not in the production API path. The production path trusts the LLM output (with repair pipeline as safety net). Evidence validation in the production path drops/flags bias items without valid evidence (FR-001).

### Reasoning trace always computed

`includeReasoningTrace` controls response body only. The trace is always generated and persisted internally (FR-003).

### Persistence path exists from day one

File-based persistence in Phase 1 (`./data/reasoning-traces/`), upgraded to Supabase Postgres under `PERSIST_REASONING_TRACE` feature flag. Without persistence, eval on historical outputs is impossible. JSON file persistence works locally; production deployment on Vercel uses Supabase (serverless filesystem is ephemeral).

### Interpretation layer precedes bias hypotheses

Before the pipeline proposes bias candidates, it generates ranked interpretations of what happened in the story. Bias labels are then applied to the most plausible interpretations, not directly to raw story text. This prevents the common failure mode where the system labels a bias before considering alternative explanations. An interpretation with plausibility < 0.3 should not generate high-confidence bias detections. Interpretations are stored as `interpretations: InterpretationSchema[]` inside `ReasoningTrace`.

### `no_bias` dataset is manually curated

Same format as golden set. Automated generation deferred.

### Backward-compatible

Existing assessment endpoint remains the primary API. Evidence binding and reasoning trace are additive. Existing clients that don't request `reasoningTrace` get the same response shape (plus `evidence` array on bias items).

---

## Implementation Phases

### Phase 1: Intermediate Reasoning Schemas + Evidence Contracts + Persistence

**Purpose**: Define the typed reasoning pipeline. Every assessment produces structured intermediate steps, not just a flat bias list. Persistence write path exists from day one.

| Task | File(s) | Description |
|------|---------|-------------|
| T101 | `src/contracts/reasoning.schemas.ts` | NEW — Zod schemas (all in one pass): `PromptVersionSchema` (branded type), `StoryAnalysis` (themes, emotional_tone, key_events, prompt_version), `InterpretationSchema` (interpretation, plausibility 0–1, supporting_evidence, rejected?: boolean), `BiasHypothesis` (bias_name, confidence, supporting_excerpts, uncertainty_reasons: string[] — recommended when confidence < 1.0, prompt_version), `EvidenceMapping` (bias_id → evidence[], prompt_version), `ReasoningTrace` (story_analysis, interpretations, bias_hypotheses, evidence_mapping, prompt_version), `EvidenceEntry` (source: "story"|"answer", excerpt, relevance), `ClaimSchema` stub (claim, source — reserved only, NOT in ReasoningTrace), `ProviderComparisonSchema` stub (prompt_version, results, disagreement_score?), `ContradictionSchema` stub (statement_a, statement_b, severity). NOTE: `AssessmentResponse` is NOT defined here — it belongs in `reflection.schemas.ts` (T403). |
| T102 | `src/contracts/reflection.schemas.ts` | Extend `BiasItem` with `evidence: EvidenceEntry[]` (imported from reasoning.schemas.ts). Add `noBiasDetected: boolean` to `AssessmentOutput`. Add `reasoningTrace?: ReasoningTrace` optional field. |
| T103 | `src/evaluation/evidence-grounded-rate.ts` | NEW — `computeEvidenceGroundedRate(assessment, input)` — standalone function that validates evidence excerpts against input text (verbatim substring matching). Returns float 0.0–1.0 or `null` when bias list is empty. Pure function, no side effects, no imports from production path. |
| T104 | `src/persistence/reasoning-trace.ts` | NEW — persistence write path for reasoning traces. Export `persistReasoningTrace(trace: ReasoningTrace): Promise<void>`. Default implementation: JSON file write to `./data/reasoning-traces/{session_id}/{trace_id}.json`. Feature-flagged upgrade: when `PERSIST_REASONING_TRACE=supabase`, insert into `reasoning_traces` table (schema in T404). Wire call added in T204 (assessment service). Reason: traces generated during development are evaluation material — file persistence costs nothing and starts corpus accumulation immediately. |

**Checkpoint**: All new Zod schemas defined and unit-testable. Persistence write path exists. Traces generated from this point forward are stored.

---

### Phase 2: Reasoning Pipeline — Orchestrator Upgrade

**Purpose**: Upgrade the assessment orchestrator to produce intermediate reasoning steps + evidence binding.

| Task | File(s) | Description |
|------|---------|-------------|
| T201 | `src/prompts/reflection/assessment/system.md` | Update assessment prompt to emit structured reasoning steps (story analysis → interpretations → bias hypotheses → evidence mapping → final assessment) |
| T202 | `src/prompts/reflection/assessment/schema.md` | Update output schema to include reasoning trace + evidence per bias |
| T203 | `src/orchestrators/reflection/assessment.service.ts` | Upgrade to structured pipeline: call provider once with output schema that includes reasoning trace; parse trace + evidence from response; validate each step with Zod |
| T204 | `src/orchestrators/reflection/assessment.service.ts` | Ensure `reasoning_trace` is always computed and persisted (even if not returned in response) — FR-003. Call `persistReasoningTrace(trace)` from `src/persistence/reasoning-trace.ts` after trace is generated (T104 must exist before this runs). |
| T205 | `src/orchestrators/reflection/assessment.service.ts` | Handle `no_bias_detected` signal — return empty bias array with `noBiasDetected: true` status flag |
| T206 | `src/orchestrators/reflection/assessment.service.ts` | Wire evidence validation into assessment pipeline — drop/flag bias items without valid evidence (FR-001). Uses `validateEvidence()` from T301 (import from `src/parsers/evidence-validator.ts`). If T301 is not yet implemented, leave a documented stub: `// TODO: wire evidence validation — blocked on T301 (evidence-validator.ts)` |

**Checkpoint**: Assessment endpoint produces reasoning trace + evidence binding. Evidence validation wired (or stubbed with documented TODO).

---

### Phase 3: Evidence Validation + `no_bias` Dataset

**Purpose**: Build the adversarial testing infrastructure and evidence validation.

| Task | File(s) | Description |
|------|---------|-------------|
| T301 | `src/parsers/evidence-validator.ts` | NEW — `validateEvidence(assessment, input)` — checks every excerpt exists verbatim in story or answers. Returns `{ valid: boolean, violations: Violation[] }` |
| T302 | `evaluations/no_bias/` | Create 10+ neutral stories (same format as golden set) — situations without cognitive bias triggers |
| T303 | `scripts/eval-reflection.ts` | Extend to run assessments against `no_bias` dataset, compute false-positive rate (threshold: < 10% per SC-003, configurable via CLI flag `--no-bias-threshold`), report `evidence_grounded_rate` |
| T304 | `scripts/eval-reflection.ts` | Add `computeEvidenceGroundedRate()` call to golden-set evaluation, compare against configurable threshold (SC-001: ≥ 0.9 CI gate, configurable via CLI flag `--grounded-rate-threshold`) |

**Checkpoint**: `no_bias` dataset exists. Eval script runs both dimensions. Evidence validation rejects hallucinated excerpts.

---

### Phase 4: API + Persistence Upgrade

**Purpose**: Wire reasoning trace into the API response (opt-in) and upgrade persistence to Supabase.

| Task | File(s) | Description |
|------|---------|-------------|
| T401 | `src/routes/reflection.ts` | Add `includeReasoningTrace` query param to `POST /v1/reflection/assessment` — controls response inclusion only (trace always computed) |
| T402 | `src/routes/reflection.ts` | Return `noBiasDetected` status in assessment response when applicable |
| T403 | `src/contracts/reflection.schemas.ts` | Add `AssessmentResponse` type with optional `reasoningTrace` and `noBiasDetected` fields |
| T404 | `src/persistence/reasoning-trace.ts` | Upgrade to Supabase write path — implement the `PERSIST_REASONING_TRACE=supabase` branch. Add migration: `reasoning_traces (id uuid PK, session_id uuid FK, trace jsonb NOT NULL, prompt_version text NOT NULL, created_at timestamptz DEFAULT now())`. Wire into `src/server.ts` as plugin/hook. Both paths (file + supabase) testable via feature flag toggle. Depends on T104. |

**Checkpoint**: API returns reasoning trace on opt-in. Persistence path exists with both file and Supabase backends.

---

### Phase 5: Tests

**Purpose**: Unit + integration tests for all new functionality.

| Task | File(s) | Description |
|------|---------|-------------|
| T501 | `tests/unit/contracts/reasoning.schemas.test.ts` | NEW — Zod validation for all intermediate reasoning schemas. Verify that multiple bias items MAY reference the same excerpt, but each must include a distinct relevance explanation. |
| T502 | `tests/unit/parsers/evidence-validator.test.ts` | NEW — evidence validation: verbatim match, hallucination rejection, empty edge cases |
| T503 | `tests/unit/orchestrators/evidence-grounded-rate.test.ts` | NEW — `computeEvidenceGroundedRate` unit tests (known cases, empty bias list → null) |
| T504 | `tests/integration/assessment.test.ts` | Extend — verify reasoning trace shape, evidence binding, `no_bias_detected` signal |
| T505 | `tests/integration/evidence-pipeline.test.ts` | NEW — full pipeline with mocked provider: trace generation, evidence validation, hallucination rejection |
| T506 | `tests/unit/evaluations/no-bias.test.ts` | NEW — verify no_bias dataset loads and has correct format |
| T507 | `tests/integration/assessment.test.ts` | NEW test case: verify pipeline throws (not warns, not defaults) when `prompt_version` is missing from any reasoning trace step. Mock provider returns valid assessment JSON but omits `prompt_version` from `StoryAnalysis`. Assert that the orchestrator throws with a descriptive error message. (FR-013 enforcement) |

**Checkpoint**: All tests green.

---

## Execution Order

### Dependency Chain (linear)

1. **Phase 1** (Schemas + persistence) — no dependencies, pure Zod + file I/O
2. **Phase 2** (Orchestrator upgrade) — depends on Phase 1
3. **Phase 3** (Evidence validation + no_bias dataset) — depends on Phase 2
4. **Phase 4** (API + persistence upgrade) — depends on Phase 2
5. **Phase 5** (Tests) — depends on Phase 1–4

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

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| LLM produces hallucinated evidence excerpts | Evidence validator rejects non-verbatim excerpts; pipeline drops/flags invalid bias items |
| Reasoning trace makes response too large | Trace always persisted; response inclusion is opt-in; pagination/truncation for large traces |
| `no_bias` dataset too small to catch false positives | Start with 10 stories; expand as evaluation reveals gaps |
| Multi-step reasoning degrades assessment quality | Single LLM call with structured output (not multi-turn); quality measured by `evidence_grounded_rate` |
| Persistence adds complexity to MVP | File-based persistence in Phase 1 (zero infra); Supabase upgrade in Phase 4 |

---

## Phase Mapping

| Phase | Outcome |
|-------|---------|
| 1 | All new Zod schemas defined and testable. Persistence write path exists. Traces stored from day one. |
| 2 | Assessment endpoint produces reasoning trace + evidence binding |
| 3 | Evidence validation + no_bias dataset + extended eval script |
| 4 | API returns trace on opt-in; persistence upgraded to Supabase |
| 5 | All tests green |

---

## Constitution Check

*GATE: Pass*

| Principle | Plan compliance |
|-----------|-----------------|
| I Proprietary isolation | All additions in `biassemble-core` (private); no prompts/keys in public repo |
| II Contract-first | Zod schemas for all new types; backward-compatible with existing contracts |
| III Evaluation-first | `no_bias` dataset + extended eval script before production deployment |
| IV Modular simplicity | Single LLM call with structured output (not multi-turn chain); evidence validation is post-hoc |
| V Structured outputs | JSON + Zod + repair pipeline for reasoning trace + evidence |
| VI Non-clinical | Existing `guardrails.md` applies to all new prompts |

No complexity tracking violations.

---

**Next command**: `/speckit-tasks` to generate `tasks.md` with file-level checkpoints.
