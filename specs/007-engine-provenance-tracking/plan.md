# Implementation Plan: Engine Provenance Tracking

**Branch**: `007-engine-provenance-tracking` | **Date**: 2026-07-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-engine-provenance-tracking/spec.md`

**ADR**: [docs/decisions/017-engine-provenance-tracking.md](../../docs/decisions/017-engine-provenance-tracking.md)
(revision of an earlier draft that hardcoded a fixed two-source design — see that file's header note)

## Summary

Record, per detected bias, which upstream signal surfaced it — the engine's vector search, the
engine's local LLM, both engine signals, or the assessment LLM acting alone — and persist a
per-source breakdown for each assessment run in a form that stays open-ended (no fixed set of source
names, no dedicated "both" field). Pure post-hoc observability: no new model calls, no prompt/context
changes, fire-and-forget writes (D011). Grounded in the **current** async-RAG architecture (Stage
005): retrieval happens as a background job; `runFullAssessment` reconstructs a `BiasWorkspace` via
`src/rag/workspace-builder.ts` from whatever landed in `runs.rag_result` by the time it runs. The
now-vestigial `src/rag/context-builder.ts` (superseded by `workspace-builder.ts`) is out of scope
except for its `RagCase` type, which the persistence layer still uses for `rag_status`.

**Also in scope (explicit addition)**: fixing the 16 pre-existing, unrelated test failures present on
this branch before any D017 work starts — see "Pre-Existing Test Debt" below. This was folded into
this plan on request rather than left as a snapshot-gate workaround, since it's cheap relative to the
risk of building on an unverified baseline for the rest of this work.

## Pre-Existing Test Debt (in scope)

`pnpm vitest run` on a clean `007-engine-provenance-tracking` checkout, before any code in this plan
is touched, fails 16 of 357 tests — all unrelated to engine provenance. Each was root-caused against
the actual source (not assumed) before being added here:

| Tests | Root cause | Fix |
|---|---|---|
| `tests/unit/catalog/normalize.test.ts` (9) | Test asserts an exact-id-match + `confidence` field `normalizeBiasName` was deliberately simplified away from (commit `a51a75b`); nothing in the codebase consumes either. | Update the test to match the current `{name, id?}` contract — no implementation change. |
| `tests/unit/contracts/reflection.schemas.test.ts` (2) | Tests assert `prompt_version` is required; commit `4b27bb8` made it intentionally optional ("LLM never generates it," consistent with ADR D003 — orchestrator stamps it post-parse). | Remove/replace the two stale "should reject missing prompt_version" assertions. |
| `src/evaluation/compute-evaluation-metrics.ts` (1) | Real bug: `isFalsePositive` does `(b.confidence ?? 0) > threshold` — the test's own name says missing confidence should default to `1.0`, not `0`; as written, an unscored bias in a no-bias story is silently exempted from the false-positive count instead of flagged. | One-line fix: `?? 0` → `?? 1`. |
| `tests/integration/assessment.test.ts` T505 + `tests/integration/two-phase-session.test.ts` Phase 1 (2) | Same root cause: `src/parsers/repair.ts`'s `partialParseObject` substitutes `null` for any field missing after a failed strict parse; `assessment.service.ts`'s T205 consistency check (~L418) only tests `=== undefined`, so it never fires on the repair path and `null` reaches the response. | Widen the check to catch `null` too (`== null` or explicit `undefined \|\| null`). |
| `tests/integration/two-phase-session.test.ts` Phase 2 (1) | Hardcoded expected `prompt_version: "1.0.0"`; actual is `"1.3.0"` (bumped since the test was written, per `src/prompts/reflection/assessment/system.json`). | Read the expected value dynamically via the test's `PromptRegistry.getVersion()` instead of a literal, so it can't go stale on the next bump. |
| `tests/integration/inngest-eval.test.ts` T510 (1) | Mock's substring trigger `"asking 2-5"` no longer matches the current baked `question-batch/system.json` content (`"Generate 2–5 contextual follow-up questions"` — different wording/dash). | Update the trigger substring to match current content. |

**Why fix rather than route around**: this plan's own snapshot-gate approach elsewhere in this
session (used for the earlier, reverted attempt at this feature) treats a known-red set as an
acceptable baseline to build on top of. That's reasonable when the cause is unknown or out of budget;
here, every one of the 16 has a concrete, verified, low-risk fix, so leaving them red would just be
carrying debt forward for no reason.

**Scope boundary**: these fixes are orthogonal to D017 and touch none of the files US1–US3 touch,
except `assessment.service.ts` (the `noBiasDetected` fix is at a different line than anything US1/US2
edit there — see tasks.md for exact placement to avoid overlap).

## Technical Context

**Language/Version**: TypeScript (Node.js, ESM), existing `biassemble-core` toolchain

**Primary Dependencies**: Fastify, Drizzle ORM (Postgres), Zod, Vitest, Inngest — all present; no new
dependencies

**Storage**: PostgreSQL via Drizzle — `core.retrieval_comparisons` gains exactly one new nullable
column; no destructive change

**Testing**: Vitest — unit tests for `workspace-builder` provenance derivation and
`comparison-recorder` generic breakdown math; mock-mode store noop preserved

**Target Platform**: Vercel Functions (serverless) + Inngest background jobs, same as current

**Project Type**: Single web-service package (`src/` + `tests/`)

**Performance Goals**: No change — provenance is derived from data already fetched by the background
job; write path stays fire-and-forget, off the response critical path

**Constraints**: No new LLM calls (D001); no change to assessment prompt/context (D017 non-goal);
comparison write must never block or fail the response (D011); engine-response consumption stays
additive/back-compatible; **no fixed-arity storage** — this is a hard constraint from the incident
that produced D017's revision, not a style preference

**Scale/Scope**: ~9 source files touched + 1 additive migration; a prior unmerged attempt's 5 orphan
columns on live Supabase have already been dropped (confirmed via direct query, this session) —
`schema.ts` and the live DB are back in sync as the starting point for this plan

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unpopulated template — no ratified project-wide gates exist.
This feature self-imposes the relevant ADR constraints as gates: **no new LLM calls** (D001),
**fire-and-forget observability** (D011), **additive-only engine-response consumption**,
**no fixed-arity source storage** (D017 Decision 3, elevated to FR-007/SC-007 in the spec). All are
satisfied by the design below. **PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/007-engine-provenance-tracking/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── engine-response-source.md   # Core's consumed shape of the engine response
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── rag/
│   ├── engine-client.ts        # (1) BiasResult.source[] + EngineResponse llm_* metadata + normalizeSource()
│   └── workspace-builder.ts    # (2) BiasWorkspace.engineSources: Map<hyphenatedId, EngineSource[]>
├── orchestrators/reflection/
│   └── assessment.service.ts   # (2) thread engineSources through callProvider(); derive per-bias tag
├── contracts/
│   └── reflection.schemas.ts   # (2) replace context_source enum with engineSources array
├── db/
│   ├── schema.ts                # (3) add sourceBreakdown/selectionStrategy/llmModel to retrievalComparisons; narrow ragStatus's TS type (no DB-level change — see data-model.md §3)
│   ├── queries.ts               # (3) thread sourceBreakdown through insertRetrievalComparison
│   └── migrations/0009_*.sql    # (3) additive migration — ADD COLUMN only
├── observability/
│   └── comparison-recorder.ts  # (3) compute generic per-source breakdown, no "both" branch
├── persistence/
│   ├── types.ts                 # (3) RetrievalComparisonRecord.sourceBreakdown (nullable)
│   ├── ports.ts                 # (unchanged — Omit<...> already picks up new field)
│   └── retrieval-comparison-store.ts  # (3) map sourceBreakdown through
└── routes/
    └── reflection.ts             # (3) pass sourceBreakdown into recordComparison()

tests/unit/
├── rag/                          # workspace-builder + engine-client provenance tests
└── observability/                # comparison-recorder generic breakdown tests
```

