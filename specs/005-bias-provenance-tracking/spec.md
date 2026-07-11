# Feature Specification: Three-Way Bias Provenance Tracking

**Feature Branch**: `005-bias-provenance-tracking`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "Three-way bias provenance tracking (D015). Record which signal produced each detected bias — the engine's vector search, the engine's local LLM, or the assessment LLM acting alone — so confirmation-rate-per-source can be measured later. Pure post-hoc observability tagging: no new LLM calls, no change to prompts, fire-and-forget DB writes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Distinguish where each detected bias came from (Priority: P1)

As a system operator analysing detection quality, I need every bias in an assessment result to
carry a precise record of which upstream signal surfaced it — the retrieval engine's vector search,
the retrieval engine's own local LLM, both engine signals, or the main assessment LLM naming it on
its own — instead of the current coarse "retrieved vs. roster" label that conflates several distinct
situations.

**Why this priority**: This is the core instrumentation goal. Without per-signal provenance on each
bias, none of the downstream measurement (confirmation rates per source) is possible. It is the
foundation the other stories build on.

**Independent Test**: Run an assessment while the engine is reachable and returns per-bias source
information; confirm each bias in the result is tagged with the exact engine signals that surfaced
it, and that a bias the assessment LLM named without any engine signal is distinguishable from a
bias produced when the engine was unavailable.

**Acceptance Scenarios**:

1. **Given** the engine returns a bias surfaced by vector search only, **When** that bias appears in
   the final result, **Then** its provenance records vector search as the sole engine signal.
2. **Given** the engine returns a bias surfaced by its local LLM only, **When** that bias appears in
   the final result, **Then** its provenance records the engine's local LLM as the sole signal.
3. **Given** the engine returns a bias surfaced by both engine signals, **When** that bias appears in
   the final result, **Then** its provenance records both signals individually (not a single merged
   "both" value).
4. **Given** the engine ran and returned results but did not surface a particular bias, **When** the
   assessment LLM names that bias anyway, **Then** its provenance records "no engine signal" in a way
   that is explicitly attributable to the assessment LLM acting alone.
5. **Given** the engine was unavailable or fell back to the roster, **When** a bias appears in the
   result, **Then** its provenance records that no engine signal exists and this is marked as
   unknown-origin (NOT attributed to the assessment LLM).

### User Story 2 - Preserve backward compatibility while consuming richer engine data (Priority: P2)

As a maintainer, I need the system to read the engine's new richer per-bias source information when
present, but continue to behave exactly as before for engine responses that do not carry it, so no
existing strategy or stored record breaks.

**Why this priority**: The new engine field is additive and only populated under one retrieval
strategy. The existing inference behaviour must remain the fallback so other strategies are
unaffected; this de-risks the change but is not itself the measurement goal.

**Independent Test**: Run assessments under a strategy that omits the new source field and confirm
provenance still resolves via the existing fallback rule with no errors; run under the strategy that
includes it and confirm the richer signal is used instead.

**Acceptance Scenarios**:

1. **Given** an engine response without per-bias source information, **When** provenance is computed,
   **Then** the existing retrieval-signal inference rule is used unchanged.
2. **Given** an engine response with per-bias source information, **When** provenance is computed,
   **Then** the explicit source information is preferred over the inference rule.

### User Story 3 - Persist per-source lists and confirmation counts for later analysis (Priority: P2)

