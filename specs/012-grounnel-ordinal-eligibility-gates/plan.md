# Implementation Plan: Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering

**Branch**: `012-grounnel-ordinal-eligibility-gates` | **Date**: 2026-08-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-grounnel-ordinal-eligibility-gates/spec.md`

## Summary

Two independent fixes to the Grounnel fact-checking pipeline, both decided in
[docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md](../../docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md)
(D030) after a live-bug investigation and two rounds of design review:

1. **`applyReasonOrdinalGate`** — a new deterministic gate that catches sequence-position
   contradictions (e.g. a claim about the "first flight" verified against evidence for the "fourth
   flight") by reading VERIFY's own natural-language `reason` field, not the raw evidence text.
   Mirrors `applyReasonYearGate`'s (T069) proven architecture — negation-aware, `contradicted`-only,
   abstain-by-default — but uses claim-anchored ordinal extraction (derive the noun the claim's own
   ordinal attaches to, e.g. "flight," then look for a competing ordinal on that same anchor in
   `reason`) instead of a global role-noun whitelist, which is the approach already proven to fail
   twice in this codebase. Built and validated offline against a false-positive test matrix before
   being wired into the production gate chain — a separate, later decision.
2. **`classifyClaimVerifiability`** — a new LLM classification step, running after the existing
   `isOpinionClaim` regex filter (cost optimization — the regex catches what it already reliably
   catches, for free), that recognizes claims not reasonably verifiable through external evidence
   (private personal circumstances, opinions, vague predictions) that the regex structurally cannot
   catch. Uses the claim's source context, not text alone, since distinguishing a private assertion
   from an attributed quote is context-dependent. Conservative: only excludes when its own stated
   `certainty` is "clear"; any uncertainty defaults to normal search/verification. First-person
   phrasing alone is never sufficient grounds for exclusion — "personal" is not synonymous with
   "non-checkable."

Both are additive to the existing 8-gate chain and EXTRACT→search boundary — no existing gate,
prompt, or filter is modified or removed.

## Technical Context

**Language/Version**: TypeScript 5 (strict mode), Node 22 LTS

**Primary Dependencies**: Fastify 5 (HTTP layer, unaffected by this feature), Zod 4 (contracts),
Drizzle ORM (Postgres), existing Gemini provider adapter (`src/providers/`) for the new
`classifyClaimVerifiability` LLM call

**Storage**: PostgreSQL via Supabase — `grounnel` schema. This feature adds one new gate-name/
reason-code value to 4 existing union types; no new tables.

**Testing**: Three distinct layers, not one — conflating them was flagged in review as a gap:
1. `applyReasonOrdinalGate` — pure-function unit tests (Vitest), extensive edge-case coverage per
   D030 §3a / `data-model.md` §1's validation matrix.
2. `classifyClaimVerifiability` *orchestration* — mocked-provider unit tests confirming the pipeline
   wires a given classification to the correct exclude/search decision. This does not test whether
   the model classifies correctly.
3. `classifyClaimVerifiability` *behavior* — a live/golden-set evaluation (this repo's existing
   live-eval pattern, `docs/testing-philosophy.md`), the only layer that actually tests classification
   quality; mocked tests cannot substitute for it. Golden-set additions live under
   `evaluations/golden/grounnel/`.

**Target Platform**: Vercel Functions (existing deploy target — `biassemble-core`), no infra change.

**Project Type**: Single backend service (existing `biassemble-core` repo structure) — no new
project, no frontend/mobile surface.

**Performance Goals**: `applyReasonOrdinalGate` is a pure, synchronous string-matching function
(same cost class as the existing 8 gates — zero LLM cost, negligible latency).
`classifyClaimVerifiability` adds one LLM call per claim batch on the EXTRACT→search path; must not
materially change end-to-end run latency beyond the cost of that call (same class as the existing
`discoverUrls`/VERIFY calls already on this path).

**Constraints**: `applyReasonOrdinalGate` must never promote a verdict toward `supported` (one-
directional, matching every existing gate in the chain). `classifyClaimVerifiability` must never
silently exclude an ambiguous claim (false-exclusion is the dangerous failure direction per D030 and
this repo's core "false positives are worse than false negatives" principle carried through to
eligibility).

**Scale/Scope**: Two new functions, ~2 new/modified files each, 4 persistence-layer union-type
touch-ups (deferred until the ordinal gate is actually wired in, per D030 Consequences), golden-set
additions. No schema migration (reusing existing gate-event/reason-code columns with a new
enumerated value).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is unratified in this repo (template placeholders only, no
principles filled in). Per this repo's actual operative conventions
(`AGENTS.md`), the relevant checks are:

| AGENTS.md rule | Check |
|---|---|
| #1 Integration is mandatory | Both plan sections below name every call site (gate chain wiring, persistence union types, EXTRACT→search boundary) — not just "create the function." PASS |
| #10 Scope discipline | Plan is scoped exactly to D030's two decisions; explicitly excludes the generic `applyReasonFactGate<T>`, the `MULTIPLE SOURCES` prompt edit, and the value-less ordinal form — all deferred in D030 §4. PASS |
| #12 Prefer LLM judgment over regex for semantic checks | `classifyClaimVerifiability` is exactly this — an LLM call for a semantic "is this checkable" question the existing regex filter structurally can't answer. PASS |
| Forbidden: premature abstractions | No generic gate framework built for 2 instances (D030 §4). PASS |
| Testing philosophy: ~60% coverage is a cap, not a floor; add tests only for orchestration control-flow bugs | Both new pieces are exactly that class (retry/abstention logic, classification boundary) — test investment is justified, not padding. PASS |

No violations. Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/012-grounnel-ordinal-eligibility-gates/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
└── checklists/
    └── requirements.md   # Spec quality checklist (already validated)
```