**Structure Decision**: Single existing package; changes are localized to the files named in the ADR
plus their immediate collaborators (Zod contract, persistence chain, route wiring, migration). No new
modules or architectural layers. `context-builder.ts` is explicitly NOT touched — it is dead code
outside this feature's scope (only used for `runStoryOnlyAssessment`'s hardcoded roster-only stub).

## Key Design Decisions (grounded in the current codebase)

1. **`source` is an array in `engine-client.ts`**, with `normalizeSource()` expanding a legacy scalar
   `"both"` into `["vector","llm"]` on parse. `"both"` is never itself a stored or compared value at
   any layer above the parser — it only ever exists transiently as an input spelling to be expanded
   away. This is the load-bearing distinction the previous attempt blurred: Decision 1 kept `"both"`
   out of the *per-bias* representation but Decision 3 (previously) reintroduced it as a *stored
   aggregate* value. This plan keeps it out at every layer.

2. **Provenance derivation lives in `workspace-builder.ts`**, not the vestigial `context-builder.ts`.
   `buildBiasWorkspace` already owns the raw engine response and already normalizes ids
   (underscore→hyphen) to produce `retrievedIds`; it gains a parallel `engineSources` map built the
   same way, with the same `["vector"]` fallback (score>0, source null) as `retrievedIds`'s existing
   cases already imply.

