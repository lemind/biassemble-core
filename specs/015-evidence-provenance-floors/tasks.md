---
description: "Task list for evidence provenance floors — G1 input-duplicate evidence, G2 affirmation floor"
---

# Tasks: Evidence Provenance Floors

**Input**: [plan.md](./plan.md) (required). No `spec.md`; scope is in plan.md's Summary.

**Prerequisites**: none. Phases 1–2 are zero-API and can start immediately.

**Tests**: **both gates take exhaustive unit tests.** They are pure, deterministic and zero-LLM —
the one category CLAUDE.md's coverage cap explicitly keeps exhaustive. No golden-set run is needed
or useful for either.

**Sequencing rule (D030 §3n)**: simulate against persisted telemetry before writing production code.
**Phase 2 is a hard gate and can veto G1 outright.**

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelisable. **[Story]**: `[G1]` input-duplicate evidence, `[G2]` affirmation floor.

---

## The failure

Two runs, two genres, the same dominant defect. Combined: **39 supported verdicts,
11 sound (28%)**, with self-citation the single largest cause in both.

Run `fddb57fa` (UTM ISP100 personal-narrative essay, 67 claims, 178 Gemini + 371 search calls):
**22 supported / 21 excluded / 18 unsupported / 6 unverifiable / 0 contradicted.**

Of the 22 `supported`, **5 are sound**. Breakdown:

| Cause | Count | In scope |
|---|---|---|
| **Circular** — cited `jps.library.utoronto.ca`, the journal hosting this essay | **11** | **G1** |
| **Circular, syndicated** — run `9ec37df1` (essay-mill Mona Lisa paper): cited `ivypanda.com`, `studycorgi.com`, `gradesfixer.com`, all carrying the input text | **8** | **G1** |
| **Null citations** on an affirmative verdict | **2** | **G2** |
| Wrong entity (`alishabakitchen.com`, a Facebook post about a different Alishba) | 2 | ❌ out — see below |
| Boilerplate/SEO chrome accepted as a sentence | 1 | ❌ out — spec 013 T28 |
| Wrong fact (ISP100 *required* cited for what it *taught*) | 1 | ❌ out — spec 014 distractor fixtures |
| Sound | 5 (`fddb57fa`) + 6 (`9ec37df1`) | — |

**Harmful-error rate: 17/67 = 25% of claims given a wrong affirmative verdict.** For comparison the
false-*accusation* rate across the three news runs is ~2%. False `supported` is both more common and
less visible — a user has no reason to doubt it.

**VERIFY is not at fault for the circular rows.** It receives only `claim` + `passage_sentences` and
never sees the input article. Given `A:4 = "Her family is originally from a small village in
Shujaabād, Multan, Pakistan."` against that exact claim, `supported` is STEP 2 working correctly.
No prompt rule can name a document that is not in the context. **Nothing in this spec edits
`src/prompts/`.**

**The wrong-entity rows are not a T31 reversal condition.** They look like the case
`applySubjectEntityGate` was built for, but `sameEntity` compares proper-noun tokens and *Alishba* ∩
`alishabakitchen.com` shares one — the "same surname, different person" pass documented in
`gates-shared.ts`. The gate would have let all of them through. **T31 stays disabled.** Do not cite
these rows as grounds to revert it.

---

## Phase 1: Setup

- [ ] T001 Freeze the acceptance rows to `specs/015-evidence-provenance-floors/acceptance-rows.json` — the **must-fire** set (**19 rows across two genres**: the 11 circular rows from `fddb57fa` on `jps.library.utoronto.ca`, plus the 8 from `9ec37df1` on `ivypanda.com` / `studycorgi.com` / `gradesfixer.com`), each with its cited passage text, the run's input `grounnel_runs.text`, and the source URL; plus the **must-not-fire** set (see T002). Both simulations read this file, not the DB directly.

**Checkpoint**: T002 and T003 both read `acceptance-rows.json`.

---

## Phase 2: Simulate (hard gate, zero API cost)