No `contracts/` directory: this feature adds no new external interface. Both pieces are internal to
the existing Grounnel orchestration pipeline — `applyReasonOrdinalGate` is a pure function called
only from `pipeline.service.ts`, and `classifyClaimVerifiability` is an internal pre-search step with
no new HTTP route or public contract. The existing `POST /extract` contract
(`src/contracts/grounnel.schemas.ts`) is unchanged; a non-checkable claim still returns the existing
`unverifiable` verdict shape, just reached via a different code path.

### Source Code (repository root)

```text
src/orchestrators/grounnel/
├── gates.ts                    # + applyReasonOrdinalGate (new, pure function)
├── pipeline.service.ts         # + wiring into runGateChain (separate step, after validation)
├── opinion-filter.ts           # unchanged — isOpinionClaim stays as-is
├── claim-eligibility.ts        # NEW — classifyClaimVerifiability
└── extract.service.ts          # + call site: after EXTRACT, after the existing isOpinionClaim
                                 #   check (unchanged) — classifyClaimVerifiability only evaluates
                                 #   claims the regex didn't already catch, then before search

src/prompts/grounnel/
└── eligibility/                # NEW — system.json prompt for classifyClaimVerifiability
    └── system.json

src/persistence/
├── grounnel-gate-event-store.ts  # + new gate-name union member (deferred until gate is wired in)
├── types.ts                      # + same
src/db/
├── schema.ts                     # + same
└── queries.ts                    # + same

tests/unit/orchestrators/grounnel/
├── gates.test.ts                 # + applyReasonOrdinalGate cases (D030 §3a matrix)
└── claim-eligibility.test.ts     # NEW

evaluations/golden/grounnel/       # golden-set additions (GOLDEN_SET_PATH in scripts/eval-grounnel.ts)
```

**Structure Decision**: Extends the existing single-service `biassemble-core` layout
(`src/orchestrators/grounnel/`) with no new top-level directories. `applyReasonOrdinalGate` lives in
the existing `gates.ts` alongside its 8 siblings (not a new file — it's one more gate in the same
file, same as every prior gate addition). `classifyClaimVerifiability` gets its own new file
(`claim-eligibility.ts`) rather than being folded into `opinion-filter.ts`, since it's a different
mechanism (LLM call vs. regex) with a different failure mode — keeping them separate matches this
repo's existing pattern of `gates.ts` (deterministic) vs. VERIFY/EXTRACT prompt files (LLM) staying
in distinct modules.

## Complexity Tracking

*No violations — table omitted.*
