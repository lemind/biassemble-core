# Feature Specification: Engine Provenance Tracking

**Feature Branch**: `007-engine-provenance-tracking`

**Created**: 2026-07-12

**Status**: Draft

**Input**: User description: "Three-way engine provenance tracking, per docs/decisions/017-engine-provenance-tracking.md (D017). Record which signal produced each detected bias — the engine's vector search, the engine's local LLM, or the assessment LLM acting alone — so confirmation-rate-per-source can be measured later. No fixed-arity 'both' columns or fields anywhere — persisted per-source stats use one open-ended map keyed by whatever source name actually appears."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Distinguish where each detected bias came from (Priority: P1)

As a system operator analysing detection quality, I need every bias in an assessment result to
carry a precise record of which upstream signal surfaced it — the retrieval engine's vector search,
the retrieval engine's own local LLM, both engine signals, or the main assessment LLM naming it on
its own — instead of the current coarse label that cannot distinguish "the engine ran and missed
this" from "the engine never got a chance to look."

**Why this priority**: This is the core instrumentation goal. Without per-signal provenance on each
bias, no downstream measurement (confirmation rate per source) is possible.

**Independent Test**: Run an assessment where a background retrieval result is available with
per-bias source information; confirm each bias in the result is tagged with the exact engine
signal(s) that surfaced it, and that a bias the assessment LLM named without any engine signal is
distinguishable from a bias produced when no retrieval result was available at all.

**Acceptance Scenarios**:

1. **Given** the retrieval result contains a bias surfaced by vector search only, **When** that bias
   appears in the final result, **Then** its provenance records vector search as the sole signal.
2. **Given** the retrieval result contains a bias surfaced by the engine's local LLM only, **When**
   that bias appears in the final result, **Then** its provenance records the engine's local LLM as
   the sole signal.
3. **Given** the retrieval result contains a bias surfaced by both engine signals, **When** that bias
   appears in the final result, **Then** its provenance records both signals individually — as a set
   of two signals, never as a separate third named value standing in for "both."
4. **Given** a retrieval result is available and does not include a particular bias, **When** the
   assessment LLM names that bias anyway, **Then** its provenance records no engine signal in a way
   that is explicitly attributable to the assessment LLM acting alone.
5. **Given** no retrieval result is available for the request (background retrieval never completed
   or failed), **When** a bias appears in the result, **Then** its provenance records no engine
   signal, and this is distinguishable from the case where the engine looked and simply missed it.

---

### User Story 2 - Preserve backward compatibility while consuming richer engine data (Priority: P2)

As a maintainer, I need the system to read the richer per-bias source information when present, but
continue to behave exactly as before for retrieval results that do not carry it, so no existing
retrieval mode or stored record breaks.

**Why this priority**: The richer signal is additive and only populated under certain retrieval
configurations. Existing behavior must remain the fallback so other configurations are unaffected.

**Independent Test**: Process a retrieval result without per-bias source information and confirm
provenance still resolves via the existing inference rule with no errors; process one that includes
it and confirm the richer signal is used instead.

**Acceptance Scenarios**:

1. **Given** a retrieval result without per-bias source information, **When** provenance is
   computed, **Then** a bias that was otherwise retrieved is attributed to vector search (the
   existing inference rule), unchanged from current behavior.
2. **Given** a retrieval result with per-bias source information, **When** provenance is computed,
   **Then** the explicit source information is preferred over the inference rule.
3. **Given** a retrieval result mixing biases with and without per-bias source information in the
   same response, **When** provenance is computed, **Then** each bias resolves independently.

---

### User Story 3 - Persist per-source stats for later analysis, without hardcoding a fixed set of sources (Priority: P2)

As an analyst, I need each assessment run to durably store which biases each signal proposed and how
many of each signal's proposals survived into the final answer, in a form that does not need to
change shape if a new signal is introduced later, so I can compute confirmation rates per source
without waiting on a schema change every time the set of signals grows.

**Why this priority**: The provenance tags on a live result (Story 1) are ephemeral unless captured.
This story makes the confirmation-rate dataset queryable after the fact — the reason the feature
exists — but depends on Story 1 being in place. The "no fixed set of sources" requirement is itself a
first-class goal here, not an implementation nicety: a prior attempt at this exact feature hardcoded
storage around exactly two sources plus a dedicated field for their combination, and had to be
unwound because it could not accommodate a third source without another migration.

**Independent Test**: Run an assessment with per-bias source information available and inspect the
stored record; confirm it contains, for every distinct source name that actually appeared in that
run, the list of biases that source proposed and how many reached the final answer — with no
separate stored field representing a combination of sources.

**Acceptance Scenarios**:

1. **Given** an assessment run where sources "vector" and "llm" both proposed biases, **When** the
   record is stored, **Then** it contains an entry for "vector" and a separate entry for "llm," each
   with its own proposed-list and confirmed-count, and a bias proposed by both appears in both
   entries.
2. **Given** the same run, **When** someone wants to know how many biases both signals agreed on and
   which were confirmed, **Then** that number is computable by intersecting the two entries' lists —
   it is not itself a stored field.
3. **Given** the same stored data model, **When** a hypothetical third signal is introduced in the
   future, **Then** representing its stats requires no change to the stored record's shape — only a
   new entry under the existing per-source structure.
4. **Given** the record write fails for any reason, **When** the assessment completes, **Then** the
   assessment response is returned normally and the failure is logged without blocking.

