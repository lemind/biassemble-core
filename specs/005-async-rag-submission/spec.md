# Feature Specification: Async RAG — Fire at Story Submission

**Feature Branch**: `005-async-rag-submission`

**Created**: 2026-07-09

**Status**: Draft

**ADR**: `docs/decisions/015-async-rag-fire-at-submission.md`

---

## User Scenarios & Testing

### User Story 1 — Questions appear immediately after story submission (Priority: P1)

As a **Biassemble user**, I submit a story and expect to see clarifying questions immediately — I should not wait more than a few seconds before the questions appear, regardless of how long the bias analysis takes in the background.

**Why this priority**: The current flow blocks question generation on bias retrieval. On the deployed service, retrieval takes ~76s. A user waiting 76s after submission sees a broken product. Fixing this is the primary deliverable of this feature.

**Independent Test**: Submit a story. Time until questions appear. Must be under 5s. Retrieval running or not running in the background is invisible to the user.

**Acceptance Scenarios**:

1. **Given** a story is submitted, **When** the server processes it, **Then** clarifying questions are returned within 5 seconds, with no dependency on whether bias retrieval has completed.
2. **Given** bias retrieval is slow or unavailable, **When** a story is submitted, **Then** questions still appear within 5 seconds — the user sees no error and no delay.
3. **Given** bias retrieval is running in the background, **When** the user starts reading and answering questions, **Then** retrieval continues silently with no user-visible activity.

---

### User Story 2 — Assessment uses enriched context when retrieval finished during think time (Priority: P2)

As a **Biassemble user**, when I finish answering questions and request my bias assessment, the system should use the most context it has available — including the bias retrieval results that completed while I was reading and answering — without making me wait for it.

**Why this priority**: The value proposition of bias retrieval is richer, story-specific evidence in the assessment. If retrieval completes during the human think window (the common case), the assessment should use it. If it did not complete, the assessment should proceed with LLM-only context — silently, with no user-visible difference.

**Independent Test**: Submit a story; wait 90 seconds (retrieval should be done); submit answers; verify the assessment response contains bias evidence and indicators from the retrieved documents, not just the flat roster.

**Acceptance Scenarios**:

1. **Given** retrieval completed before the user submitted answers, **When** assessment is requested, **Then** the assessment uses retrieved bias documents as enriched context (story-specific evidence for detected biases).
2. **Given** retrieval did not complete before answers were submitted, **When** assessment is requested, **Then** the assessment proceeds using LLM-only context — same quality as pre-retrieval baseline, no error shown to the user.
3. **Given** retrieval failed (network error, service down), **When** assessment is requested, **Then** the assessment still completes — users see no mention of retrieval failure.

---

### User Story 3 — Race outcome is recorded for analytics (Priority: P3)

As a **Biassemble developer**, I want to know, for each assessment, whether retrieval was available in time and how long the system waited for it, so that I can validate latency assumptions and decide if further optimization (GPU, caching) is warranted.

**Why this priority**: All latency figures driving D015 are estimates from a single measurement session. Without per-session telemetry, the "~20% miss rate" estimate cannot be validated, and future optimization decisions are unsupported.

**Independent Test**: Submit a story; wait 90 seconds; submit answers; check server logs — verify `rag_available: true/false` and `rag_wait_ms: <number>` are present on the assessment log line.

**Acceptance Scenarios**:

1. **Given** retrieval was READY when assessment started, **When** assessment completes, **Then** `rag_available: true` and `rag_wait_ms: 0` are logged on the assessment event.
2. **Given** retrieval was still running when assessment started but completed within 2s, **When** assessment completes, **Then** `rag_available: true` and `rag_wait_ms: <elapsed wait>` are logged.
3. **Given** retrieval was not ready and the adaptive wait expired, **When** assessment completes, **Then** `rag_available: false` and `rag_wait_ms: <wait attempted>` are logged.

---

### Edge Cases

- What happens when a user answers questions faster than ~76s (before retrieval finishes)? Assessment proceeds without retrieval — same as pre-feature behavior.
- What happens when the bias retrieval service is completely down? Session still works; retrieval status goes to FAILED; assessment uses LLM-only context.
- What happens when a user has multiple concurrent sessions? Each session has its own independent retrieval task and status.
- What if retrieval returns a roster fallback (all scores = 0.0)? Treated as LLM-only context; not injected into the bias workspace as retrieved evidence.

---

## Requirements

### Functional Requirements

- **FR-001**: Story submission MUST trigger bias retrieval non-blocking — the caller receives questions without waiting for retrieval to complete.
- **FR-002**: Bias retrieval MUST run as a background task starting at story submission time, concurrent with question generation.
- **FR-003**: Each session MUST track a retrieval status (`RUNNING`, `READY`, `FAILED`, `TIMEOUT`) throughout the session lifecycle.
- **FR-004**: At assessment time, the system MUST check retrieval status and apply an adaptive wait: if status is READY, use result immediately; if RUNNING, wait up to a short ceiling; if FAILED or TIMEOUT, proceed without it.
- **FR-005**: The bias workspace MUST merge retrieved bias candidates into a structured candidate list before passing context to the assessment model. The assessment model MUST NOT receive source attribution ("this came from RAG") — it receives only the merged candidate list with confidence and evidence. **Note**: merging LLM initial candidates (from the story_only assessment) into the workspace requires persisting them to the DB — this is deferred to a follow-on spec. In this spec the workspace contains RAG candidates only; the assessment LLM remains free to detect biases beyond the workspace candidates.
- **FR-006**: When retrieval was available, retrieved bias candidates MUST use the retrieval confidence score as the canonical ranking signal. LLM initial estimates and retrieval confidence scores MUST NOT be mixed on the same scale.
- **FR-007**: The assessment MUST complete successfully regardless of retrieval status — READY, FAILED, or TIMEOUT all result in a completed assessment for the user.
- **FR-008**: Each assessment MUST log whether retrieval was available at assessment time and how long the system waited for it.
- **FR-009**: Per-bias source attribution (`retrieved`, `llm`, `both`) MUST be recorded in the assessment output for analytics purposes, derived in service code, not by the assessment model.

