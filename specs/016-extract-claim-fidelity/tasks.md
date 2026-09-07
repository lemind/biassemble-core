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

- [x] T001 Freeze the three defects to `specs/016-extract-claim-fidelity/incidents.json` — for each, the claim id(s), `claim_text`, `source_excerpt`, final verdict, and the article sentence EXTRACT read

**RESULTS (2026-09-02)** — `scripts/s016-t001-freeze-extract-incidents.ts`, zero API.

Frozen from telemetry, not transcribed: `5b8005cc` 36 claims, `fddb57fa` 67, `be72361c` 22. The
freeze widened past the three named defects to every same-`source_excerpt` group in `5b8005cc`, and
that is where the finding is.

**⚠️ `source_excerpt` equality is NOT a duplicate signal. It is mostly correct behaviour.**
Nine groups of ≥2 claims share an excerpt in one 36-claim run. Only four contain anything droppable:

| Excerpt group | Claims | Verdict on the group |
|---|---|---|
| "No one expects the U.S. to default…" | `854ce6b3` + `451a6f1d` **byte-identical** ("The U.S. fiscal picture is deteriorating.") + `9200ae1b` (debt tops $40T) | **exact dupe** + 1 legit sibling |
| "Corporate profits… soared 52%" | `f91fdbf3` + `09311c01` **byte-identical** ("profits as a share of GDP reached a record 13.2%") + `b4ffdbbb` (the 52%) | **exact dupe** + 1 legit sibling |
| "Bond investors increasingly question…" | `854e8ff9` "Treasuries have been re-priced as a risky claim" + `ec4b6a7d` "The market has re-priced Treasuries as a risky claim" + `d68cdf44` | **paraphrase pair** + 1 legit sibling |
| "Wall Street expects… $730 billion" | `6c3dcb86` attributed + `9d64f9c9` stripped + `e49821f1` ($400B **last** year) | **subsumption pair** + 1 legit sibling |
| "term premium **and** inflation expectations" | `0f903b2e` + `890a32cd` | ✅ correct conjunction split — must not fire |
| "shifts in who acts as marginal buyer" | `db79c144` + `b7096fee` + `c2e35085` | ✅ correct decomposition |
| "change in market's structure" | `7e2e0c76` (Swift's affiliation) + `4bb34271` + `e1d34d7f` | ✅ two consequences + an attribution fact |
| "As the Treasury market competes…" | `5d4e99d7` (spreads) + `13d5fbdc` (Wizman's affiliation) | ✅ different facts |
| Treasury Building photo caption | `4af3e8a8` (location) + `1665eab0` (photographed date) | ✅ for E1 — `1665eab0` is **E2**, not a duplicate |

**Five of nine groups are EXTRACT working correctly.** A collapse keyed on shared excerpt alone
would delete real claims — the exact failure mode this spec was written to avoid. T004's second
condition ("one subsumes the other") is not a refinement, it is the whole gate.

**Consequence for T004 — two tiers, ship them separately:**

1. **Exact-text equality after normalisation** — `854ce6b3`/`451a6f1d`, `f91fdbf3`/`09311c01`. Zero
   judgment, zero threshold, cannot delete a real claim. This is the safe fix.
2. **Subsumption / paraphrase** — `9d64f9c9` under `6c3dcb86`, `ec4b6a7d` ≈ `854e8ff9`. Needs a
   real predicate and its own must-not-fire set drawn from the five ✅ groups above. **Do not ship
   tier 2 on tier 1's evidence.**

**E1's named pair both landed `unverifiable`, neither `supported`.** The latent-false-affirmation
framing holds as a risk, not as a realised harm in this run — say so that way.

**E2 side finding — the marker shortlist is already 5/13 wrong.** A caption/bio regex written for
triage caught `33b810a6` ("Hanno Lustig is a senior fellow at SIEPR"), `c1814112` (a UR spokesperson
statement to Reuters), `0dcec786` ("The Campus Times is a student newspaper") and `14228230` — all
legitimate checkable claims. Eight `fddb57fa` bio rows are genuine, and **six of those eight were
already `excluded`** by eligibility. That is direct evidence for T003's gate: eligibility is
partially working and a new detector is the wrong instrument. Two leaked (`cf3153e4` baking,
`38ebc2ae` knitting) and both shipped `supported`.

---

## Phase 2: Measure (hard gate, zero API cost)

**⚠️ T003 can cancel E2's fix entirely.**

- [x] T002 [P] [E1] Census duplicate extraction in `scripts/s016-t002-census-duplicate-claims.ts` — across all `grounnel_claims`, group by `(run_id, source_excerpt)` where `source_excerpt IS NOT NULL` and count groups with ≥2 claims; for each, record whether one claim's text is an attribution-stripped or otherwise-subsuming variant of another. Report **duplicate-group rate per run, with N**, and the wasted-spend estimate (`extra claims × ~2.9 Gemini calls + 1 search round`)
- [x] T003 [P] [E2] Census non-assertion claims in `scripts/s016-t003-census-nonassertion-claims.ts` — pull every claim whose `source_excerpt` is null or looks like caption/bio boilerplate, join to its `eligibility_check` LLM call, and report **how many were already `excluded` vs let through**

**RESULTS (2026-09-02) — E1 IS REFUTED. Do not build the dedup.**

`scripts/s016-t002-census-duplicate-claims.ts`, zero API. Corpus: **8,106 claims / 2,207 runs**
(3,242 production, 4,864 eval). 5,578 claims carry no `source_excerpt`, so the grouped census sees
2,528 claims across 705 runs; a second query covers the whole corpus without needing the column.

**Run-internal exact-duplicate claims, entire corpus: 2.**

| # | Run | Claims |
|---|---|---|
| 1 | `5b8005cc` | `451a6f1d` ≡ `854ce6b3` — "The U.S. fiscal picture is deteriorating." |
| 2 | `5b8005cc` | `09311c01` ≡ `f91fdbf3` — "Company profits as a share of GDP reached a record 13.2%." |

Both in the single run that motivated this spec. **Rate = 0.02% of all claims, in 1 of 2,207 runs.**
Nothing else in 8,106 claims duplicates itself. E1 is a one-article incident, not a class.

**Every looser predicate is worse than the defect.** 477 same-excerpt groups yield 765 pairs:

| Predicate | Fires | Genuine | Verdict |
|---|---|---|---|
| exact normalized equality | 2 | 2 | correct, but the population is 2 |
| substring containment | 2 | 1 | `9d64f9c9` ⊂ `6c3dcb86` is real; the other splits a compound sentence correctly and must not fire |
| token overlap ≥ 0.80 | 15 | **1** | **~93% false-positive** |

The 0.80 tier's false positives are not near-misses, they are opposite facts:

- "There is general **chivalry** in the SCA" vs "There is general **honesty** in the SCA"
- "**Seven** people were **killed**" vs "**Eight** people were **injured**"
- "Ealdormere and the Crown influence **the shires**" vs "the shires and populace influence **the Crown**" — reversed direction
- "can be found **baking**" / "**knitting**" / "**reading**" — three separate bio facts

No threshold band exists: 0.75 fires on 222 pairs, 0.80 on 15, and the 15 are already mostly wrong.
**The pre-registered rule from spec 015 T002 applies — if the must-not-fire set moves at all, the
predicate is wrong. It moves at every threshold.** This is the ninth fix candidate refuted before
shipping.

**Measured spend, not estimated: 3.45 Gemini + 7.95 search calls per claim.** Collapsing all 16
theoretically-droppable claims would have saved ~55 Gemini + ~127 search calls across the project's
entire history. The saving does not pay for the code path, let alone its false-positive risk.

**T004-T006 are cancelled.** Retained below only so the reasoning stays queryable.

**Consequence: E1 was this spec's MVP, and it is gone.** The largest measured defect still open is
**[spec 015](../015-evidence-provenance-floors/tasks.md) G1 circular self-citation** — 19 rows
across two genres, inside a 25% harmful-affirmation rate on student writing. G1 should take the MVP
slot E1 vacated, gated on its own T002 simulation.

**RESULTS (2026-09-02) — T003's gate answers branch (a), and E2 shrinks to 2 rows.**

`scripts/s016-t003-census-nonassertion-claims.ts`, zero API.

| | |
|---|---|
| Marker-shortlisted claims, whole corpus | **12** |
| Already `excluded` by eligibility | **7 (58%)** — all as `personal/clear` + `referent=false` |
| Let through | 5 |
| Let through **and affirmed** | **3** |
| Of those, actually defective | **2** |

The third affirmed row is `0dcec786` *"The Campus Times is a student newspaper"* — a perfectly
checkable fact, correctly let through. It is not an E2 defect. **E2's real population is 2 claims
in 8,106**: `cf3153e4` (baking) and `38ebc2ae` (knitting).

**Eligibility is the right instrument and it is already working.** Every excluded row was caught as
`personal` with `hasResolvableReferent=false` — exactly the mechanism spec 013 T27 built. **A
caption/bio detector would be a second heuristic layered on a classifier that is already correct on
7 of 9 real cases.** Branch (b) is refuted; do not write one.

**The 2 misses are a category error, not a missing rule.** Both were classified
`checkable/clear/referent=true`. "Alishba Rana can be found baking in her spare time" *is* a
grammatical assertion about a named person — the classifier is not wrong about the referent, it is
wrong that the claim is `checkable` rather than `personal`. Fixing that is a
`hasResolvableReferent`/category prompt revision screened through the T27b harness.

**T007 is CANCELLED on cost-benefit, not on principle.** A prompt screen for 2 rows in 8,106, on a
prompt-section track record of 0-for-4 live, against a quota that is currently exhausted, is not a
defensible spend. Reopen only if the rate rises. This is the eleventh candidate refuted before
shipping.

**Side finding, unrelated to E2 but worth recording: eligibility coverage is 5,254 of 8,106 claims
(65%).** 2,852 claims reached a verdict with no `eligibility_check` row at all. Not investigated
here; it is a bigger question than E2 and belongs in its own task.

**T003's gate.** If eligibility already excludes most of them, E2 is a **prompt-screening** problem
for `hasResolvableReferent` (spec 013 T27's field), not a new detector. If it excludes almost none,
E2 needs its own instrument. **Do not write a caption/bio heuristic before this number exists** —
that is precisely how spec 013 burned 7 refuted `subject_entity` candidates.

**Checkpoint**: E1 may begin after T002. E2's shape is decided by T003.

---

## Phase 3: E1 — duplicate claim collapse — CANCELLED (T002 REFUTED)

**Goal**: one sentence yields one claim; the faithful, attributed form survives.

**Independent test criteria**: replaying `5b8005cc` yields one claim for the $730B sentence, and it
is `6c3dcb86`'s attributed wording.

- [x] ~~T004 [E1] Add `collapseDuplicateClaims` to `src/orchestrators/grounnel/claim-dedup.ts` — pure function over the extracted claim list; when two claims share a `source_excerpt` and one subsumes the other, keep exactly one
- [x] ~~T005 [E1] Add exhaustive unit tests in `tests/` — attributed vs stripped pair collapses to the **attributed** one; two genuinely different claims from one excerpt are both kept; null `source_excerpt` never groups; identical text dedupes; three-way groups collapse to one
- [x] ~~T006 [E1] Wire it into `src/orchestrators/grounnel/extract.service.ts` before claims are persisted or searched, so the saving is real spend and not just display

**Merge direction is load-bearing.** Keep the claim that **retains its attribution** ("Wall Street
expects…"), drop the bare one. Reversing it would make EXTRACT's output *less* faithful and would
turn a duplication bug into a fidelity bug. Encode this as a named test, not a comment.

**Not in scope for E1**: claims from *different* sentences that happen to say similar things. Only
same-`source_excerpt` groups. Widening this is how a dedup becomes a claim-suppressor.

**Checkpoint**: E1 shippable alone.

---

## Phase 4: E2 — non-assertion text — CANCELLED (T003: eligibility already handles it)

- [x] ~~T007 [E2] Implement whichever instrument T003 indicates: **(a)** if eligibility mostly catches these, screen a `hasResolvableReferent` prompt revision through the T27b harness; **(b)** if it does not, add a deterministic pre-EXTRACT skip for caption/credit/bio regions. Record which branch was taken and why

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