### Edge Cases

- **Retrieval result available for some biases' signal detail but not others** within the same
  response: each bias resolves independently — those with signal detail use it, those without fall
  back to the inference rule.
- **A bias surfaced by both engine signals**: it is counted once under each signal's entry, without
  double-counting the pre-existing aggregate confirmation count.
- **Empty retrieval result** (background retrieval completed, found nothing): every final bias is
  attributable to the assessment LLM acting alone.
- **No retrieval result at all** (background retrieval never completed in time, or failed): no
  engine signal exists for any bias in this request; this must not be interpreted as
  assessment-LLM-alone.
- **Stored-record write failure**: swallowed (fire-and-forget), never surfaces to the caller.
- **A stale prior attempt at this feature left orphaned storage behind** outside the tracked history:
  this specification's persisted shape supersedes it cleanly; no migration path from the orphaned
  shape is required since it held no real data.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST consume, when present, per-bias signal information describing which
  retrieval signal(s) surfaced each bias (vector search, engine's local LLM, or both), and the
  additional per-response metadata that accompanies it.
- **FR-002**: The system MUST prefer explicit per-bias signal information over the existing
  inference rule whenever that information is present for a bias.
- **FR-003**: The system MUST retain the existing inference rule as the fallback for retrieval
  results that do not carry per-bias signal information, leaving that behavior unchanged.
- **FR-004**: The system MUST replace the current single-value bias-origin label with a per-bias
  provenance that lists the individual signals that corroborated it, keeping the individual signals
  distinguishable rather than collapsed into a single merged value — including removing any
  reserved-but-unused merged value from the current representation.
- **FR-005**: The system MUST distinguish "the assessment LLM named this bias with no engine signal,
  while a retrieval result was available" from "no engine signal exists because no retrieval result
  was available for this request," in the durably stored record.
- **FR-006**: The system MUST derive all provenance from data already produced within the run (the
  retrieval result and the assessment LLM's own output) and MUST NOT make any additional model call.
- **FR-007**: The system MUST persist, per assessment run, a per-source breakdown keyed by the
  distinct source names actually present in that run — each entry holding the list of biases that
  source proposed and how many reached the final result — with no hardcoded, fixed-in-advance set of
  source keys, and no separate stored field representing a combination of sources.
- **FR-008**: The system MUST retain the existing combined proposal list, the assessment-LLM list,
  and the final list in the stored record for backward read compatibility.
- **FR-009**: The system MUST perform the stored-record write as fire-and-forget: a failure MUST be
  logged and MUST NOT block or alter the assessment response.
- **FR-010**: The provenance tagging MUST NOT change what context the assessment LLM sees or how it
  is prompted; tags are computed after the model call.
- **FR-011**: The system MUST NOT treat a bias corroborated by multiple signals as higher-confidence
  input to the assessment prompt; the provenance is observability-only.
- **FR-012**: Any storage left behind by a prior, superseded attempt at this feature MUST be removed
  as part of delivering this specification, so the durable schema reflects only the design described
  here.

### Key Entities *(include if feature involves data)*

- **Bias provenance**: For a single detected bias, the set of signals that surfaced it (vector
  search, engine local LLM, both, or none), plus enough request-level context to disambiguate the
  "none" case (assessment-LLM-alone vs. no-retrieval-result-available).
- **Per-run source breakdown**: A per-assessment-run record capturing, for each distinct signal name
  that appeared in that run, the list of biases it proposed and how many reached the final result —
  open-ended in the set of signal names it can hold, alongside the existing combined-list and
  final-list fields already recorded for that run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every detected bias in an assessment run where per-bias signal information was
  available, the recorded provenance matches the reported signals for that bias in 100% of cases.
- **SC-002**: A bias named by the assessment LLM without any engine signal (retrieval result
  available) is distinguishable from a bias produced when no retrieval result was available, in 100%
  of stored records.
- **SC-003**: Stored records allow computing, per signal, the percentage of that signal's proposals
  that reached the final result — including for a signal not among the two known at the time this
  feature ships — without any change to how the data is stored.
- **SC-004**: No additional model calls are introduced: the count of model calls per assessment run
  is unchanged from before this feature.
- **SC-005**: Assessment responses are never delayed or failed by the stored-record write; a forced
  write failure leaves the response unaffected in 100% of cases.
- **SC-006**: Runs using retrieval configurations that do not supply per-bias signal information
  produce provenance identical to pre-feature behavior, with zero regressions.
- **SC-007**: No storage field anywhere in the delivered design represents a fixed combination of
  exactly two signals; combination counts are always computable from the per-signal breakdown, never
  independently stored.

## Assumptions

- Per-bias signal information is additive and only populated under one retrieval configuration;
  other configurations continue to omit it, which is why the inference-rule fallback must remain.
- A bias surfaced by "both" signals is represented as the two signals listed individually, both in
  transit and in storage — never as a distinct merged value.
- The existing stored-record write path is already fire-and-forget; this feature extends that same
  mechanism rather than introducing new delivery guarantees.
- Catalogue expansion (growing the number of tracked biases) and precision/accuracy tuning of any
  individual signal are explicitly out of scope; this feature only measures, it does not tune.
- Background retrieval (how and when a retrieval result becomes available for a request) is an
  existing mechanism this feature consumes; changing how or when retrieval happens is out of scope.
