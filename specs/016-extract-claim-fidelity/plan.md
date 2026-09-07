# Implementation Plan: EXTRACT Claim Fidelity

**Branch**: `014-gr-upd4` | **Date**: 2026-09-02 | **Spec**: scope defined in this Summary

**Input**: Live runs `be72361c`, `5b8005cc`, `fddb57fa` — three EXTRACT defects, one stage, one contract.

---

## Summary

Three defects all originate in EXTRACT (prompt 1.6.0) and all produce claims that misrepresent the
article. They were found across three runs and had no spec until now.

| # | Defect | Evidence | Instrument |
|---|---|---|---|
| **E1** | **Duplicate claims from one sentence** — the attributed reporting claim *and* an attribution-stripped bare claim | `5b8005cc`: `6c3dcb86` "**Wall Street expects** big tech will spend $730B" + `9d64f9c9` "big tech **will spend** $730B", identical `source_excerpt` | **Deterministic dedup** |
| **E2** | **Non-assertion text extracted as claims** — photo captions, author bios, writer's statements | `5b8005cc`: `1665eab0` "The Treasury Building was photographed on July 11, 2026"; `fddb57fa`: ~14 claims from the writer's statement ("can be found baking") | **Measure eligibility first** |
| **E3** | **Referent widening** — a definite description becomes indefinite, inverting truth conditions | `be72361c`: `181d6ebb` "**the** article the post links to" → "**an** article on the website" | **Prompt — last, and only if screened** |

**Why they matter.** E1 doubles search and VERIFY spend on the affected sentence and shows the user
the same fact twice. Worse, the attribution-stripped twin is a *latent false-affirmation path*: had
retrieval found any "$730 billion" figure, `9d64f9c9` would have shipped `supported` for a bare
prediction the article never made. E2 burns paid search on text that asserts nothing. E3 converted a
true claim into one that VERIFY correctly contradicted — the only defect here that already caused a
user-visible falsehood finding.

**Ordering follows the same rule as 015: deterministic before prompt.** E1 is pure string work with
no model call. E2 is a measurement before it is a fix. E3 is prompt work, and prompt sections in this
repo are **0-for-4 live** — it goes last and carries a kill criterion.

## Technical Context

**Language/Version**: TypeScript 5.9.3, Node 22, ESM

**Primary Dependencies**: `drizzle-orm` for the censuses. **No Gemini calls in Phases 1–3.**

**Storage**: `grounnel_claims` (`claim_text`, `source_excerpt`), `grounnel_llm_calls`
(`stage='extract'`, `call_type='eligibility_check'`) — everything the censuses need is persisted.

**Testing**: E1's dedup is a pure function → exhaustive unit tests (the `gates.ts` category CLAUDE.md
exempts from the coverage cap). E2/E3 are LLM behaviour → no unit tests, golden set only.

**Target Platform**: Vercel serverless.

**Constraints**:
- **Cardinal Rule**: E1's dedup must never drop the *attributed* claim and keep the stripped one —
  the attributed form is the faithful one. Direction of the merge is load-bearing.
- No deploy. No commits without an explicit ask.
- Eval budget: Phases 1–3 are zero-API. Phase 4 (E3) is the only spend.

**Scale/Scope**: one pure dedup function + call site, two census scripts, one possible prompt block.

## Constitution Check

`.specify/memory/constitution.md` is an unfilled template (spec 014 deferred item), so this plan is
gated on the project's real rules:

| Gate | Source | Status |
|---|---|---|
| Simulate/measure before production code | D030 §3n | **PASS** — Phase 2 precedes all fixes |
| Deterministic gate preferred over prompt text | v4.3.0 revert; 015 G2 | **PASS** — E1 first, E3 last |
| False positives worse than false negatives | VERIFY CORE PRINCIPLE | **PASS** — E1 merges toward the attributed claim; nothing here can create `contradicted` |
| No unit tests for LLM behaviour | CLAUDE.md coverage cap | **PASS** — tests on E1 only |

## Project Structure

```text
specs/016-extract-claim-fidelity/
├── plan.md
└── tasks.md

src/orchestrators/grounnel/
├── extract.service.ts          # E1 dedup call site
└── claim-dedup.ts              # E1 — new, pure
src/prompts/grounnel/extract/
└── system.json                 # E3 only, 1.6.0 -> 1.7.0, gated on a screen

scripts/
├── s016-t002-census-duplicate-claims.ts    # zero-API
└── s016-t003-census-nonassertion-claims.ts # zero-API
```

**Structure Decision**: E1's predicate is claim-text comparison, not gate-chain logic — it runs in
EXTRACT before claims are persisted, so it does not belong in `gates.ts`. New small module.

## Relationship to other specs

| Spec | Stage | Direction of harm |
|---|---|---|
| 014 | VERIFY STEP 1/2 | false `contradicted` |
| 015 | evidence provenance | false `supported` |
| **016** | **EXTRACT** | **claims that misstate the article — both directions, plus wasted spend** |

015's G1 and this spec's E2 both touch "text that should never have been searched", but from
opposite ends: G1 rejects a *retrieved passage*, E2 rejects an *extracted claim*. Independent.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| E2 is a measurement task, not a fix | `hasResolvableReferent` (spec 013 T27) may already be the right instrument and simply be under-triggering; a new heuristic before measuring repeats spec 013's 7/7 refuted `subject_entity` fixes | Writing a caption/bio detector first would add a third heuristic to a classifier that may just need its prompt screened |
| E3 deferred behind a kill criterion | Prompt sections are 0-for-4 live in this repo | Shipping a wording fix on the strength of one incident is exactly the pattern that produced the 0-for-4 |