**⚠️ T002 can veto G1 outright.** Tuning a predicate on its own motivating examples is exactly the
mistake spec 013 made seven times with `subject_entity`. The must-not-fire set is what stops it.

- [ ] T002 [P] [G1] Simulate the input-duplicate predicate in `scripts/s015-t002-simulate-g1.ts` — score every candidate threshold against **both** sets and report fire/no-fire counts per threshold
- [ ] T003 [P] [G2] Census null-citation affirmations in `scripts/s015-t003-simulate-g2.ts` — count historical claims with `verdict IN ('supported','partially_supported')` and empty/null `evidence`, to size G2 and confirm it is not a one-run artifact

### T002's two sets, pre-registered

| Set | Contents | Required outcome |
|---|---|---|
| **Must fire A** — same-host copy | the 11 circular rows from `fddb57fa`; the input essay was retrieved from its own journal host `jps.library.utoronto.ca` | all 11 refused |
| **Must fire B** — syndicated copy, different host | the 8 circular rows from `9ec37df1`; the input essay-mill text was retrieved from `ivypanda.com`, **and also from `studycorgi.com` and `gradesfixer.com`** | all 8 refused |
| **Must not fire** | a slice of historical `supported` claims whose cited sources are **third-party URLs** — include the news runs `9a784003`, `be72361c`, `5b8005cc` | **zero** refused |

**Set B is why URL matching is not the answer.** The same essay is syndicated across several mills,
so the corroborating domain differs from wherever the user got the text — and in a pasted run there
is no source URL at all. A host-equality check catches **none** of the 8. Only text similarity
against `grounnel_runs.text` catches them. Do not let anyone propose URL matching as a shortcut.

**Pre-registered kill criterion: if the must-not-fire set moves at all, the threshold is wrong.**
Report the widest threshold band where must-fire = 19/19 (both sets A and B) and must-not-fire = 0. If no such band
exists, **G1 does not ship** and the finding is recorded in D030 as refuted.

**Why the threshold must be high.** A quoted clause frequently appears verbatim in several
independent outlets — a press-release sentence, a court filing, an official statement. That is
legitimate corroboration. A predicate tuned to "any overlapping sentence" would delete it. G1 must
recognise **the document**, not **a shared quotation**.

**Definition note.** Pasted-only runs have no source URL, so URL equality is a **bonus signal, not
the definition**. The predicate is text-similarity against `grounnel_runs.text`, at two granularities:
a passage that near-copies a *span* of the input, and a page that near-copies the *whole* input.

**Checkpoint**: G1 may begin only if T002 returns a valid threshold band. G2 does not depend on T003.

---

## Phase 3: G2 — affirmation floor (Priority: P1) 🎯 MVP

**Goal**: an affirmative verdict can never be written without citations.

**Independent test criteria**: the 2 rows from `fddb57fa` become `unsupported`; every unit test in
T005 passes. Ships alone, independent of G1.

- [ ] T004 [G2] Add `applyAffirmationEvidenceGate` to `src/orchestrators/grounnel/gates-text-grounding.ts`, mirroring `applyContradictionEvidenceGate` (line ~193): fires only on `supported` / `partially_supported`; empty-or-whitespace evidence, or evidence not grounded in the passage, downgrades to **`unsupported`** with `evidence: null` and reason `evidence_null` / `evidence_not_grounded`
- [ ] T005 [G2] Add exhaustive unit tests in `tests/` — fires on `supported` + null; fires on `supported` + whitespace-only; fires on `partially_supported` + null; fires on ungrounded non-null evidence; does **not** fire on `supported` + grounded evidence; does **not** fire on `contradicted`, `unsupported`, `unverifiable`, `excluded`
- [ ] T006 [G2] Wire the call site in `src/orchestrators/grounnel/pipeline-gate-chain.ts` beside gate #1, add `"affirmation_evidence"` to all four persistence unions (`schema.ts`, `persistence/types.ts`, `db/queries.ts`, the gate-event store), and record a D019 §2 addendum

