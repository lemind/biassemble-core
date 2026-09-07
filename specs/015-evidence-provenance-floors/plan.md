# Implementation Plan: Evidence Provenance Floors

**Branch**: `014-gr-upd4` (shared; 015 touches no file 014 touches) | **Date**: 2026-09-02 | **Spec**: not written — scope defined in this plan's Summary

**Input**: Live incident, production run `fddb57fa-80e3-443a-bdba-427462f21544` (UTM ISP100 first-year writing essay, 67 claims)

---

## Summary

A personal-narrative essay produced **22 `supported` verdicts, of which 5 are sound (23%)**. The
harmful-error rate was **17/67 = 25% of all claims given a wrong affirmative verdict** — an order of
magnitude worse than the ~2% false-*accusation* rate measured across three news runs, and far more
dangerous because a wrong `supported` looks correct to a user.

Two of the failure modes are deterministic and can be closed without a model call:

| | Gate | Closes | Count in `fddb57fa` |
|---|---|---|---|
| **G1** | Input-duplicate evidence | Retrieval returned the document under test (or its host copy), and VERIFY cited it back | **11** |
| **G2** | Affirmation floor | `supported` written with null/empty citations | **2** |

**This is explicitly not a prompt change.** VERIFY receives only `claim` + `passage_sentences`; it
never sees the input article. Given a passage that restates the claim verbatim, `supported` is
*obedience to STEP 2*, not a defect. No wording can reference a document that is not in the context.
G2's rule already exists in 4.6.0 ("supported and partially_supported **must** set
evidence_citations") and was not executed — the same pattern as REPORTING CLAIMS and SUBJECT ENTITY.

**Nothing in this spec touches `src/prompts/`.**

## Technical Context

**Language/Version**: TypeScript 5.9.3, Node 22, ESM

**Primary Dependencies**: `drizzle-orm` 0.40.0 for the simulations. **No Gemini calls in this spec at
all** — neither gate makes one, and both simulations read persisted telemetry.

**Storage**: Postgres `grounnel` schema — `grounnel_claims`, `grounnel_search_pages`,
`grounnel_rerank_decisions`, `grounnel_runs.text` (the input, needed by G1).

**Testing**: `vitest`. Both gates are pure functions over strings and verdicts, so they take
exhaustive unit tests — this is the `gates.ts` category CLAUDE.md's coverage cap explicitly exempts
("the one place still worth keeping exhaustive"). No golden-set run is required to prove either.

**Target Platform**: Vercel serverless; gates run inline in the existing chain.

**Project Type**: private HTTP API (web service)

**Performance Goals**: G1 must not add a model call. If placed pre-rerank it *removes* calls.

**Constraints**:
- **Cardinal Rule**: neither gate may ever create a `contradicted`. Both are downgrade-only.
- G1's threshold must be **high**. A quoted clause that also appears in an independent source is
  legitimate corroboration; a gate tuned to "any overlapping sentence" would delete every article
  that quotes a press release.
- Pasted-only runs carry no source URL, so **URL equality is a bonus check, not the definition**.
- **No deploy. No commits without an explicit ask.**

**Scale/Scope**: two pure functions, two call sites, two simulation scripts, unit tests.

## Constitution Check

*GATE: must pass before any task in tasks.md begins.*

`.specify/memory/constitution.md` is still an unfilled template (see spec 014 T015), so this plan is
gated on the project's actual binding rules:

| Gate | Source | Status |
|---|---|---|
| Simulate against persisted telemetry before writing production code | D030 §3n | **PASS** — Phase 2 precedes all code; both simulations are zero-API |
| False positives are worse than false negatives | VERIFY CORE PRINCIPLE | **PASS** — both gates downgrade only, neither can manufacture a contradiction |
| Deterministic gates preferred over prompt text for shape-specific defects | v4.3.0 revert; D030 §3d | **PASS** — that is the entire premise |
| `gates.ts` stays exhaustively tested | CLAUDE.md coverage cap | **PASS** — G1/G2 are pure, zero-LLM, and take full unit coverage |

## Project Structure

### Documentation (this feature)

```text
specs/015-evidence-provenance-floors/
├── plan.md
├── tasks.md
└── acceptance-rows.json        # T001 — the must-fire / must-not-fire sets
```

### Source Code (repository root)

```text
src/orchestrators/grounnel/
├── gates-text-grounding.ts      # G2 mirrors applyContradictionEvidenceGate (line ~193)
├── gates-shared.ts              # G1's similarity predicate lives here
└── pipeline-gate-chain.ts       # both call sites

src/orchestrators/grounnel/pipeline.service.ts   # optional earlier G1 cut, pre-rerank

scripts/
├── s015-t002-simulate-g1.ts     # zero-API
└── s015-t003-simulate-g2.ts     # zero-API

tests/                            # exhaustive, both gates
```

**Structure Decision**: G2 is a near-copy of `applyContradictionEvidenceGate` and belongs beside it
in `gates-text-grounding.ts`. G1's predicate is a shared string utility with a second potential
consumer (the pre-rerank cut), so it goes in `gates-shared.ts`. No new modules.

## Relationship to spec 014

**Parallel, not merged.** Three different mechanisms:

| Spec | Mechanism | Direction of harm |
|---|---|---|
| 014 US1 | escalation floor re-locks a contradiction | false `contradicted` |
| 014 US2 | VERIFY polarity / STEP 1 selection | false `contradicted` |
| **015** | the corpus cited itself; affirmation with no citation | **false `supported`** |

They may proceed at the same time provided they **do not share a deploy and do not both touch
`src/prompts/`** — 015 never does.

**One row moves between specs**: `fddb57fa`'s ISP100 claim (evidence about the course becoming
*required*, cited for what it *taught*) is a STEP 1 distractor, the same family as `ed8b3a37`. It
belongs in **014's distractor fixtures**, not here.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Full unit tests, against the coverage cap's default | CLAUDE.md exempts `gates.ts`-shaped code explicitly; both gates are pure and zero-cost to test | A golden-set run cannot prove a deterministic predicate, and would cost ~1680 calls to try |
| G1 simulated on two sets, not one | A must-fire-only simulation would license an over-broad threshold that silently deletes legitimate third-party corroboration | Tuning on the 11 circular rows alone repeats the spec 013 `subject_entity` mistake — fitting a predicate to its own motivating examples |
| No `spec.md` | Two gates with pre-registered acceptance rows are fully specified by this plan plus tasks.md | A spec would restate the Summary |