### Non-Functional Requirements

- **NFR-001**: Questions must appear within 5 seconds of story submission (retrieval running in background does not count toward this budget).
- **NFR-002**: The adaptive wait at assessment time MUST NOT exceed 2 seconds, regardless of retrieval status.
- **NFR-003**: Retrieval failures MUST be invisible to end users — no error messages, no degraded UX, no change in response shape.
- **NFR-004**: The bias retrieval service API (external) is unchanged — this feature adds no new endpoints or protocol changes to the retrieval service.

### Key Entities

- **Session**: A user's bias assessment session. Now carries `rag_status` and `rag_result` alongside existing fields.
- **Retrieval status**: Lifecycle state of the background retrieval task for a session — RUNNING, READY, FAILED, TIMEOUT.
- **Bias workspace**: Unified structure of candidate biases with confidence and evidence, built from retrieval results and LLM initial candidates. Input to the assessment model.
- **Race outcome**: Per-assessment log record of whether retrieval was available in time (`rag_available`) and how long the system waited (`rag_wait_ms`).

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Story submission returns clarifying questions in under 5 seconds — measured from HTTP request to HTTP response, for 95% of submissions.
- **SC-002**: Assessment quality is unchanged when retrieval is unavailable — the LLM-only fallback produces assessments indistinguishable in structure and completeness from the pre-retrieval baseline.
- **SC-003**: When retrieval completes before assessment is requested (the common case), the assessment response includes bias-specific evidence drawn from retrieved documents, not just the flat roster names.
- **SC-004**: Every completed assessment logs `rag_available` and `rag_wait_ms` — zero assessments without these fields in production logs.
- **SC-005**: No user-visible errors caused by retrieval failure in any test scenario — 100% of sessions complete their assessment regardless of retrieval outcome.

---

## Assumptions

- The bias retrieval service is deployed and stable at its current endpoint — this feature does not change the service.
- Human question-answering time is typically 30–120 seconds — this is the free latency window that retrieval runs within. Sessions where users answer in under ~76s will receive LLM-only assessments; this is acceptable and expected.
- Retrieval latency (~76s on the deployed CPU-based service) is the current baseline. Optimization of the retrieval service itself (GPU, model quantization) is out of scope for this feature.
- The retrieval timeout budget (120s) is already configured in the environment.
- Existing session infrastructure (the `runs` table) is sufficient to store retrieval status and result without schema additions beyond the `rag_result` column already planned in spec-004.

---

## Implementation Notes (post-implementation deviation)

- **Adaptive wait removed.** FR-004, NFR-002, US3 acceptance scenarios 2–3, and SC-004's `rag_wait_ms` all describe a ≤2s adaptive-wait poll at assessment time. This was implemented exactly as specified, then deliberately removed: the poll's 70s trigger threshold was derived from a single latency measurement on one deployment (HF Space cpu-basic) and judged too fragile to keep in code — it silently stops making sense the moment the retrieval service moves to different hardware.
- **Current behavior**: at assessment time, `runFullAssessment` performs a single non-blocking read of the stored retrieval result. If present, it's used immediately. If not, the assessment proceeds immediately with roster-only (LLM-only) context — no wait, no retry, no poll.
- **Why this is still consistent with D015's reasoning**: Decision 4's own rationale — human think time (30–120s) absorbs the ~76s retrieval latency in the common case — means the adaptive wait was only ever a narrow safety net for the ~70–72s boundary, not the primary mechanism the feature relies on. Removing it trades a small amount of additional miss-rate (sessions where the user answers right as retrieval is about to finish) for removing a machine-specific magic number from the code.
- **Telemetry**: `rag_available` is still logged per full assessment on the RAG-configured path. `rag_wait_ms` (FR-008, SC-004) was dropped — it measured poll duration, and there is no poll to measure.
- **FR-004, NFR-002, US3 scenarios 2–3, and SC-004 above are left unedited** as the historical record of what was originally specified. This note is the authoritative statement of actual, current behavior.

---

## Out of Scope

- Changes to the bias retrieval service API or infrastructure.
- Retrieval result caching across sessions.
- A user-facing indicator that retrieval is running in the background.
- Optimization of NLI/retrieval latency (GPU, ONNX export, two-phase NLI) — pending telemetry from SC-004 to justify.
- Per-round retrieval (one retrieval call per question round rather than once per story) — future consideration.
- Merging story_only LLM initial bias candidates into the workspace (FR-005 note) — requires a new `initial_bias_result` DB column and RunStore methods to persist and retrieve the story_only LLM output. Deferred to a follow-on spec; the `"both"` value in `context_source` is reserved for when this is implemented.
