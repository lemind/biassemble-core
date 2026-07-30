# Feature Specification: B2B Audit Mode — Claim Pipeline and Business Metrics

**Feature Branch**: `008-b2b`

**Created**: 2026-07-20

**Status**: Draft

**Input**: User description: "B2B audit mode: wire the mode flag, EXTRACT and VERIFY prompts, the code-side numeric normalization layer, and the /audit endpoint into biassemble-core, per docs/decisions/018-audit-mode-flag.md (D018) and the golden sets already built in evaluations/golden/audit/. Scope: mode flag through routes/orchestrators/prompts (D018 §1), the claim pipeline EXTRACT→RETRIEVE→VERIFY→GATE (D018 §2), the verdict taxonomy and code-side numeric normalization (D018 §2.3), stable claim_id/passage_id and audit_id idempotency (D018 §2 identity/versioning), and the business metrics/scores block computed at GATE (D018 §4). Out of scope: engine-side corpus ingestion and embedding model swap (D018 §2.1/§2.2), the bias-module source_qa verification pass (D018 §3), the internal review page and report generator (D018 §4.3 presentation), and the pilot-target integration run."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run an audit and get grounded verdicts back (Priority: P1)

As the operator running a groundedness audit, I need to submit a piece of AI-generated output text together with its source documents and get back every checkable factual claim in that text, each with a verdict on whether the supplied sources support it — so I can tell a customer, with evidence, which of their AI's statements are backed by their own documents and which are not.

**Why this priority**: This is the entire product. Without a working claim pipeline producing evidence-backed verdicts, there is nothing to sell, review, or report on — every later capability (scoring, the review page, the report generator) has nothing to operate on until this exists.

**Independent Test**: Submit an output text and a set of source documents through the audit pipeline; confirm every atomic checkable claim in the text is extracted, each is checked against the supplied sources, and each carries one of the five defined verdicts with a supporting quote or an explicit "no provided passage addresses this claim" absence, worded to match D018 §2.3 exactly on review — asserting only that the supplied sources are silent, never that the claim itself is false — independent of any scoring, review, or reporting capability.

**Acceptance Scenarios**:

1. **Given** an output text containing a claim directly stated in a supplied source, **When** the audit runs, **Then** the claim is extracted and marked supported, with the exact supporting text quoted verbatim from the source.
2. **Given** an output text containing a claim no supplied source addresses, **When** the audit runs, **Then** the claim is marked unsupported, and this is recorded distinctly from a claim the sources actively dispute.
3. **Given** an output text containing a claim a supplied source directly disputes for the same subject, measure, period, and scope, **When** the audit runs, **Then** the claim is marked contradicted, with the disputing text quoted verbatim.
4. **Given** an output text containing a claim that matches a source figure belonging to a different time period than the claim states, **When** the audit runs, **Then** the claim is marked unsupported (not contradicted), with a note explaining the period mismatch.
5. **Given** an output text containing an opinion, a hedge, or the author's own forecast rather than a checkable fact, **When** the audit runs, **Then** that content is never extracted as a claim.
6. **Given** an output text with zero checkable claims, **When** the audit runs, **Then** the audit completes and reports zero claims rather than failing or fabricating one.
7. **Given** a source document, or the audited output text itself, contains text that reads as an instruction rather than content to check, **When** the audit runs, **Then** that text is treated strictly as data under analysis and never changes what the pipeline does.

---

### User Story 2 - Trust the numbers without doing the arithmetic myself (Priority: P2)

As the operator, I need every number the audit reports — growth rates, unit comparisons, the overall groundedness figure — to be computed the same way every time from the underlying facts, not estimated by a model, so that a skeptical customer's own recalculation always matches what I sent them.

**Why this priority**: Builds directly on User Story 1. The claim-level verdicts alone are sellable, but a customer-facing groundedness figure that can't be reproduced from disclosed counts is a credibility risk the product cannot afford — this closes that gap once verdicts exist.

**Independent Test**: Given a completed audit's claim verdicts and their underlying numeric values, confirm the audit's summary numbers (growth-rate comparisons, unit/scale conversions, the overall groundedness figure and its components) are identical on repeated computation from the same inputs, and that every headline figure is accompanied by the raw counts and denominator it was computed from.

**Acceptance Scenarios**:

