# Implementation Plan: B2B Audit Mode — Claim Pipeline and Business Metrics

**Branch**: `008-b2b` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/008-b2b/spec.md`

## Summary

Wire a second orchestration mode (`mode: "audit"`) into biassemble-core alongside the existing story/reflection mode. Audit mode runs the claim pipeline — EXTRACT → RETRIEVE (stubbed) → VERIFY → GATE — over a submitted `{ output_text, sources[], task }` input, producing per-claim verdicts (supported/partially_supported/unsupported/contradicted/unverifiable) plus a business-facing score summary, all computed deterministically from verdict counts per D018 §4. Technical approach: mirror the existing `reflection/` orchestrator+prompt+contract pattern with a parallel `audit/` pattern, add one new deterministic numeric-normalization module with no LLM in its path, and validate everything against the three golden sets already built in `evaluations/golden/audit/` rather than against a live customer corpus (engine-side retrieval is out of scope per the spec's Assumptions — a stub returning the golden sets' fixed passages stands in for it).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node 22 LTS — same as the rest of this repo, no new runtime.

**Primary Dependencies**: Fastify 5.8 (routes), Zod 4.4 (contracts/schemas), Drizzle ORM 0.40 + Postgres (persistence), Inngest 3.54 (batch job execution), Pino (logging) — all existing dependencies, no new ones added by this feature.

**Storage**: Postgres via Drizzle, new `audit` pg schema per D018 §2.4 (sibling to the existing `core` schema, not nested inside it) — new tables for claims, source passages, audits, and score summaries; no changes to existing `core` schema tables.

**Testing**: Vitest (existing `tests/unit/`, `tests/integration/` convention) plus the three JSON golden sets in `evaluations/golden/audit/` consumed as fixture data, not through the existing `runEval`/`runDataset` harness (that harness scores LLM-output quality; the numeric-normalization layer in this feature has no LLM in its path and gets ordinary unit tests against hand-computed fixtures, per D018 §4.3 rule 5).

**Target Platform**: Same as existing — esbuild bundle → Vercel Functions, no new target.

**Project Type**: Single project (existing Fastify service), no new project — audit mode is additive within the current repo structure, per D018 §1's mode-flag-not-separate-service decision.

**Performance Goals**: Not latency-sensitive — audits run via Inngest batch jobs (D018 §1), not the synchronous request path the existing reflection endpoints optimize for. No new performance target beyond "completes within the batch job's existing timeout envelope."

**Constraints**: Everything in D018 applies as a hard constraint, not a suggestion — mode-branching confined to the orchestration layer (routes → orchestrators → prompt selection) with all lower layers mode-agnostic; append-only pipeline (no stage rewrites a prior stage's output); claim/passage/audit identifiers stable and never inferred from array position; all numeric comparison and derivation in code, never in a prompt; retrieval score never combined with VERIFY confidence.

**Scale/Scope**: Matches the golden sets built for it — 11 EXTRACT scenarios (10 original + 1 dedup case added on review), 15 VERIFY pairs, 20 numeric-normalization pairs (`evaluations/golden/audit/`). Not scoped or tested against a real 40-output customer engagement in this feature; that's the Fintool run, explicitly out of scope per the spec.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` in this repo is still the unfilled template (placeholder principle names, no ratified content) — there is no ratified constitution to check this plan against. Rather than fabricate principles that were never ratified, this plan is checked instead against the two documents that function as this repo's actual governing decisions for this feature: **D018** (the ADR this entire feature implements) and the established house conventions already visible in the codebase (prompt-registry pattern, repair pipeline, eval-runner discipline, `docs/decisions/` D0xx numbering). No violations identified: this plan adds a parallel `audit/` orchestrator+prompt+contract structure beside the existing `reflection/` one (same pattern, not a new one), stores new data in a new pg schema rather than overloading `core`, and introduces no new external dependency. If this repo's constitution is filled in later, this feature should be re-checked against it.

**Re-checked after Phase 1 design**: still holds. The one design change made during review (research.md §1 — retrieval stub takes `sources[]` directly rather than a `corpus_id`-style reference into a hardcoded fixture) reduces surface area rather than adding any; no new violation introduced.

## Project Structure

### Documentation (this feature)

```text
specs/008-b2b/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── audit-endpoint.md
└── tasks.md              # Phase 2 output (/speckit-tasks, not this command)
```

### Source Code (repository root)

**Structure Decision**: Single project (existing Fastify service in `biassemble-core/`). This feature adds files following the exact pattern the existing `reflection/` mode already uses — a parallel `audit/` subfolder wherever `reflection/` has one — rather than introducing a new structural convention.

```text
src/
├── contracts/
│   └── audit.schemas.ts          # NEW — Zod: AuditRequest, Claim, Verdict, Audit, ScoreSummary
├── orchestrators/
│   └── audit/                    # NEW — parallel to orchestrators/reflection/
│       ├── extract.service.ts    # EXTRACT prompt call + claim_id assignment
│       ├── verify.service.ts     # VERIFY prompt call only, batched 5–10/call — does NOT call retrieval itself (corrected on review: an earlier draft described this file as owning "RETRIEVE (stubbed) + VERIFY," which blurs the boundary the separate rag/corpus-client.ts module exists to keep clean, and would make swapping the stub for the real engine call more invasive than it needs to be)
│       ├── gate.service.ts       # threshold gating, rates, score summary (D018 §4)
│       └── audit.service.ts      # orchestrates extract→retrieve(rag/corpus-client.ts)→verify→gate, assigns audit_id — RETRIEVE is a step audit.service.ts calls between extract and verify, not a responsibility of either service
├── prompts/
│   └── audit/                    # NEW — parallel to prompts/reflection/
│       ├── extract/              # EXTRACT prompt template + registry entry
│       └── verify/               # VERIFY prompt template + registry entry
├── numbers/                      # NEW — deterministic normalization, D018 §2.3, zero LLM calls
│   ├── normalize.ts               # unit/scale/currency/period parsing to canonical form
│   ├── compare.ts                 # comparable/equal decision, D018 §2.3 comparability rules
│   └── derive.ts                  # growth-rate/sum/share arithmetic, code-side per D018
├── rag/
│   └── corpus-client.ts           # NEW — stub per spec Assumptions; same shape as future engine POST /retrieve, swappable without touching audit.service.ts
├── routes/
│   └── audit.ts                   # NEW — POST /audit, mirrors routes/reflection.ts's auth/error handling
├── db/
│   ├── schema.ts                  # MODIFIED — add `audit` pg schema: claims, source_passages, audits, score_summaries tables
│   └── queries.ts                 # MODIFIED — audit-schema read/write functions, following existing query patterns
└── jobs/
    └── audit-run.ts               # NEW — Inngest job wrapping audit.service.ts, parallel to jobs/eval-run.ts

tests/
├── unit/
│   ├── numbers/                   # NEW — numbers-golden-set.json cases as hand-computed fixture tests
│   ├── orchestrators/audit/       # NEW — extract/verify/gate unit tests
│   └── contracts/                 # MODIFIED — add audit.schemas.ts validation tests
└── integration/
    ├── audit-extract.test.ts      # NEW — EXTRACT stage against extract-golden-set.json (11 scenarios)
    └── audit-verify.test.ts       # NEW — RETRIEVE(stub)→VERIFY stage against verify-golden-set.json (15 pairs)
```

## Complexity Tracking

*No entries — no constitution violations identified (see Constitution Check above); this plan follows the existing `reflection/` structural pattern rather than introducing a new one, and the one new module (`numbers/`) is justified directly by D018 §2.3's explicit requirement that arithmetic never run inside an LLM prompt.*