3. **`assessment.service.ts`'s `callProvider` currently has no parameter for this map at all** — it
   only receives `ragCase`/`retrievedIds` from its two callers (`runStoryOnlyAssessment`,
   `runFullAssessment`). The signature must be extended and the map threaded from both call sites, or
   the per-bias lookup inside `callProvider` silently resolves to `[]` for everything. (This exact gap
   was caught in review on a prior, reverted attempt at this feature — flagged here so the task list
   encodes the fix from the start rather than as a post-hoc correction.)

4. **`context_source`'s existing `"both"` enum value is dead code, not a target to preserve.** The
   current schema comment says `"both"` is "reserved for a future merge... not emitted yet" — that
   future is exactly what this feature is. FR-004/FR-012 replace the whole enum with the array; there
   is no migration path for `"both"` because nothing has ever emitted it.

5. **Comparison split is a generic map, built from `workspace.candidates`/`workspace.engineSources`
   by NAME** — not by re-reading the raw `EngineResponse` a second time. `runFullAssessment` already
   has both in hand from `buildBiasWorkspace`; re-deriving the same filter/fallback logic a second
   time in `assessment.service.ts` risks the two copies silently diverging (see data-model.md §4).
   Names match how `ragList`/`finalList` are already keyed, which is what keeps `hitFinal` counts
   meaningful. `comparison-recorder.ts` groups by each candidate's normalized source array, producing
   `Record<sourceName, {list: string[]; hitFinal: number}>`. There is no `vector`/`llm` special-casing
   in the recorder's logic itself — it iterates over whatever keys the input data produces. A
   "confirmed by both" count is a read-time intersection of two entries' lists, computed by a
   consumer of the stored data, never written.

6. **Schema migration adds three nullable columns** (`source_breakdown`, `selection_strategy`,
   `llm_model`) and narrows one existing column's TypeScript type (`rag_status` → Drizzle
   `{enum:[...]}`, matching 7 other columns already using this pattern in this schema — TS-only, no
   DB-level constraint, no SQL emitted for that part) — nothing destructive. The `selection_strategy`/
   `llm_model` additions are per-run metadata, not per-source
   data; they exist to make the confirmation-rate dataset filterable/splittable (by retrieval mode,
   by model version) without relying on `source_breakdown IS NOT NULL` as a fragile proxy, and without
   reopening the "no fixed-arity" constraint — they're scalar per-run facts, not another place a
   source combination could get hardcoded. The 5 orphan columns from a prior unmerged attempt were
   already dropped directly against live Supabase, out of band, before this plan was written
   (confirmed via direct query; see ADR D017's migration note) — this migration is therefore
   additive-only; it contains no `DROP COLUMN`.

7. **Migration-snapshot drift note (pre-existing, not introduced by this feature)**: `meta/` is
   missing snapshots for 0006, 0007, and 0008 (jumps from `0005_snapshot.json` straight to
   journal-only entries for those three). `pnpm db:generate` will therefore likely emit spurious
   `CREATE TABLE`/duplicate `ADD COLUMN` statements for objects that already exist live. The migration
   task must hand-verify the generated SQL contains only the one new `ADD COLUMN IF NOT EXISTS` before
   it is applied — never apply a generated migration file without reading it first.

## Complexity Tracking

No constitutional violations. No entries required.
