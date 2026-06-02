# Feature Specification: Reasoning Infrastructure for Auditable Assessment

**Feature Branch**: `002-reasoning-infrastructure`

**Created**: 2026-06-02

**Status**: Draft

**Input**: User description: "Structured intermediate schemas, evidence binding, evidence_grounded_rate metric, and no_bias adversarial datasets for auditable reasoning"

**Depends on**: `001-reflection-core` (flat assessment pipeline MVP)

**All requirements are P0** — evidence binding, intermediate schemas, evidence_grounded_rate, and no_bias datasets are equally critical for auditable reasoning.

## Overview

This feature upgrades the flat assessment pipeline from `001-reflection-core` into a **structured reasoning engine** with auditable intermediate representations. Instead of a single LLM call from story→biases, the pipeline produces explicit reasoning artifacts (intermediate schemas, evidence traces) that can be inspected, scored, and adversarially tested.

Four concepts form the architecture:

1. **Structured intermediate schemas** — typed reasoning steps between story input and bias output
2. **Evidence binding** — each bias claim is traceable to specific story/answer excerpts
3. **`evidence_grounded_rate` metric** — quantitative measure of how tightly bias output is anchored to user input
4. **`no_bias` adversarial datasets** — stories that intentionally lack bias triggers, to test false-positive resistance

## User Scenarios & Testing

### User Story 1 — Auditable bias assessment with evidence traces (Priority: P0)

A developer or product reviewer inspects a bias assessment and can see exactly which parts of the user's story and answers drove each bias conclusion.

**Why this priority**: Without evidence binding, bias assessments are opaque LLM outputs. Evidence traces are the foundation for trust, debugging, and quality improvement.

**Independent Test**: Given a story and Q&A, the assessment response includes for each bias item a set of `evidence` references (story excerpts and/or answer excerpts) that support the bias classification. A reviewer can verify each reference exists verbatim in the input.

**Acceptance Scenarios**:

1. **Given** a story and Q&A, **When** assessment is generated, **Then** each bias item includes at least one evidence reference pointing to a verbatim excerpt from the input
2. **Given** a bias claim about "confirmation bias", **When** the evidence is inspected, **Then** the referenced excerpt(s) logically support the bias classification
3. **Given** an assessment where multiple biases reference the same story excerpt, **When** the assessment is inspected, **Then** each bias item includes a relevance explanation describing why that excerpt supports that specific bias conclusion.
4. **Given** an assessment response, **When** evidence references are validated against the original input, **Then** 100% of references match verbatim (no hallucinated quotes)

---

### User Story 2 — Intermediate reasoning schema inspection (Priority: P0)

A developer debugs a surprising bias assessment by inspecting the intermediate reasoning steps the pipeline produced before arriving at the final output.

**Why this priority**: Intermediate schemas make the pipeline's "thinking" visible. Without them, the pipeline is a black box — you see input and output but cannot diagnose where reasoning went wrong.

**Independent Test**: The assessment endpoint returns an optional `reasoning_trace` field containing structured intermediate steps (e.g., story analysis, interpretations, bias hypotheses, evidence mapping). Each step has a typed schema that can be validated independently.

**Acceptance Scenarios**:

1. **Given** a valid assessment request, **When** the response includes `reasoning_trace`, **Then** each step conforms to its typed schema (validated by Zod)
2. **Given** a reasoning trace, **When** inspected, **Then** the sequence of steps forms a logical chain from input to bias conclusions
3. **Given** a reasoning trace with `story_analysis` step, **When** validated, **Then** it contains structured fields (e.g., `themes`, `emotional_tone`, `key_events`) rather than free-form text
4. **Given** a reasoning trace, **When** the final bias output is compared to intermediate steps, **Then** each bias in the output can be traced back to a hypothesis in the intermediate steps

---

### User Story 3 — `evidence_grounded_rate` quality gate (Priority: P0)

A CI pipeline or quality dashboard measures the `evidence_grounded_rate` of assessment outputs and fails builds or flags regressions when the metric drops below a threshold.

**Why this priority**: Without a quantitative metric, "quality" is subjective. `evidence_grounded_rate` provides an objective, measurable standard for assessment quality that can be tracked over time and compared across model versions.

**Independent Test**: Given a golden dataset of stories with expected assessments, the evaluation script computes `evidence_grounded_rate` as the percentage of bias items whose evidence references are grounded in the input. The metric is reported as a single float between 0.0 and 1.0.

**Acceptance Scenarios**:

1. **Given** a golden dataset with known grounded assessments, **When** `evidence_grounded_rate` is computed, **Then** the metric reflects the proportion of evidence-grounded bias items
2. **Given** an assessment with all evidence references matching verbatim input, **When** scored, **Then** `evidence_grounded_rate` equals 1.0
3. **Given** an assessment with hallucinated evidence, **When** scored, **Then** `evidence_grounded_rate` is < 1.0 and the hallucinated items are identifiable
4. **Given** a CI pipeline with a threshold of 0.9, **When** a model version scores 0.85, **Then** the pipeline fails and reports the regression

