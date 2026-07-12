# Phase 0 Research: Engine Provenance Tracking

## R1 — Where does "both" actually need to disappear from?

**Decision**: "Both" is eliminated as a *stored or compared value* at three layers, not one:
(a) the per-bias `source` field itself (already correct in the prior attempt — array, not scalar),
(b) the per-run persisted breakdown (the actual bug in the prior attempt — `ragBothHitFinal` as a
dedicated column), and (c) the existing-but-unrelated `context_source` enum in
`reflection.schemas.ts`, which independently grew a reserved `"both"` value during Stage 005 async-RAG
work, unconnected to either D017 draft.

**Rationale**: Grepping the current codebase (`grep -rn "both" src/`) turns up exactly one live
occurrence: the `context_source` enum's reserved-but-unemitted `"both"`. Fixing only the persisted
per-run breakdown (what the ADR's Decision 3 addresses) would leave this dead enum value sitting in
the API contract, which is precisely the kind of drift that produced the original incident (an ADR
that says one thing, a schema that says another). FR-004/FR-012 in the spec make removing it explicit
rather than assumed.

**Alternatives considered**: Leave `context_source`'s `"both"` alone since it's "not emitted yet."
Rejected — it's exactly the kind of reserved-but-inconsistent scaffolding that caused this rebuild;
leaving it means a future contributor might someday emit it, recreating the same problem.

## R2 — Which module owns provenance derivation: `context-builder.ts` or `workspace-builder.ts`?

**Decision**: `workspace-builder.ts`. `context-builder.ts` (and its `buildBiasContext`/`RagCase`
export) is only reachable today from `runStoryOnlyAssessment`'s hardcoded
`buildBiasContext({ status: "unavailable" }, ...)` call — a roster-only stub that never receives a
real engine response. `runFullAssessment`, the only path that ever has a populated `EngineResponse`
to work with, uses `buildBiasWorkspace` from `workspace-builder.ts`. Building `engineSources` in
`context-builder.ts` would attach the feature to dead code.

**Rationale**: Confirmed by direct read of `assessment.service.ts` on the current branch — `import {
buildBiasContext, type RagCase } from "../../rag/context-builder"` is used only for the `RagCase`
type and the roster-only stub; `import { buildBiasWorkspace, renderWorkspaceToPrompt } from
"../../rag/workspace-builder"` is the real retrieval-consumption path.

## R3 — `RagCase` vs. `WorkspaceCase`: does `roster_fallback` still occur?

**Decision**: Treat `roster_fallback` as effectively unreachable through the current architecture,
without removing it from the type. `RagCase` (from `context-builder.ts`, still used as the return
type of `runFullAssessment` and the `ragStatus` column value) has three values:
`"retrieved" | "roster_fallback" | "unavailable"`. `WorkspaceCase` (from `workspace-builder.ts`,
what `buildBiasWorkspace` actually produces) has only two: `"retrieved" | "unavailable"` —
`buildBiasWorkspace` collapses the old "engine returned all-zero scores" case into `"unavailable"`
rather than a distinct `"roster_fallback"`. Since `WorkspaceCase` is a subtype of `RagCase`, the
assignment `ragCase = workspace.workspaceCase` in `runFullAssessment` type-checks, but `ragCase` can
in practice only ever be `"retrieved"` or `"unavailable"` on that path today.

**Rationale**: This affects Decision 2's "two `[]` meanings" disambiguation described in the ADR: in
the current architecture there are really only two request-level states to disambiguate against
(`retrieved` / `unavailable`), not three. The spec's User Story 1 / FR-005 language ("no retrieval
result was available for this request") is written to match this reality rather than the ADR's
three-way `RagCase` framing, without requiring a `RagCase`/`WorkspaceCase` type unification — that
would be a separate, larger refactor outside this feature's scope.

**Alternatives considered**: Unify `RagCase`/`WorkspaceCase` into one type as part of this feature.
Rejected — out of scope per the spec's assumptions ("changing how or when retrieval happens is out of
scope"); the type mismatch is pre-existing and orthogonal to provenance tracking.

## R4 — `callProvider` signature gap (carried forward from the reverted attempt)

**Decision**: `callProvider`'s signature must be extended with the `engineSources` map, threaded from
both `runStoryOnlyAssessment` and `runFullAssessment`. This is not optional/deferred — without it the
per-bias lookup inside `callProvider` has no map to read from.

**Rationale**: Confirmed by reading the current `callProvider` signature — it takes `ragCase` and
`retrievedIds` as its only RAG-related parameters, both already threaded from the two call sites the
same way the new map must be. This is a known, previously-identified gap (caught in review on the
reverted attempt at this same feature), recorded here so the task breakdown builds it in from the
start.

## R5 — Persisted breakdown key format: name or id?

**Decision**: Name-keyed, matching `ragList`/`finalList`/`llmList` (all `string[]` of bias display
names, e.g. `"Confirmation Bias"`), not `retrievedIds`/`engineSources`'s hyphenated catalog ids
(`"confirmation-bias"`) or the engine's raw underscore ids (`"confirmation_bias"`). Three id formats
exist in this codebase across different layers; mixing them in the same comparison breaks the
`hitFinal` intersection math (a list in one format never matches a list in another).

**Rationale**: `comparison-recorder.ts`'s existing `ragHitFinal`/`llmHitFinal` computation intersects
`ragList`/`llmListRaw`/`finalList`, all built as `.map(b => b.name)`. The new per-source breakdown
must be built the same way — from the engine response's biases, by `.name` — to stay comparable
against `finalList` using the same intersection logic already in place.

## R6 — Migration-snapshot drift

**Decision**: Do not attempt to repair `meta/`'s missing 0006–0008 snapshots as part of this feature;
hand-verify whatever `drizzle-kit generate` produces for the new column before applying it, per the
plan's design decision 7.

**Rationale**: Pre-existing repo-wide issue (confirmed via direct read of `meta/_journal.json`),
unrelated to this feature's scope, and fixing it properly means reconstructing three snapshots by
hand or re-deriving them from live DB state — a separate task with its own risk profile.

## Resolved unknowns

All Technical Context items are known; no `NEEDS CLARIFICATION` markers remain.
