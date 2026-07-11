# Phase 0 Research: Three-Way Bias Provenance Tracking

## R1 — `source` field shape: array (ADR) vs. scalar (on-disk contract)

**Decision**: Core consumes `source` as an **array** `("vector" | "llm")[] | null`, and defensively
normalizes a legacy scalar (`"vector"` / `"llm"` / `"both"`) into the array form on parse.

**Rationale**: The updated ADR D015 (Decision 1) explicitly mandates the array form —
`["vector"]` / `["llm"]` / `["vector","llm"]` — and states it is "an array, **not** a collapsed
`"both"` string, so each contributing engine signal stays individually visible." The engine's
on-disk contract `../biassemble-engine/specs/004-add-llm-model/contracts/retrieve-biases-v3.md` still
documents the earlier scalar form (`source ∈ {"vector","llm","both"}`). The ADR is the more recent
authority. Normalizing defensively means core parses correctly whether it receives an array
(post-ADR engine build) or a scalar (current contract text), eliminating a deploy-ordering hazard.

**Normalization rule**:
- `["vector","llm"]` / `["vector"]` / `["llm"]` → used as-is (dedup, keep only known values)
- `"both"` → `["vector","llm"]`
- `"vector"` → `["vector"]`, `"llm"` → `["llm"]`
- `null` / absent / unknown value → `null` (triggers the `retrieval_score` fallback downstream)

**Alternatives considered**:
- *Follow the contract literally (scalar)*: rejected — contradicts the ADR's explicit array decision
  and loses per-signal separability the whole feature depends on.
- *Require the engine to ship arrays first, hard-fail on scalar*: rejected — brittle across deploy
  ordering; the feature is additive/observability and must degrade gracefully.

**Follow-up (out of scope here)**: File an engine-side update so
`retrieve-biases-v3.md` documents `source` as an array. Tracked as an engine task, not a core task.

## R2 — Where provenance is derived

**Decision**: Derive the per-bias `engineSources` map in `context-builder.ts` (`buildBiasContext`),
returned alongside the existing `retrievedIds`; consume it in `assessment.service.ts` by lookup.

**Rationale**: `buildBiasContext` already owns the raw engine response and already normalizes ids
(underscore→hyphen, D014) to produce `retrievedIds`. Building the source map in the same place keeps
id normalization in one location and avoids passing the raw engine response deeper into the service.
The assessment service then only does `map.get(id) ?? []`, keeping the derivation a pure lookup with
no model call (FR-006).

**Alternatives considered**:
- *Derive in `assessment.service.ts` directly from the engine response*: rejected — would duplicate
  id normalization and spread engine-shape knowledge into the orchestrator.

## R3 — Fallback interaction with the existing `retrieval_score=0.0` rule

**Decision**: When `source` is null/absent for a bias that has `retrieval_score > 0`, treat it as
`["vector"]` (the pre-existing "retrieval found it" inference). Biases with `retrieval_score = 0`
continue to be excluded from the retrieved set entirely (Case B unchanged).

**Rationale**: D015 Decision 1 "Do not" is explicit: keep the `retrieval_score=0.0` fallback because
`vector_only`/`nli_union` responses carry `source: null`. Under those strategies every retrieved bias
came from vector/NLI retrieval, so `["vector"]` is the correct inferred signal. `llm`-only can never
be inferred without the explicit field, which is acceptable — those strategies have no local-LLM
signal to attribute.

## R4 — Empty-`engineSources` disambiguation

**Decision**: Keep `ragCase` on every bias record next to `engineSources`. `engineSources === []`
means "assessment LLM alone" **iff** `ragCase === "retrieved"`; otherwise (`roster_fallback` /
`unavailable`) it means "unknown — engine did not run."

**Rationale**: D015 Decision 2 requires the two `[]` meanings stay separable and explicitly forbids
reading `[]` as assessment-LLM-alone when `ragCase !== "retrieved"`. `ragCase` is already threaded
through `assessment.service.ts` and stored as `ragStatus` on the comparison record, so no new plumbing
is needed for the request-level signal.

## R5 — Schema migration strategy

**Decision**: Additive, nullable columns on `core.retrieval_comparisons` via a new Drizzle migration;
retain `ragList` and all existing columns unchanged.

**Rationale**: D011/D015 require backward read compatibility and a non-blocking write. Nullable
additive columns keep historical rows and non-`llm_union` runs valid (their per-source lists are
simply empty/null). No backfill and no data rewrite — consistent with "do not add an LLM call to
backfill" (D015 Decision 3 "Do not").

**Alternatives considered**:
- *Replace `ragList` with the split lists*: rejected — breaks existing readers; ADR says keep
  `ragList` for back-compat.

## Resolved unknowns

All Technical Context items are known; no `NEEDS CLARIFICATION` markers remain. The only external
inconsistency (R1) is resolved in core's favor via defensive normalization, with an engine-side
follow-up noted as out of scope.