---

### User Story 4 — `no_bias` adversarial dataset for false-positive testing (Priority: P0)

A developer runs the assessment pipeline against a `no_bias` dataset — stories that describe neutral situations without cognitive bias triggers — and verifies the pipeline does not fabricate biases where none exist.

**Why this priority**: The pipeline must know when to say "no bias found." Without adversarial testing, the pipeline may over-detect biases in neutral stories, eroding user trust.

**Independent Test**: Given a `no_bias` dataset of 10+ neutral stories, the assessment pipeline returns either zero biases or a special `no_bias_detected` signal. The `evidence_grounded_rate` metric is computed and must be N/A (no bias items to ground) or 1.0 if biases are returned.

**Acceptance Scenarios**:

1. **Given** a neutral story from the `no_bias` dataset, **When** assessment is requested, **Then** the pipeline may return zero biases or a `no_bias_detected` status
2. **Given** a `no_bias` story where the pipeline incorrectly returns biases, **When** evidence is inspected, **Then** the evidence is weak or hallucinated (low `evidence_grounded_rate`)
3. **Given** the full `no_bias` dataset, **When** evaluated, **Then** the false-positive rate (assessments returning biases for neutral stories) is below a defined threshold (e.g., < 10%, roadmap target < 5%)
4. **Given** a `no_bias` dataset entry, **When** the pipeline returns biases, **Then** each returned bias includes evidence binding (same contract as normal assessments)

---

### Edge Cases

- What happens when evidence binding cannot find verbatim excerpts? — The pipeline should return a reduced-confidence signal or omit the bias rather than hallucinate quotes
- How does the pipeline handle stories where bias is genuinely ambiguous? — Intermediate schemas should capture uncertainty (e.g., `confidence` field on bias hypotheses, `uncertainty_reasons` when confidence < 1.0)
- What happens when `evidence_grounded_rate` is computed on an empty bias list? — The metric should be `null` or `N/A` (not 0.0, which would imply all biases were ungrounded)
- How does the `no_bias` dataset interact with the existing golden evaluation set? — `no_bias` is a separate evaluation dimension; golden set measures recall (finding real biases), `no_bias` measures precision (not fabricating)
- What happens when intermediate reasoning trace is too large for the response? — The trace is always computed and persisted internally; the response body inclusion is controlled by an opt-in request flag. For large traces, pagination or truncation may be used in the response.

## Requirements

### Functional Requirements

- **FR-001**: Assessment response MUST include a non-empty `evidence` array on each bias item, where each evidence entry contains a `source` (story/answer), `excerpt` (verbatim text), and `relevance` (brief explanation). A bias item without evidence is invalid and MUST be dropped or flagged rather than returned.
- **FR-002**: Evidence excerpts MUST match verbatim text from the input story or answers (no paraphrasing, no hallucinated quotes)
- **FR-003**: The reasoning pipeline MUST compute and persist a `reasoning_trace` on every assessment, regardless of client request parameters. The assessment response MAY include the trace in the HTTP response body (controlled by an opt-in request flag), but the trace MUST always be generated and stored internally.
- **FR-004**: Each intermediate step in `reasoning_trace` MUST conform to a defined Zod schema (e.g., `StoryAnalysis`, `InterpretationSchema`, `BiasHypothesis`, `EvidenceMapping`)
- **FR-005**: The system MUST provide a `computeEvidenceGroundedRate(assessment)` function that returns a float 0.0–1.0 representing the proportion of bias items with verbatim evidence binding
- **FR-006**: The evaluation script MUST support computing `evidence_grounded_rate` across a dataset and comparing against a configurable threshold
- **FR-007**: The system MUST include a `no_bias` dataset of at least 10 stories describing neutral situations without cognitive bias triggers
- **FR-008**: The evaluation script MUST support running assessments against the `no_bias` dataset and reporting false-positive rate
- **FR-009**: The assessment pipeline MUST support a `no_bias_detected` response signal (either empty bias array with a status flag, or a dedicated response variant)
- **FR-010**: Evidence validation MUST reject any excerpt that does not appear verbatim in the original input
- **FR-011**: The `evidence_grounded_rate` metric MUST return `null` when the bias list is empty (no bias items to evaluate)
- **FR-012**: The `no_bias` dataset MUST be stored in `evaluations/no_bias/` with the same format as the golden dataset
- **FR-013**: Every assessment response, reasoning trace step, and evaluation result MUST include a `prompt_version` string identifying the exact prompt template version used to generate the output. Without `prompt_version`, eval results are unattributable across prompt iterations.

### Key Entities