**`unsupported`, not `unverifiable` — decided.** `applyContradictionEvidenceGate` already downgrades
to `unsupported` on the same two reasons, and STEP 3 maps ABSENT → `unsupported`. Mirroring means
mirroring. Do not introduce a second convention.

**Two things G2 is not.** It is **not** a confidence rule — confidence remains uninformative and
must not be consulted. It **cannot** create `contradicted`; downgrade-only, like gate #1.

**Checkpoint**: G2 shippable alone.

---

## Phase 4: G1 — input-duplicate evidence (Priority: P2, gated on T002)

**Goal**: retrieval handing back the document under test can no longer be cited as corroboration.

**Independent test criteria**: replaying `fddb57fa` refuses all 11 circular passages; the
must-not-fire set is untouched.

- [ ] T007 [G1] Add the similarity predicate to `src/orchestrators/grounnel/gates-shared.ts` at the threshold band T002 returned — span-level (passage ≈ a span of the input) and page-level (page ≈ the whole input)
- [ ] T008 [G1] Add exhaustive unit tests in `tests/` — verbatim span match fires; whole-page copy fires; a single shared quoted sentence inside otherwise-different text does **not** fire; short claims and empty input do not fire; unicode/whitespace normalisation is covered
- [ ] T009 [G1] Refuse matching passages as evidence at the gate-chain call site, with its own gate name and reason, recorded like every other gate
- [ ] T010 [G1] [P] **Optional, measure first**: apply the same predicate pre-rerank in `pipeline.service.ts` to drop input-duplicate hits before they reach VERIFY — saves the call rather than discarding its output. Ship only if T002's band holds at that earlier point too; simulate separately, do not assume

**G1 is not entity resolution.** It does nothing about `alishabakitchen.com` or the Facebook rows.
Do not let it grow into that — those need `sameEntity`, which is refuted work (spec 013 T30).

**Checkpoint**: G1 shippable.

---

## Deferred — not MVP

No task IDs; low severity, must not compete with Phases 1–4.

- Record both gates in D019 §2 / D030 once the simulation numbers exist, including G1's refuted
  threshold band if it dies.
- Delete `scripts/_q.ts` and `scripts/_q2.ts`.

## Dependencies & execution order

```text
T001 (freeze acceptance rows)
  ├── T002 [P] simulate G1 ──────► VETO GATE for G1
  └── T003 [P] census G2  ──────► sizes G2, cannot veto it
                │
    Phase 3  G2  T004 → T005 → T006          ← MVP, ships alone, needs neither T002 nor T003
                │
    Phase 4  G1  T007 → T008 → T009 → T010   ← requires T002's band
```

**Hard orderings**: T001 before T002/T003. **T002 before T007.** T004 before T005 before T006.
T009 before T010.

**Parallel**: T002 ∥ T003. Phase 3 ∥ Phase 4 once T002 returns. **All of Phase 2 here ∥ spec 014's
T003/T004** — four zero-API scripts, no shared files, no shared deploy.

## Implementation strategy

**MVP is G2.** It is a mirror of code that already exists, it needs no threshold, no simulation can
veto it, and it closes a hard contract violation. Ship it first and alone.

**G1 second**, only with T002's band in hand. If no band exists, G1 is refuted and the circular
problem is recorded as open rather than papered over with a guessed threshold.

## Explicitly out of scope

- **Any change to `src/prompts/`.** Three sections now exist, are correctly worded, and did not fire
  in production (REPORTING CLAIMS, SUBJECT ENTITY, the EVIDENCE requirement) on top of a reverted
  fourth. A SELF-REFERENCE paragraph would be the fifth, and the model will ignore it while a
  verbatim sentence sits in slot A:4.
- **Entity resolution** — `sameEntity` / `properNounWords`. Refuted, spec 013 T30.
- **Re-enabling `subject_entity`** — see the note above; these rows are not a reversal condition.
- **Boilerplate/SEO chrome as evidence** — spec 013 T28.
- **STEP 1 distractor selection** — spec 014's fixture pack.
- **Confidence** — still uninformative; neither gate reads it.
