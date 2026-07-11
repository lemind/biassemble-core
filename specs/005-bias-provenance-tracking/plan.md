# Implementation Plan: Three-Way Bias Provenance Tracking

**Branch**: `005-bias-provenance-tracking` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-bias-provenance-tracking/spec.md`

**ADR**: [docs/decisions/015-engine-provenance-tracking.md](../../docs/decisions/015-engine-provenance-tracking.md)

## Summary

Record, per detected bias, which upstream signal surfaced it — the engine's vector search, the
engine's local LLM, both engine signals, or the assessment LLM acting alone — and persist the
engine's contribution split by signal plus per-signal confirmation counts, so confirmation-rate per
source becomes queryable. This is pure post-hoc observability: no new model calls, no prompt/context
changes, fire-and-forget writes (D011). Three touch points: (1) `engine-client.ts` extends the
`BiasResult`/`EngineResponse` types with the engine's additive per-bias `source` array and top-level
`llm_*`/`*_scores` metadata; (2) `assessment.service.ts` + `context-builder.ts` replace the binary
`context_source` with a derived per-bias `engineSources: ("vector"|"llm")[]`, keeping `ragCase` to
disambiguate the empty-array case; (3) `schema.ts` + `comparison-recorder.ts` add `ragVectorList`/
`ragLlmList` and `ragVectorHitFinal`/`ragLlmHitFinal`/`ragBothHitFinal` alongside the existing fields.

## Technical Context

**Language/Version**: TypeScript (Node.js, ESM), per existing `biassemble-core` toolchain

**Primary Dependencies**: Fastify (routes), Drizzle ORM (Postgres schema/migrations), Zod (contract
schemas), Vitest (tests) — all already present; **no new dependencies**

**Storage**: PostgreSQL via Drizzle — the existing `core.retrieval_comparisons` table is extended
additively (new nullable columns); no destructive migration

**Testing**: Vitest — unit tests for `context-builder` provenance derivation and `comparison-recorder`
per-source math; contract test for the extended engine response parse; mock-mode store noop preserved

**Target Platform**: Linux server (Vercel functions / HF Space consumer), same as current deployment

**Project Type**: Single web-service package (`src/` + `tests/`)

**Performance Goals**: No change — provenance is derived from data already in hand; write path stays
fire-and-forget and off the response critical path

**Constraints**: No new LLM calls (D001 unaffected); no change to assessment prompt/context (D015
non-goal); comparison write must never block or fail the response (D011); all engine-response and
schema additions must be additive/back-compatible (contract v3 is additive-only)

**Scale/Scope**: ~5 source files touched + 1 Drizzle migration; catalogue expansion (38→200+ biases)
and engine local-LLM precision tuning are explicitly OUT of scope

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is an unpopulated template — no ratified
principles or gates are defined. There are therefore no constitutional gates to evaluate. The feature
nonetheless self-imposes the relevant existing ADR constraints as gates: **no new LLM calls** (D001),
**fire-and-forget observability** (D011), **additive-only engine contract consumption** (D014/v3),
**observability-not-ranking** (D015 non-goal). All are satisfied by the design below (derived tagging,
try/catch write, additive fields, tags computed after the model call). **PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/005-bias-provenance-tracking/
├── plan.md              # This file
├── research.md          # Phase 0 output — resolves the contract-shape discrepancy
├── data-model.md        # Phase 1 output — provenance entity + comparison record delta
├── quickstart.md        # Phase 1 output — how to verify locally
├── contracts/
│   └── engine-response-v3.md   # Core's consumed shape of the engine response
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── rag/
│   ├── engine-client.ts        # (1) extend BiasResult.source[] + EngineResponse llm_* metadata + validator
│   └── context-builder.ts      # (2a) surface per-bias engineSources map alongside retrievedIds
├── orchestrators/reflection/
│   └── assessment.service.ts   # (2b) derive engineSources per bias; thread source map into fullResult
├── contracts/
│   └── reflection.schemas.ts   # (2c) replace context_source enum with engineSources[] + keep ragCase
├── db/
│   └── schema.ts               # (3a) add ragVectorList/ragLlmList + per-source hit counts columns
├── observability/
│   └── comparison-recorder.ts  # (3b) compute per-source lists + confirmation counts
├── persistence/
│   ├── ports.ts                # (3c) extend RetrievalComparisonStore.record() param shape
│   └── <drizzle store>.ts      # (3d) map new fields through to the table
└── routes/
    └── reflection.ts           # (3e) pass the engine source map into recordComparison()

drizzle/                        # (3f) new additive migration for the extra columns

tests/
├── unit/                       # context-builder provenance + comparison-recorder per-source math
└── contract/                   # engine-response parse with/without source
```

