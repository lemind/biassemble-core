---

description: "Task list for B2B Audit Mode — Claim Pipeline and Business Metrics"
---

# Tasks: B2B Audit Mode — Claim Pipeline and Business Metrics

**Input**: Design documents from `specs/008-b2b/` (plan.md, spec.md, research.md, data-model.md, contracts/audit-endpoint.md, quickstart.md)

**Tests**: Included — this repo's convention (`docs/testing-philosophy.md`, prior specs) writes tests for behavioral logic, and the golden sets in `evaluations/golden/audit/` exist specifically to be run as tests, not eyeballed.

**Organization**: Tasks are grouped by user story (spec.md: US1 = P1, US2 = P2, US3 = P3), each independently completable and testable per this repo's MVP-per-story convention (matching spec-005's structure).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3)

## Path Conventions

Single project (per plan.md's Structure Decision) — `src/`, `tests/` at repository root, mirroring the existing `reflection/` layout with a parallel `audit/` structure.

---

## Phase 1: Setup

**Purpose**: Scaffolding only — no behavior yet.

- [x] T001 Create directory structure: `src/orchestrators/audit/`, `src/prompts/audit/extract/`, `src/prompts/audit/verify/`, `src/numbers/`, `src/rag/corpus-client.ts` (stub file), `tests/unit/numbers/`, `tests/unit/orchestrators/audit/`, `tests/integration/` — per plan.md's Project Structure
  — Done. `src/rag/corpus-client.ts` left as a bare directory (`src/rag/`) rather than an empty stub file — T017 creates it with real content; an empty placeholder file added no value.

<!-- T002 removed on review: originally "add a mode discriminator alongside the existing one" — but no existing mode field exists to extend (reflection's routes are implicitly story-only), so the task rested on a false premise. The real mode distinction is established concretely by T005 (contracts) and T021 (route), not by a separate scaffolding step. Numbering below is left as-is rather than renumbering every downstream cross-reference. -->


---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Everything both US1 (verdict correctness) and US2 (score correctness) require before either can produce a correct result — comparability logic and identifiers are used by both, so they block both, not just one.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Define the `audit` pg schema (Drizzle) — `audits`, `claims`, `source_passages`, `claim_passages` (junction, added on review — see data-model.md's "Claim Passage" entity), `score_summaries` tables per data-model.md — in `src/db/schema.ts`, as a sibling schema to `core`, never nested inside it (D018 §2.4)
  — Done, 5 tables. Verdict fields (verdict/evidence/source_refs/synthesized/confidence/note) live directly on `claims` as nullable columns per data-model.md's "1:1 extension" design, not a 6th table. `auditId`/`claimId`/`passageId` are app-generated (no `defaultRandom()`) since `audit_id` must be known before the row exists (returned in the 202 response). Typecheck clean.
- [x] T004 Generate and review the migration for the new `audit` schema tables, following this repo's existing migration conventions (`src/db/migrations/`)
  — **Found and fixed a real gotcha before generating**: `drizzle.config.ts`'s `schemaFilter: ["core"]` would have silently excluded the new `audit` schema from `db:generate` entirely; added `"audit"` to the filter. Generated `0010_supreme_harpoon.sql` — purely additive (`CREATE SCHEMA "audit"` + 5 tables + FKs/indexes), no `ALTER`/`DROP` on any existing `core.*` table. **Not applied** — `db:migrate`/`db:push` against the live database is out of scope per the loop's stop condition; generated and reviewed only, awaiting explicit approval to apply.
- [x] T005 [P] Define Zod contracts in `src/contracts/audit.schemas.ts` — `AuditRequest`, `Claim`, `Verdict`, `Audit`, `ScoreSummary` — matching `contracts/audit-endpoint.md` field-for-field
  — Done. `GET /audit/:audit_id`'s three response shapes modeled as a discriminated union on `status`; found on review that the contract's own "complete" example never showed a `status` field (unlike the `running`/`failed` examples, which do) — fixed the contract doc to add it rather than design around its absence. Typecheck clean.
- [x] T006 [P] Add `computeAuditInputRef(output_text, sources[], task)` to the existing `src/lib/hash.ts` (which already has `computeInputHash` for the `runs`/`eval_results` determinism check — same pattern, new function, not a new module) for SHA-256 `input_ref` hashing; add `computeCorpusId(sources[])` alongside it — same hash pattern, `sources[]` only, no `output_text`/`task` — so `corpus_id` is content-addressed and can actually distinguish different source sets (added on review — an earlier draft made `corpus_id` a static label that couldn't); add UUIDv4 generation for `claim_id`/`passage_id`/`audit_id` alongside it or in a small new `src/lib/audit-identifiers.ts` if UUID generation doesn't belong in `hash.ts` — per research.md §2
  — Done. Both hash functions added to `hash.ts` (share a private `canonicalizeSources` helper); UUID generation went into the new `src/lib/audit-identifiers.ts` as suggested. Added `tests/unit/lib/audit-hash.test.ts` (4 tests, not required by this task but a cheap, high-value regression guard on the exact invariant the last review's `corpus_id` fix depends on — determinism + content-addressing). All passing.
- [x] T007 [P] Implement `src/numbers/normalize.ts` — unit/scale/currency/period parsing to canonical form, per research.md §4's fixture-matching shape
  — Done. `NumericFact`/`NormalizedFact` types match the golden set's fixture shape exactly. Handles accounting-parens notation (`"(1)"` → `-1`, num-015) and basis-points↔percent conversion (num-009); `percentage_points` deliberately kept its own unit family, never merged with `percent` (num-008).
- [x] T008 Implement `src/numbers/compare.ts` — comparability decision (same subject/measure/period/scope required) and equality decision, per D018 §2.3; depends on T007
  — Done. Comparability checked in order: unresolved unit → unit family mismatch → period mismatch → scope mismatch → currency conversion (via a source-provided `fx_rate_to_usd` when currencies differ). Equality uses an absolute tolerance for hedged claims (documented as a defensible default, not a derived constant, matching D018 §4.1's 0.5-weight precedent) and a relative tolerance otherwise (covers legitimate float rounding from scale/currency conversion without masking real mismatches).
- [x] T009 [P] Unit tests for T007+T008 against `numbers-golden-set.json`'s comparability cases (`num-001` through `num-009`, `num-013` through `num-016`, `num-020` — every case that isn't a `derived_op`) in `tests/unit/numbers/compare.test.ts` — write first, confirm they fail before T007/T008 exist
  — Done. Confirmed the test failed first (module-not-found) before T007/T008 existed, per TDD. 16 tests: the 14 comparability cases individually, a count assertion (exactly 14 non-`derived_op` cases), and the golden set's own stated aggregate pass bar (comparable=false always implies equal=null) as its own explicit assertion. All passing.
- [x] T010 Register EXTRACT and VERIFY prompt entries (placeholder content) in `src/prompts/registry.ts`, confirming the existing lookup mechanism needs no changes (research.md §3) — real prompt text is written in US1
  — Done. Added `"audit-extract"`/`"audit-verify"` to the `PromptTemplate` union and two placeholder `system.json` files (real text is T014/T016's job); no change to the registry's lookup mechanism itself, only new entries, per research.md §3. Added `getAuditVersion(stage)` since EXTRACT/VERIFY version independently (`prompt_revision_extract`/`_verify`), unlike reflection's single shared `getVersion()`.

**Checkpoint**: Foundation ready — comparability logic and identifiers exist; user story implementation can begin. **Verified**: full suite (`npx vitest run`) — 41 files, 408 tests, 0 failures; `npx tsc --noEmit` clean.

---

## Phase 3: User Story 1 - Run an audit and get grounded verdicts back (Priority: P1) 🎯 MVP

**Goal**: Submit output text + sources, get back every checkable claim with a verdict and supporting/disputing evidence.

**Independent Test**: Run the EXTRACT and VERIFY golden sets end to end and confirm claim extraction and verdict assignment match their pass bars, independent of any scoring or identity/versioning behavior.

### Tests for User Story 1 ⚠️

- [ ] T011 [P] [US1] Integration test: EXTRACT stage against all 11 `extract-golden-set.json` scenarios (recall ≥0.90, precision ≥0.85, zero `excluded_content` leaks; scenario 11 added on review specifically to cover the dedup edge case) in `tests/integration/audit-extract.test.ts` — write first, confirm it fails
- [ ] T012 [P] [US1] Integration test: VERIFY stage against all 15 `verify-golden-set.json` pairs (≥14/15 expected verdicts, zero false "contradicted" on period/scale/scope-only mismatches, **and** `synthesized` matches `expected_synthesized` where the golden case specifies it — e.g. `verify-011` — added on review; verdict-string-only assertions let a service that never sets `synthesized: true` pass silently, breaking FR-018) in `tests/integration/audit-verify.test.ts` — write first, confirm it fails
- [ ] T013 [P] [US1] Contract test: POST /audit request validation (missing `output_text`, malformed `sources[]` → 400) in `tests/unit/contracts/audit.schemas.test.ts`

### Implementation for User Story 1

- [ ] T014 [US1] Write EXTRACT prompt content (full text, `docs/b2b/context-prompt-b2b-transformation.md` §4) into `src/prompts/audit/extract/`
- [ ] T015 [US1] Implement `extract.service.ts` — call EXTRACT, assign `claim_id` (T006), enforce excerpt-is-verbatim-substring-of-output_text (data-model.md Claim validation), route malformed vs. injection-suspected responses per research.md §7; read `options.maxClaims` from the request and pass it to the EXTRACT prompt call, and persist the prompt's `truncated` flag onto the Audit record rather than dropping it (FR-019 — the prompt text already asks for this per T014, but nothing currently reads the response's `truncated` field back out)
- [ ] T016 [US1] Write VERIFY prompt content into `src/prompts/audit/verify/`, starting from the frozen reference text (§5) but **applying four corrections found on review — do not copy §5 verbatim**: (1) `contradicted`'s comparability list is "subject, measure, and period" in §5 — add **scope**, per D018 §2.3 (canonical, supersedes §5) and the `verify-009` scope-trap golden case, which the unmodified §5 rule would get wrong; (2) the confidence instruction has no prohibition on using `retrieval_score` (which the model does see, in the PASSAGES section) — add "confidence reflects your certainty in this verdict given the passages' content, never the passages' retrieval score" (FR-020); (3) the output example's `source_refs: ["doc1:p14"]` is a doc:location string — this pipeline's `source_refs` are `passage_id` UUIDs (data-model.md, T017's assignment) — fix the example so an implementer copying it doesn't produce an incompatible format; (4) add the cross-claim independence instruction research.md §6 identifies as missing
- [ ] T017 [US1] Implement `src/rag/corpus-client.ts` — naive lexical retrieval over the request's own `sources[]` (research.md §1, corrected design — no fixture-reference field), assigning `passage_id`; record `passages_retrieved_count` per claim (data-model.md, FR-009) even when it's zero; **set `retrieval_status = "error"` explicitly when the retrieval call itself throws (timeout, unexpected exception) — never catch-and-fall-through to `passages_retrieved_count = 0`** (added on review: an error silently collapsing to "found zero" is indistinguishable from a genuine empty result, which breaks the spec's own edge case distinguishing "sources are silent" from "the lookup didn't happen"); **populate `ClaimPassage` rows** (`claim_id`, `passage_id`, `retrieval_rank`, `retrieval_score` for *this* claim's query, `selected_for_verification`) rather than a bare passage list — added on review, this is what makes retrieval provenance reconstructable per claim instead of only recording the final cited subset
- [ ] T018 [US1] Implement `verify.service.ts` — batch 5–10 claims/call grouped by shared source document (research.md §6, no cross-claim influence within a batch), call VERIFY, consume `compare.ts` (T008) for the comparability check before allowing a `contradicted` verdict
- [ ] T018a [P] [US1] Unit test: `Verdict.confidence` is only ever assigned from VERIFY's own output and is never computed from, blended with, or falls back to any `SourcePassage.retrieval_score` (FR-020, D018 §2.3/A6) — in `tests/unit/orchestrators/audit/confidence-separation.test.ts`, write first, confirm it fails before T018 exists
- [ ] T019 [US1] Implement `gate.service.ts` (verdict-gating portion only — confidence-threshold-to-`unverifiable`, `gated_candidates` logging, `rates.findings_count`/`gated_out_count`); score-summary computation is US2's addition, not built here; **enforce the retrieval-failure gate rule** (added on review, data-model.md) — a claim with `retrieval_status = "error"` resolves to `unverifiable`, never `unsupported`, so an infrastructure failure can never present itself as "sources were checked and found silent"
- [ ] T020 [US1] Implement `audit.service.ts` — orchestrates EXTRACT→RETRIEVE→VERIFY→GATE, assigns `audit_id`
- [ ] T021 [US1] Implement `routes/audit.ts` — `POST /audit` returns `202 { audit_id }`, enqueues the Inngest job; server stamps `mode: "audit"` on the internal request before it reaches the orchestrator, client never supplies it (D018 §1, resolved on review); confirm `routes/reflection.ts` is untouched
- [ ] T021a [US1] **Added on review — closes a real gap, not a nice-to-have**: implement `GET /audit/:audit_id` in `routes/audit.ts` — `200` + full Result when `status = "complete"`; `200` + `{ audit_id, status: "failed", failed_stage, error_summary }` when `status = "failed"` (200 because the *read* succeeded, not 4xx/5xx); `202` + `Retry-After: 5` header when `status = "running"`; `404` for an unknown `audit_id`. Reads persisted records only — never recomputes a result (append-only rule). Without this task, `POST /audit` has no way to ever return its result to a caller.
- [ ] T021b [P] [US1] Integration test for T021a: submit via `POST /audit`, poll `GET /audit/:audit_id` until `200`, assert the Result contains claims/verdicts/evidence/scores; assert `202` immediately after submission with `Retry-After` present; assert `404` for a random UUID. (Does **not** re-test that identical input produces two distinct `audit_id`s — that's already `T031`'s job in Phase 5/US3; duplicating it here would test the same invariant twice for no added coverage.)
- [ ] T022 [US1] Implement `jobs/audit-run.ts` — Inngest job wrapping `audit.service.ts`, parallel to `jobs/eval-run.ts`; on an unhandled failure in any stage, persist `status: "failed"`, `failed_stage`, `error_summary` on the Audit record rather than leaving it stuck at `running` forever
- [ ] T023 [US1] Wire the injection-guard hard-stop path (research.md §7 / FR-021) as a distinct branch from the existing D004 repair-pipeline call — a suspected-injection schema failure must never reach repair

**Checkpoint**: User Story 1 is fully functional — an audit produces `claims[]` with verdicts, independently testable against both golden sets, with no scoring or idempotency work yet.

---

## Phase 4: User Story 2 - Trust the numbers without doing the arithmetic myself (Priority: P2)

**Goal**: Every derived number and the overall groundedness figure computed deterministically in code, always disclosed with its underlying counts.

**Independent Test**: Given US1's completed verdict counts, confirm the score summary is deterministic, matches hand-computed fixtures, and is never returned without its disclosure companions (counts, strict rate, `n`).

### Tests for User Story 2 ⚠️

- [ ] T024 [P] [US2] Unit tests for `src/numbers/derive.ts` against `numbers-golden-set.json`'s derived-arithmetic cases (`num-010`, `011`, `012`, `017`, `018`, `019`) in `tests/unit/numbers/derive.test.ts` — write first, confirm failure
- [ ] T025 [P] [US2] Unit tests for the score computation against D018 §4.1's worked example (20 S / 10 P / 0 U / 0 C → groundedness 83, strict 67%) **plus the zero-denominator case** (`Eligible = 0` → all five rates `null`, `insufficient_eligible_claims: true`, no exception thrown — added on review) in `tests/unit/orchestrators/audit/gate-scores.test.ts` — write first, confirm failure

### Implementation for User Story 2

- [ ] T026 [US2] Implement `src/numbers/derive.ts` — growth-rate/sum/share arithmetic in code, never in a prompt (research.md §4)
- [ ] T027 [US2] Extend `gate.service.ts` to compute the full `scores` block (`grounded_rate`, `groundedness_score`, `strict_supported_rate`, `contradiction_rate`, `unsupported_rate`, `retrieval_success_rate`, `retrieval_coverage`, `avg_evidence_quality`, `synthesized_count`, `counts`, `eligible`, `insufficient_eligible_claims`) per D018 §4.1–§4.2 — depends on T019, T026; **implement data-model.md's zero-denominator guard** (`Eligible = 0` → the five rate fields are `null` and `insufficient_eligible_claims: true`, never `NaN`; `avg_evidence_quality` is `null` when zero claims have `retrieval_coverage`, distinct from `retrieval_coverage = 0` which is a valid number); **`retrieval_success_rate`/`retrieval_coverage` replace the single `evidence_coverage` field from an earlier draft** (added on review — that field was defined two contradictory ways across `data-model.md`'s Claim and Score Summary sections; the two replacements answer the two different questions "did retrieval run" and "did retrieval find anything" instead of conflating them)
- [ ] T028 [US2] Implement the `low_decisiveness` flag (`X/(S+P+U+C+X) > 0.20`) in `gate.service.ts` per D018 §4.1's exclusion tripwire
- [ ] T029 [US2] Propagate the per-claim `synthesized` flag from `verify.service.ts` through to the response (D018 §4.3 rule 3) — not folded into verdict weight; compute `scores.synthesized_count` in `gate.service.ts` as the aggregate (added on review — D018 §4.3 rule 3 already requires per-claim visibility for "the known hallucination-adjacent zone," but without an aggregate a buyer has to count it by hand across every claim)
- [ ] T030 [US2] Ensure the `POST /audit` result always returns `scores` together with `counts`/`strict_supported_rate`/`eligible` in the same object — never a headline-only response (contracts/audit-endpoint.md)

**Checkpoint**: User Stories 1 + 2 — verdicts plus disclosed, recomputable business metrics, both independently testable.

---

## Phase 5: User Story 3 - Re-run an audit and trust what comes back (Priority: P3)

**Goal**: Stable identity for every claim/passage/audit; safe, traceable re-runs; full versioning on every completed audit.

**Independent Test**: Submit identical input twice and confirm two distinct, linked audits; confirm claim/passage references never depend on array position; confirm every completed audit states the exact versions in effect.

### Tests for User Story 3 ⚠️

- [ ] T031 [P] [US3] Integration test: submitting identical input twice produces two distinct `audit_id`s sharing the same `input_ref` in `tests/integration/audit-idempotency.test.ts` — write first, confirm failure
- [ ] T032 [P] [US3] Unit test: claim/passage lookups by `source_refs`/`claim_id` survive array reordering (no position-dependent access anywhere in the read path) in `tests/unit/orchestrators/audit/stable-ids.test.ts` — write first, confirm failure

### Implementation for User Story 3

- [ ] T033 [US3] Compute and store `input_ref` (SHA-256 of the normalized input triple, T006) at `audit.service.ts` entry, on the `Audit` record
- [ ] T034 [US3] Populate the full `meta` versioning surface on every completed audit — `prompt_revision` (extract/verify separately), `model_revision` (per stage), `corpus_id`, `retrieval_provider` (split from a single `corpus_ref` on review — see data-model.md), `threshold`, `pipeline_code_version` — per data-model.md's Audit entity; add a test asserting zero null fields across a small batch of completed audits (SC-004's "100% of runs" claim needs a test that actually samples more than one run, not just a single hand-checked example)
- [ ] T035 [US3] Enforce audit immutability post-completion — no update path once `status = "complete"` — at the persistence layer, not just by convention
- [ ] T036 [US3] Audit the US1 implementation for any array-position-dependent lookup that slipped in (routes, services, response construction) and fix or add a regression test if found

**Checkpoint**: All three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T037 [P] Run the existing consumer evaluation suites (`evaluations/golden/reflection/`, `evaluations/no_bias/reflection/`) and confirm no regression (SC-007) — verification task, no code change expected unless a regression is found
- [ ] T038 [P] Document the `numbers/` unit-test convention (distinct from `runEval`/`runDataset`) in `docs/eval-runners.md`, per D018 §4.3 rule 5
- [ ] T039 Run `quickstart.md` end to end against a live (non-test) instance
- [ ] T040 [P] Add per-audit token/call cost telemetry to `audit.service.ts` (change-plan gap #4, D018 §2 Consequences) — nice-to-have, not blocking MVP; flagged so it doesn't get forgotten before the first real customer engagement

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup. **Blocks all user stories** — both US1 (VERIFY needs `compare.ts` for correct verdicts) and US2 (scores need the same comparability logic) depend on it directly, not just US1.
- **User Story 1 (Phase 3)**: Depends on Foundational only.
- **User Story 2 (Phase 4)**: Depends on Foundational + User Story 1 (extends `gate.service.ts` built in T019; needs real verdict counts to score). Not independent of US1 in implementation order, though its acceptance scenarios are independently testable once US1 exists.
- **User Story 3 (Phase 5)**: Depends on Foundational + User Story 1 (needs `audit.service.ts` and completed audits to attach idempotency/versioning to). Independent of US2 — could be built in either order relative to it.
- **Polish (Phase 6)**: Depends on whichever stories are in scope for the current release being complete.

### Within Each User Story

- Tests written first, confirmed failing, per this repo's stated testing convention.
- Prompts before services that call them; services before the endpoint; endpoint before the job wrapper.

### Parallel Opportunities

- T005, T006, T007 (Phase 2) can run in parallel — different files, no interdependency.
- T011, T012, T013, T018a, T021b (US1 tests) can run in parallel.
- T024, T025 (US2 tests) can run in parallel.
- T031, T032 (US3 tests) can run in parallel.
- US2 and US3 implementation can proceed in parallel once US1 is complete (they touch different files — `gate.service.ts`'s score extension vs. `audit.service.ts`'s identity/versioning extension — though both should be reviewed together before merge since both touch the same completed-audit record).

---

## Parallel Example: Foundational Phase

```bash
# Launch T005, T006, T007 together — independent files, no shared dependency:
Task: "Define Zod contracts in src/contracts/audit.schemas.ts"
Task: "Implement stable-ID utilities (UUIDv4 + SHA-256 input_ref)"
Task: "Implement src/numbers/normalize.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) + Phase 2 (Foundational) — comparability logic and identifiers exist.
2. Complete Phase 3 (User Story 1) — an audit produces claims with verdicts.
3. **STOP and VALIDATE**: run both EXTRACT and VERIFY golden sets against the real implementation; confirm pass bars (recall/precision/exclusion-leak for EXTRACT, verdict-match/zero-false-contradiction for VERIFY) before proceeding.
4. This is the first point at which the product's headline claim — "your AI's output, checked against your own documents" — is real, even without a sellable score attached yet.

### Incremental Delivery

1. Setup + Foundational → comparability + identity groundwork ready.
2. User Story 1 → validate against golden sets → this is the pipeline the rest of the product sits on.
3. User Story 2 → validate scores against the D018 §4.1 worked example → the number a customer would actually see.
4. User Story 3 → validate idempotency/versioning → what makes running this repeatedly, across a real engagement, safe.
5. Polish → regression check on the untouched consumer flow (this is the one that proves D018 §1's mode-branching invariant actually held, not just that it was intended).
