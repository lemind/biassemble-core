# Feature Specification: Grounnel Citation Provenance

**Feature Branch**: `011-gr-upd1` (pre-existing branch this work landed on — doesn't follow the usual `0NN-slug` = branch-name convention other specs in this repo use; noted here rather than silently mismatched, per code review)

**Created**: 2026-08-12

**Status**: Draft

**Input**: `biassemble` frontend team asked for a way to link a claim's highlighted span to the specific supporting text within a specific source, not just a bare link to the source's homepage. Investigation (see `docs/decisions/027-grounnel-citation-provenance.md`) found the pipeline already computes exactly this internally (VERIFY cites `{source, n}` sentence pairs) but discards the source label when flattening `evidence` into one string.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A consumer can see which source backs which part of a claim's evidence (Priority: P1)

A downstream consumer of `GET /status/:id` (today: `biassemble/backend` → frontend) wants to show, per claim, which specific sentence from which specific source contributed to the verdict — not just a flattened, cross-source evidence paragraph and a separate, unlinked list of source URLs.

**Why this priority**: This is the entire scope of this feature — a single API surface change.

**Independent Test**: Run a claim through the pipeline that pools evidence from 2+ sources. Confirm the response's new `citations` field has one entry per cited sentence, each with the correct `url` matching the source it actually came from (not a different pooled source), in the model's original citation order.

**Acceptance Scenarios**:

1. **Given** a claim whose evidence cites sentences from two different pooled sources (e.g. `A2`, `B1`), **When** `GET /status/:id` is polled after the claim resolves, **Then** `claims[].citations` contains two entries, each with the `url` of the source its `source` label (`A`/`B`) actually maps to, in citation order (`A2` before `B1` if that's the order VERIFY cited them).
2. **Given** a claim with a single-source citation repeated twice (e.g. `A2`, `A7`), **When** the claim resolves, **Then** `citations` contains two separate entries (not merged into one), both with the same `url`.
3. **Given** a claim whose evidence gets nulled by gate #1 (not grounded) or gate #1b (cross-claim contamination), **When** the claim resolves, **Then** `citations` is an empty array — never citations pointing at evidence the gate chain rejected.
4. **Given** a claim answered via the T034 reconciliation retry (not the primary VERIFY call), **When** the claim resolves, **Then** `citations` reflects the retry's own citations, not the original (pre-retry, since-discarded) answer's.
5. **Given** an audit created before this field existed (pre-existing Redis row), **When** its status is re-read, **Then** `citations` is present and `[]`, not a parse error.

### Edge Cases

- What happens when a claim has no evidence at all (`status: unsupported`, no sources resolved)? — `citations` is `[]`, same as `evidence: null`.
- What happens when a citation's source label doesn't resolve (shouldn't happen post-`resolveEvidenceFromCitations`'s existing null-the-whole-answer behavior, but noted for completeness)? — Whole answer already nulls per existing D026 §11 behavior; this feature doesn't change that, `citations` is `[]` in that case too, consistent with `evidence: null`.
- What happens to `citations` when a fill-in call (D026 §8, missing-claim recovery) answers a claim? — Same treatment as any other answered claim; the fill-in path reuses `callVerify`/`processVerifyResults` unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `GET /status/:id` response's `claims[]` MUST include a new `citations` array field, additive to the existing shape.
- **FR-002**: Each `citations` entry MUST include the resolved sentence text, the source label VERIFY cited (`source`), the sentence number within that source (`sentence`), and the source's real `url`.
- **FR-003**: `citations` entries MUST preserve VERIFY's original citation order — not sorted, not deduplicated by source.
- **FR-004**: A citation's `url` MUST be matched to its real source without relying on URL string equality (object-identity matching, per D027 §2).
- **FR-005**: `citations` MUST be nulled to `[]` in lockstep whenever the gate chain nulls `evidence` — a claim never has citations pointing at rejected evidence.
- **FR-006**: `citations` MUST reflect whichever VERIFY call (primary or T034 retry) produced the surviving `evidence` — never a stale answer from a call that was superseded.
- **FR-007**: The field MUST be backward compatible — an existing Redis-persisted claim row without this field MUST parse as `citations: []`, not fail.
- **FR-008**: No change to `evidence`'s existing shape or behavior, no prompt version bump — this is a processing-layer change only, VERIFY's own output contract is unchanged.

### Key Entities

- **ClaimCitation**: One resolved citation — `source` (internal pool label), `sentence` (number within that source), `url` (the real source URL), `text` (the resolved sentence). Not deduplicated against sibling citations from the same source.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A real multi-source claim's `citations` array correctly attributes each citation to its real source URL, verified against a live (non-mocked) run.
- **SC-002**: A claim whose evidence is gate-nulled has `citations: []`, verified by a unit test reproducing gate #1's rejection path.
- **SC-003**: No existing test's assertions on `evidence`, `verdict`, `sources`, or any other pre-existing claim field change.

## Assumptions

- `biassemble/backend` and `biassemble/frontend` consuming this new field is out of scope for this spec — tracked as a separate follow-up once this lands and is verified (D027 §Consequences).
- No Postgres/history-table change — `citations` is a Redis-response-shape addition only, consistent with `evidence` itself never having been persisted to the history tables' structured columns beyond what already exists.
- `#:~:text=`-style deep linking is explicitly out of scope (D027 §4) — this spec only makes the underlying data available.