As an analyst, I need each assessment run to durably store the engine's contribution split by signal
(what vector search proposed vs. what the engine's local LLM proposed) alongside what the assessment
LLM produced and the final result, plus per-signal confirmation counts, so I can later compute how
often each source's suggestions survive into the final answer.

**Why this priority**: The provenance tags on a live result (Story 1) are ephemeral unless captured.
This story makes the confirmation-rate dataset actually queryable after the fact, which is the reason
the feature exists — but it depends on Story 1 being in place.

**Independent Test**: Run an assessment and inspect the stored comparison record; confirm it contains
separate vector-source and local-LLM-source lists, the existing combined list, the assessment LLM
list, the final list, and per-signal confirmation counts consistent with the lists.

**Acceptance Scenarios**:

1. **Given** an assessment run with engine per-bias source information, **When** the comparison record
   is written, **Then** it contains a vector-source list and a local-LLM-source list, and a bias
   surfaced by both signals appears in both lists.
2. **Given** the same run, **When** the comparison record is written, **Then** it retains the existing
   combined engine list, the assessment-LLM list, and the final list.
3. **Given** the same run, **When** confirmation counts are computed, **Then** per-signal counts
   (vector-confirmed, local-LLM-confirmed, both-confirmed) are recorded alongside the existing
   aggregate confirmation count.
4. **Given** the comparison write fails for any reason, **When** the assessment completes, **Then**
   the assessment response is returned normally and the failure is logged without blocking.

### Edge Cases

- **Engine returns source information for some biases but null for others** within the same response
  (mixed strategy artifacts): each bias is resolved independently — those with source use it, those
  without fall back to the inference rule.
- **A bias surfaced by both engine signals**: it must be counted once in each per-signal list and in
  the both-confirmed count, without double-counting the aggregate.
- **Empty engine result set** (engine ran, returned nothing): every final bias is attributable to the
  assessment LLM acting alone, provided the engine was actually reachable.
- **Engine unavailable / roster fallback**: no engine signal exists; provenance must NOT be
  interpreted as assessment-LLM-alone.
- **Comparison write failure**: must be swallowed (fire-and-forget) and never surface to the caller.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST consume, when present, the engine's per-bias source information
  describing which engine signal(s) surfaced each bias (vector search, local LLM, or both), and the
  additional per-response engine metadata that accompanies it.
- **FR-002**: The system MUST prefer the engine's explicit source information over the existing
  retrieval-signal inference rule whenever that information is present for a bias.
- **FR-003**: The system MUST retain the existing inference rule as the fallback for engine responses
  that do not carry per-bias source information, leaving those strategies' behaviour unchanged.
- **FR-004**: The system MUST replace the current binary origin label on each detected bias with a
  per-bias provenance that lists the individual engine signals that corroborated it, keeping the
  individual signals distinguishable rather than collapsed into a single merged value.
- **FR-005**: The system MUST distinguish "the assessment LLM named this bias with no engine signal,
  while the engine did run" from "no engine signal exists because the engine did not run," retaining
  the request-level engine status so the two no-signal cases remain separable **within the stored
  comparison record**. This disambiguation is a request-level property (the engine either ran for the
  request or it did not); it is resolved from the stored request-level status crossed with the
  per-source lists, and is NOT required to be exposed on the live API response (see Assumptions).
- **FR-006**: The system MUST derive all provenance from data already produced within the run (the
  engine response and the assessment LLM's own output) and MUST NOT make any additional model call.
- **FR-007**: The system MUST persist, per assessment run, the engine's contribution split into a
  vector-source list and a local-LLM-source list, with a bias surfaced by both signals appearing in
  both lists.
- **FR-008**: The system MUST retain the existing combined engine list, the assessment-LLM list, and
  the final list in the stored comparison record for backward read compatibility.
- **FR-009**: The system MUST compute and store per-signal confirmation counts (vector-confirmed,
  local-LLM-confirmed, both-confirmed) alongside the existing aggregate confirmation count.
- **FR-010**: The system MUST perform the comparison write as fire-and-forget: a failure MUST be
  logged and MUST NOT block or alter the assessment response.
- **FR-011**: The provenance tagging MUST NOT change what context the assessment LLM sees or how it is
  prompted; tags are computed after the model call.
- **FR-012**: The system MUST NOT treat a bias corroborated by multiple signals as higher-confidence
  input to the assessment prompt; the provenance is observability-only and MUST NOT be fed back into
  ranking or context selection.

### Key Entities *(include if feature involves data)*

- **Bias provenance**: For a single detected bias, the set of engine signals that surfaced it
  (vector search, local LLM, both, or none), plus the request-level engine status that disambiguates
  the "none" case (assessment-LLM-alone vs. engine-did-not-run).
- **Retrieval comparison record**: A per-assessment-run observability record capturing the engine's
  vector-source list, the engine's local-LLM-source list, the combined engine list, the assessment
  LLM's list, the final list, and aggregate plus per-signal confirmation counts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every detected bias in an assessment run where the engine supplied source
  information, the recorded provenance matches the engine's reported signals for that bias in 100% of
  cases.
- **SC-002**: A bias named by the assessment LLM without any engine signal (engine reachable) is
  distinguishable from a bias produced during engine unavailability in 100% of **stored comparison
  records** (via the request-level status crossed with the per-source lists).
- **SC-003**: Stored comparison records allow computing, per source (vector search, local LLM,
  assessment LLM alone), the percentage of that source's suggestions that reached the final result —
  a query that was not answerable before this feature.
- **SC-004**: No additional model calls are introduced: the count of model calls per assessment run is
  unchanged from before the feature.
- **SC-005**: Assessment responses are never delayed or failed by comparison-record writes; a forced
  write failure leaves the response unaffected in 100% of cases.
- **SC-006**: Assessment runs under strategies that omit the engine source field produce provenance
  identical to pre-feature behaviour (fallback rule), with zero regressions.

## Assumptions

- The engine's new per-bias source information is additive and only populated under the union
  retrieval strategy; other strategies continue to omit it (source is absent/null), which is why the
  inference-rule fallback must remain.
- A bias surfaced by "both" engine signals is represented as the two signals listed individually, not
  as a distinct merged value, both in transit and in storage.
- The existing observability write path is fire-and-forget already; this feature extends that same
  mechanism rather than introducing new delivery guarantees.
- The catalogue-expansion effort (growing the number of tracked biases) and any precision/accuracy
  tuning of the engine's local LLM are explicitly out of scope; this feature only measures, it does
  not tune.
- The engine source-of-truth for the new field shapes is the engine's retrieve-biases v3 contract.
- The `engineSources == []` disambiguation (assessment-LLM-alone vs. engine-did-not-run) is served
  from the **stored** comparison record's request-level status; the live API response is NOT required
  to carry the request-level status. (Decision on review finding 3.)
- The existing per-bias `context_source` field is **replaced** by `engineSources`, not kept alongside.
  The only in-repository reference beyond source code is a generated build bundle; no hand-maintained
  or external consumer reads it. A verification step guards removal. (Decision on review finding 4.)
- Persisted per-source lists (`ragVectorList`/`ragLlmList`) and the final list are keyed by bias
  **name**, consistent with the existing combined list, so confirmation-count intersections align.