- **Intermediate Reasoning Schema**: Typed data structure for each step in the reasoning pipeline (e.g., `StoryAnalysis`, `InterpretationSchema`, `BiasHypothesis`, `EvidenceMapping`, `FinalAssessment`)
- **Evidence Binding**: A reference from a bias item to a specific excerpt in the input, with source indicator and relevance explanation
- **`evidence_grounded_rate`**: Float metric (0.0–1.0) measuring the proportion of bias items with verbatim evidence binding; `null` when no biases exist. Future metric: `hypothesis_supported_rate` — measures whether evidence actually supports the conclusion, not just that a quote exists. Requires human labeling or second-pass LLM evaluation. Deferred post-MVP.
- **`no_bias` Dataset**: Collection of neutral stories that should not trigger bias detection, used for adversarial false-positive testing
- **Reasoning Trace**: Ordered sequence of intermediate schemas produced during assessment, optionally included in the response. Contains `story_analysis`, `interpretations`, `bias_hypotheses`, `evidence_mapping`, and `prompt_version`.
- **Interpretation**: A candidate explanation for the story events, ranked by plausibility before bias hypotheses are formed. Fields: `interpretation: string`, `plausibility: number (0–1)`, `supporting_evidence: string[]`, `rejected?: boolean`. The interpretation layer sits between story analysis and bias hypotheses — biases are only proposed for interpretations with sufficient plausibility support. Stored as `interpretations: InterpretationSchema[]` inside `ReasoningTrace`.
- **Claim**: A discrete factual statement extracted from the story. Fields: `claim: string`, `source: "story" | "answer"`. Claims sit between story analysis and interpretations — they decompose the story into atomic statements that interpretations explain. Reserved schema only — not populated in MVP, not included in ReasoningTrace.
- **BiasHypothesis** includes `uncertainty_reasons: string[]` — human-readable explanations for why confidence is below 1.0 (e.g., "limited observations", "alternative explanations exist"). Recommended whenever confidence < 1.0.
- **ProviderComparisonSchema**: Reserved schema for future provider divergence logging. Fields: `prompt_version: PromptVersion`, `results: Record<string, unknown>`, `disagreement_score?: number`. Not populated in MVP.
- **ContradictionSchema**: Reserved schema for future contradiction detection. Fields: `statement_a: string`, `statement_b: string`, `severity: "low" | "medium" | "high"`. Not populated in MVP.

## Success Criteria

### Measurable Outcomes

- **SC-001**: `evidence_grounded_rate` ≥ 0.9 on the golden evaluation set (CI gate); 1.0 tracked as aspirational trend over time
- **SC-002**: (covered by SC-001 — merged)
- **SC-003**: False-positive rate on `no_bias` dataset < 10% for production model versions (roadmap target: < 5%)
- **SC-004**: All intermediate reasoning schemas pass Zod validation in unit tests
- **SC-005**: Evidence validation rejects hallucinated excerpts with 100% accuracy in unit tests
- **SC-006**: `computeEvidenceGroundedRate` returns correct values for known test cases (unit tested)
- **SC-007**: `no_bias` dataset contains at least 10 stories covering diverse neutral scenarios
- **SC-008**: Evaluation script can run both golden-set recall and `no_bias` precision in a single CI pass

## Assumptions

- The existing `001-reflection-core` assessment endpoint remains the primary API; reasoning trace and evidence binding are additive (backward-compatible)
- Evidence binding uses simple verbatim substring matching for MVP; semantic matching may be added later
- Intermediate reasoning schemas are designed for persistence from day one. The persistence write path MUST exist from Phase 1 — initially as JSON file writes to `./data/reasoning-traces/` — and upgraded to Supabase Postgres under the `PERSIST_REASONING_TRACE` feature flag. Deferring persistence to Phase 4 means traces generated during development, testing, and prompt iteration are permanently lost. Every trace is potential evaluation and training material. Note: JSON file persistence works locally; production deployment on Vercel uses Supabase (serverless filesystem is ephemeral).
- The `no_bias` dataset is curated manually for initial version; automated generation may be added later
- `evidence_grounded_rate` is computed post-hoc in evaluation scripts, not in the production API path
- The golden evaluation set from `001-reflection-core` is extended with evidence annotations rather than replaced
- Reasoning trace is always computed and persisted internally on every assessment. The `includeReasoningTrace` request parameter controls only whether the trace is returned in the HTTP response body, not whether it is generated or stored.
- `ProviderComparisonSchema` and `ContradictionSchema` are reserved in `reasoning.schemas.ts` from Phase 1 as forward-compatible schema stubs. Neither is populated in the MVP pipeline. Their presence ensures future provider divergence logging and contradiction detection can be added without a breaking schema change.
- `ClaimSchema` is reserved in `reasoning.schemas.ts` from Phase 1 as a forward-compatible schema stub. Not populated in MVP, not included in ReasoningTrace. Future pipeline: Story → Claims → Interpretations → Biases.
