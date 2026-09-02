---
description: "Task list for EXTRACT claim fidelity — E1 duplicate claims, E2 non-assertion text, E3 referent widening"
---

# Tasks: EXTRACT Claim Fidelity

**Input**: [plan.md](./plan.md). No `spec.md`; scope is in plan.md's Summary.

**Prerequisites**: none. Phases 1–2 are zero-API.

**Tests**: **E1 only.** It is a pure function. E2/E3 are LLM behaviour — golden set, never unit tests.

**Sequencing rule (D030 §3n)**: measure against persisted telemetry before writing production code.

## Format: `[ID] [P?] [Story] Description`

- **[Story]**: `[E1]` duplicate claims, `[E2]` non-assertion text, `[E3]` referent widening.

---

## The three defects

| # | Claim ids | What EXTRACT did |
|---|---|---|
| **E1** | `6c3dcb86` + `9d64f9c9` (`5b8005cc`) | From *"Wall Street expects big tech firms will spend more than $730 billion on AI infrastructure this year"* it emitted **both** the attributed reporting claim and an attribution-stripped bare prediction, with the **same `source_excerpt`** |
| **E2** | `1665eab0` (`5b8005cc`); ~14 rows in `fddb57fa` | Extracted claims from a **photo caption** ("The Treasury Building was photographed on July 11, 2026") and from an **author bio / writer's statement** ("can be found baking", "loves nature") |
| **E3** | `181d6ebb` (`be72361c`) | Rewrote **"the article the post links to"** as **"an article on the website"** — definite to indefinite, which inverts the truth conditions |

**E1's severity is not the duplication.** It is that the stripped twin is a **latent false
affirmation**: `9d64f9c9` asserts big tech *will* spend $730B as fact. Retrieval found nothing, so it
landed `unverifiable`. Had it found any "$730 billion" figure it would have shipped `supported` for a
prediction the article attributes to Wall Street and never asserts itself.

**E3 is the only one that already caused a user-visible falsehood finding** — under the widened
reading, VERIFY's `contradicted` was *correct*.

---

## Phase 1: Setup

- [ ] T001 Freeze the three defects to `specs/016-extract-claim-fidelity/incidents.json` — for each, the claim id(s), `claim_text`, `source_excerpt`, final verdict, and the article sentence EXTRACT read

---

## Phase 2: Measure (hard gate, zero API cost)

**⚠️ T003 can cancel E2's fix entirely.**

- [ ] T002 [P] [E1] Census duplicate extraction in `scripts/s016-t002-census-duplicate-claims.ts` — across all `grounnel_claims`, group by `(run_id, source_excerpt)` where `source_excerpt IS NOT NULL` and count groups with ≥2 claims; for each, record whether one claim's text is an attribution-stripped or otherwise-subsuming variant of another. Report **duplicate-group rate per run, with N**, and the wasted-spend estimate (`extra claims × ~2.9 Gemini calls + 1 search round`)
- [ ] T003 [P] [E2] Census non-assertion claims in `scripts/s016-t003-census-nonassertion-claims.ts` — pull every claim whose `source_excerpt` is null or looks like caption/bio boilerplate, join to its `eligibility_check` LLM call, and report **how many were already `excluded` vs let through**

**T003's gate.** If eligibility already excludes most of them, E2 is a **prompt-screening** problem
for `hasResolvableReferent` (spec 013 T27's field), not a new detector. If it excludes almost none,
E2 needs its own instrument. **Do not write a caption/bio heuristic before this number exists** —
that is precisely how spec 013 burned 7 refuted `subject_entity` candidates.

**Checkpoint**: E1 may begin after T002. E2's shape is decided by T003.

---

## Phase 3: E1 — duplicate claim collapse (Priority: P1) 🎯 MVP

**Goal**: one sentence yields one claim; the faithful, attributed form survives.

**Independent test criteria**: replaying `5b8005cc` yields one claim for the $730B sentence, and it
is `6c3dcb86`'s attributed wording.

- [ ] T004 [E1] Add `collapseDuplicateClaims` to `src/orchestrators/grounnel/claim-dedup.ts` — pure function over the extracted claim list; when two claims share a `source_excerpt` and one subsumes the other, keep exactly one
- [ ] T005 [E1] Add exhaustive unit tests in `tests/` — attributed vs stripped pair collapses to the **attributed** one; two genuinely different claims from one excerpt are both kept; null `source_excerpt` never groups; identical text dedupes; three-way groups collapse to one
- [ ] T006 [E1] Wire it into `src/orchestrators/grounnel/extract.service.ts` before claims are persisted or searched, so the saving is real spend and not just display

**Merge direction is load-bearing.** Keep the claim that **retains its attribution** ("Wall Street
expects…"), drop the bare one. Reversing it would make EXTRACT's output *less* faithful and would
turn a duplication bug into a fidelity bug. Encode this as a named test, not a comment.

**Not in scope for E1**: claims from *different* sentences that happen to say similar things. Only
same-`source_excerpt` groups. Widening this is how a dedup becomes a claim-suppressor.

**Checkpoint**: E1 shippable alone.

---

## Phase 4: E2 — non-assertion text (shape decided by T003)

- [ ] T007 [E2] Implement whichever instrument T003 indicates: **(a)** if eligibility mostly catches these, screen a `hasResolvableReferent` prompt revision through the T27b harness; **(b)** if it does not, add a deterministic pre-EXTRACT skip for caption/credit/bio regions. Record which branch was taken and why

---

## Phase 5: E3 — referent widening (POST-MVP, gated)

**Prompt work. The record for prompt sections in this repo is 0-for-4 live** — SEQUENCE POSITION
reverted, REPORTING CLAIMS did not fire, SUBJECT ENTITY did not fire, the EVIDENCE requirement did
not fire. Treat this as a screened hypothesis.

- [ ] T008 [E3] Build a fixture pack: definite→indefinite pairs ("*the* article the post links to" vs "*an* article on the site"), plus **controls** where an indefinite reading is genuinely correct, so the fix cannot be passed by making EXTRACT copy determiners blindly
- [ ] T009 [E3] Pre-register every fixture's expected claim text **before** writing the pack
- [ ] T010 [E3] Screen ≥3 candidate wordings offline; state the call count before spending
- [ ] T011 [E3] Ship EXTRACT 1.7.0 **only if** the screen clears

**Kill criterion**: if the screen cannot hold the definite→indefinite rows *and* the controls
together, do not ship 1.7.0. The next move is a deterministic check that the claim preserves the
excerpt's determiner, or living with the defect — **not** a second wording round.

---

## Dependencies

```text
T001 ──┬── T002 [P] ──► E1
       └── T003 [P] ──► decides E2's shape (can cancel it)
                 │
  Phase 3  E1  T004 → T005 → T006      ← MVP, ships alone
  Phase 4  E2  T007                    ← shape from T003
  Phase 5  E3  T008 → T009 → T010 → T011   ← POST-MVP
```

**Hard orderings**: T002 before T004. T003 before T007. T009 strictly before T008's pack is written
(same anti-tuning rule as spec 014 T008). T010 before T011.

## Implementation strategy

**MVP is E1.** Pure function, no model call, no threshold, no screen that can veto it, and it cuts
real spend as well as fixing fidelity. Ship it alone.

E2 second, in whatever shape T003 dictates. E3 last or never.

## Explicitly out of scope

- **Boilerplate/SEO chrome accepted as VERIFY evidence** — spec 013 T28, retrieval side.
- **Circular self-citation** — [spec 015](../015-evidence-provenance-floors/tasks.md) G1.
- **Anything in VERIFY** — specs 014 and 015.