1. **Given** a claim stating a value in different units or scale than its matching source figure, **When** the audit compares them, **Then** the comparison is resolved by conversion, not by an approximate judgment, and the same inputs always produce the same comparison result.
2. **Given** a claim and source figure that cannot be meaningfully compared (different currency with no conversion available, ambiguous or missing units, mismatched fiscal periods), **When** the audit evaluates them, **Then** the pair is reported as not comparable and is never treated as evidence the claim is wrong.
3. **Given** a completed audit, **When** its overall groundedness figure is displayed, **Then** it is always shown together with the underlying verdict counts, the stricter fully-supported-only figure, and the total claim count, so it can be independently recomputed.
4. **Given** an audit where a large share of claims could not be confidently verified either way, **When** the summary is generated, **Then** the audit is flagged as low-decisiveness and its headline figure is presented as qualified rather than a clean number.
5. **Given** the same audit's verdict counts, **When** the overall groundedness figure is recomputed by hand from the disclosed counts, **Then** it matches the figure the audit reported.

---

### User Story 3 - Re-run an audit and trust what comes back (Priority: P3)

As the operator, I need every claim, source passage, and completed audit to have a stable identity that survives being re-run, reviewed, or referenced later, so that a correction or a repeat engagement never silently overwrites or gets confused with a previous result.

**Why this priority**: Builds on User Stories 1–2. A single successful audit run is valuable on its own; this story is what makes running audits repeatedly, across engagements, safe enough to build a paid product and a historical record on top of.

**Independent Test**: Run the same audit input twice; confirm each run produces its own distinct, traceable result while both results are recognizable as coming from the same input, and confirm every claim and every source passage referenced in a result keeps a stable reference that does not depend on its position in a list.

**Acceptance Scenarios**:

1. **Given** an audit has already been run once, **When** the exact same input is submitted again, **Then** a new, independent result is produced rather than the previous one being altered, and both results are identifiable as originating from the same input.
2. **Given** a completed audit result, **When** its claims are inspected later, **Then** each claim and each source passage it cites can be identified on its own, without relying on its position or order in any list.
3. **Given** a completed audit result, **When** its record is examined, **Then** it states exactly which version of every component that could affect the outcome (prompts, models, source material, thresholds) was in effect for that run.

---

### Edge Cases