**Structure Decision**: Single existing package; changes are localized edits to the five files named
in the ADR plus their immediate collaborators (Zod contract, persistence port + Drizzle store, route
wiring, migration). No new modules or architectural layers are introduced.

## Key Design Decisions (grounded)

1. **`source` is an ARRAY in core, per the ADR — not the scalar the on-disk contract still shows.**
   The engine v3 contract file documents `source: "vector"|"llm"|"both"` (scalar), but the updated
   ADR D015 mandates `("vector"|"llm")[]` with `["vector","llm"]` replacing `"both"`. The ADR is the
   newer authority. Core's parser will accept the array form and **defensively normalize** a legacy
   scalar `"both"`/`"vector"`/`"llm"` to the array form, so it is correct regardless of which engine
   build responds. This discrepancy is documented in research.md and flagged for an engine-side
   contract update (out of scope for core here). See [research.md](./research.md).

2. **Provenance derivation stays in `context-builder.ts`.** `buildBiasContext` already owns the
   engine response and produces `retrievedIds`; it will additionally produce an `engineSources` map
   (`Map<normalizedId, ("vector"|"llm")[]>`) built from each bias's `source`, falling back to
   `["vector"]` (retrieval-signal inference) when `source` is absent and `retrieval_score > 0`. Ids
   are normalized underscore→hyphen exactly as `retrievedIds` already are (D014).

3. **`assessment.service.ts` computes each bias's `engineSources` as a lookup**, not a new call:
   `engineSourcesMap.get(result.id) ?? []`. `[]` + `ragCase === "retrieved"` = assessment-LLM-alone;
   `[]` + `ragCase !== "retrieved"` = unknown (engine did not run). The derivation lives at L371
   **inside `callProvider()`**, which today receives only `ragCase`/`retrievedIds` — so `callProvider`'s
   signature must gain an `engineSourcesMap` parameter threaded from both call sites (review finding 1).
   The `[]` disambiguation stays **request-level via `ragCase`/stored `ragStatus`** and is NOT added to
   the API response (review finding 3, decided: storage-only).

4. **Comparison split is by NAME, built from the engine response** (review finding 2 — critical):
   `ragList`/`finalList` are bias **names** and `ragHitFinal` intersects them by name, so the new
   `ragVectorList`/`ragLlmList` must also be names — `biases.filter(b => src(b).includes("vector"))`
   `.map(b => b.name)` (same for `"llm"`), where `src(b)` is the normalized `source` with the
   `retrieval_score>0` ⇒ `["vector"]` fallback. Do NOT derive these from the hyphenated-id
   `engineSources` map, or every `*HitFinal` count is zero. A both-bias appears in both lists;
   `ragBothHitFinal` counts both-source names reaching `finalList`. Existing counts unchanged; write
   stays inside the current try/catch fire-and-forget path.

5. **Schema migration is additive and nullable.** New columns default to null / empty so historical
   rows and non-`llm_union` runs remain valid; `ragList` is retained for back-compat reads.

6. **`context_source` is replaced outright** (review finding 4, decided per ADR D015 Decision 2). The
   only in-repo reference besides source is the stale build bundle `api/index.js` (not a hand-edited
   consumer); a grep-verify task guards against an unknown external reader before removal.

## Complexity Tracking

No constitutional violations. No entries required.