- What happens when a source document set is empty or contains no text relevant to any claim? (Every claim should resolve to unsupported by absence, not error.)
- What happens when the same fact is stated twice in the output text? (Recorded once, with both locations noted, not duplicated as two separate claims.)
- What happens when a claim requires combining two different source passages to be confirmed? (Marked supported with both passages quoted, and flagged as a combined-evidence case.)
- What happens when a claim's number appears verbatim in a source but attached to a different subject or category than the claim asserts? (Not credited as support just because the number matches — evaluated against the same subject/measure/period/scope the claim actually asserts.)
- What happens when the volume of claims in one output text is unusually large? (A defined cap applies; anything beyond it is reported as truncated, never silently dropped without notice.)
- What happens if retrieval of source passages is temporarily unavailable for a claim? (Distinguished from "sources are silent" — an operator must be able to tell "nothing relevant exists" apart from "the lookup didn't happen.")
- What happens when an audit is re-run with source documents that have since changed? (The new run is independent and versioned; it never blends with or silently supersedes the earlier one.)
- What happens when a claim's asserted figure happens to match a real number found somewhere in the sources, but that number belongs to a different subject or category than the claim states (e.g. a claim about the whole company matching a figure that actually belongs to one region)? (Not credited as support or spared a contradiction just because matching digits exist somewhere in the sources — evaluated against the source's own statement for the claim's actual stated subject.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer an audit mode distinct from the existing story-assessment mode, selectable per request, without altering the existing story-assessment behavior in any way (D018 §1).
- **FR-002**: In audit mode, the system MUST accept a body of AI-generated output text, an accompanying set of source documents (each identifiable well enough to be cited back per-claim later — see FR-012's stable identity requirement), and optional free-text task context (which may itself include an as-of date, e.g. "the question the audited AI was answering + as-of date" — there is no separate structured date field; this was ambiguous in an earlier draft), as the unit of work.
- **FR-003**: The system MUST extract every atomic, checkable factual claim from the output text, excluding opinions, hedged speculation, and the author's own unattributed forecasts (D018 §2).
- **FR-004**: The system MUST retrieve candidate source passages for each extracted claim from the source documents supplied for that engagement, kept separate from any other engagement's material.
- **FR-005**: The system MUST evaluate each claim against its retrieved passages and assign exactly one of five verdicts — supported, partially supported, unsupported, contradicted, or unverifiable — per the canonical definitions (D018 §2.3).
- **FR-006**: The system MUST require strict comparability (same subject, measure, period, and scope) before marking a claim contradicted; a mismatch on any of those dimensions MUST resolve to unsupported instead, never contradicted.
- **FR-007**: The system MUST perform all unit, scale, currency, and period normalization, and all derived-value arithmetic, in deterministic code rather than via model judgment; a claim's underlying numeric comparison must produce identical results on every evaluation of the same inputs.
- **FR-008**: The system MUST report a pair of values as "not comparable" — rather than as a contradiction — whenever they differ in currency without a usable conversion, have an ambiguous or missing unit, or reference incompatible time periods. **"Not comparable" is an internal numeric-comparison result, not a sixth claim verdict** (clarified on review — an earlier draft's wording could reasonably be read as implying one). The five verdicts in FR-005 are exhaustive; when a numeric comparison is not comparable, the claim's final verdict is still one of those five — typically `unsupported` (the comparable evidence needed to confirm or dispute it wasn't found) or `unverifiable` (confidence falls below threshold) — determined by the broader evidence evaluation, never by adding a new verdict value.
- **FR-009**: The system MUST log, for every claim, whether source material could even be found for it, separately from whether that material agreed with the claim — so "no evidence found" and "evidence disagreed" are never confused. This requires recording two distinct facts per claim, not one (made explicit on review): **whether retrieval completed at all** (as opposed to failing/erroring) and, only if it did, **whether it found any candidate material** — collapsing these into a single "found nothing" signal makes an infrastructure failure indistinguishable from a genuinely silent source, which is exactly the confusion this requirement exists to prevent.
- **FR-010**: The system MUST treat all supplied source content and audited output text strictly as data under analysis; such content MUST NOT be able to alter the system's evaluation behavior, criteria, or output format.
- **FR-011**: The system MUST gate any claim whose evaluation confidence falls below the configured threshold to unverifiable, and MUST NOT surface a guessed verdict for it.
- **FR-012**: The system MUST assign every extracted claim a stable identifier that remains valid from extraction through evaluation and into any later reference, and MUST assign every retrieved source passage a stable identifier likewise; no part of the system may rely on list position to relate a claim to its evaluation or a passage to its citation.
- **FR-013**: The system MUST treat each completed audit as immutable once finished; resubmitting the same input MUST produce a new, independently identified audit rather than modifying a prior one, while still allowing the two to be recognized as originating from the same input.
- **FR-014**: The system MUST record, with every completed audit, exactly which version of every component capable of affecting its outcome was active for that run (prompt versions, model identifiers, **which exact source material was checked against, distinct from which retrieval implementation checked it** — clarified on review: these are two different facts an implementer could wrongly collapse into one "corpus" field, and doing so would make "same output, different source documents" indistinguishable from "same output, same documents, different retrieval code" — and the evaluation threshold), so that a past result's conditions are always reconstructable.
- **FR-015**: The system MUST compute, for every completed audit, a headline groundedness figure as `(supported + 0.5 × partially_supported) / eligible` — made explicit here on review; this number is customer-facing and commercially significant enough that it shouldn't live only inside an ADR cross-reference — where the 0.5 weight is a fixed, disclosed grading convention (D018 §4.1), together with: the raw verdict counts, the total eligible claim count, a stricter fully-supported-only figure (no partial credit), and whether the audit was flagged low-decisiveness — never presenting the headline figure without all of these alongside it (D018 §4.1). **When there are zero eligible claims** (either the audit found zero checkable claims at all, per the zero-claims edge case above, or every claim was gated to unverifiable), the headline figure and its companion rates MUST be reported as not applicable rather than a fabricated number (e.g. zero) — a zero-claim or all-unverifiable audit is a legitimate, expected outcome, not an error, and must never be misread as "zero groundedness."
- **FR-016**: The system MUST exclude contradicted claims from credit in the headline groundedness figure (equal treatment to unsupported), and MUST always report the contradiction rate as its own figure regardless of the headline figure's value (D018 §4.2).
- **FR-017**: The system MUST flag an audit as low-decisiveness, and present its headline figure as qualified rather than a clean number, whenever unverifiable claims exceed one-fifth of all evaluated claims (D018 §4.1).
- **FR-018**: The system MUST record whether a supported claim relied on a single passage or required combining more than one, and MUST make that distinction visible per claim rather than only in aggregate.
- **FR-019**: The system MUST cap the number of claims extracted from a single output text at a configured maximum, and MUST explicitly report when that cap was reached rather than silently omitting claims past it.
- **FR-020**: The system MUST derive a claim's evaluation confidence exclusively from the verdict-evaluation step; the quality of the retrieved source material MUST be tracked as a separate figure and MUST NOT be blended, averaged, or otherwise combined with confidence into one number at any point.
- **FR-021**: The system MUST treat a response that fails to match the expected output structure, following content suspected of attempting to alter system behavior, as a hard failure to be rejected and logged — never as something to be automatically corrected and resubmitted.

### Key Entities

- **Claim**: An atomic, checkable factual statement extracted from audited output text — carries a type (numeric, entity, attribution, causal, or derived), the text it was drawn from, and a stable identity that persists through evaluation.
- **Source Passage**: A retrieved excerpt of source-document text considered as candidate evidence for a claim — carries a stable identity and belongs to exactly one engagement's source material. Each submitted source document (FR-002) is itself identifiable; a passage records which submitted document it was drawn from and where within it — this mapping is implicit in an implementation-level document, made explicit here on review since it was previously only inferable, not stated.
- **Verdict**: The outcome of evaluating one claim against its retrieved passages — one of five defined states, always paired with either a supporting/disputing quote or an explicit statement of absence.
- **Audit**: One complete run of the pipeline over one submitted output text and its source documents — has its own stable identity, is immutable once complete, and records the exact conditions (versions, thresholds) under which it ran.
- **Score Summary**: The set of business-facing figures computed for a completed audit — the headline groundedness figure, the stricter fully-supported figure, the contradiction and unsupported rates, and the raw counts they derive from.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Given the eleven-text extraction reference set (including the same-fact-stated-twice case), the system correctly identifies at least 90% of the checkable claims it is expected to find, correctly dedupes a repeated fact into one claim rather than two, and does not misidentify opinions or forecasts as claims in any of the eleven texts.
- **SC-002**: Given the fifteen-pair verification reference set, the system assigns the expected verdict in at least fourteen of fifteen cases, and in zero cases does it assign "contradicted" to a pair that only differs by time period, unit scale, or scope rather than by genuinely opposing content.
- **SC-003**: Given the twenty-pair numeric comparison reference set, the system never reports a pair as contradictory when the pair is not actually comparable (mismatched currency, period, or missing unit) — zero exceptions.
- **SC-004**: Every completed audit's record includes a complete statement of the versions and thresholds in effect for that run, with no missing fields, for 100% of runs.
- **SC-005**: Every completed audit's headline groundedness figure is always accompanied by its raw counts and the stricter figure in the same response — 100% of the time, with no exceptions.
- **SC-006**: Submitting identical input twice always yields two distinct, independently addressable audit results that are still recognizably linked to the same input, in 100% of repeated-submission cases.
- **SC-007**: The existing story-assessment behavior shows no measurable change — the existing consumer evaluation suites continue to pass at the same rate they did before this feature existed.

## Assumptions

- Source-passage retrieval for a submitted engagement's documents is available as a dependency of this feature, not built by it — the engine-side work that ingests and indexes those documents (D018 §2.1, §2.2) is separate, out-of-scope work. Until it lands, this feature's retrieval step is validated against a stand-in that returns pre-defined passages for known inputs, using the same reference material already built (`evaluations/golden/audit/source-filing.md`).
- The optional reasoning/bias-flag layer (D018 §3) and its source-answered verification pass are out of scope here; this feature produces claim verdicts and business metrics only, leaving room for that layer to attach later without requiring rework of this feature's output shape.
- No user-facing surface (an operator page, a customer-facing report) is in scope; this feature is validated through direct submission of input and inspection of the resulting record, per the reference sets already built in `evaluations/golden/audit/`.
- The audit-mode entry point is reachable only by the operator (this project's existing authenticated access), not by external customers directly — customer-facing delivery happens through the reporting layer scoped separately.
- "Eligible" claims for rate calculations means every claim reaching a supported, partially supported, unsupported, or contradicted verdict; unverifiable claims are counted and reported but excluded from rate denominators, per the disclosure and low-decisiveness rules above.
