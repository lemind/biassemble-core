---
description: "Task list for VERIFY negated-claim polarity — containment then correctness"
---

# Tasks: VERIFY Negated-Claim Polarity

**Input**: [plan.md](./plan.md) (required — user stories, constraints, structure). No `spec.md`;
the two increments are defined in plan.md's Summary.

**Prerequisites**: none. Phase 1 and Phase 2 are zero-API and can start immediately.

**Tests**: **US1 only.** Per the CLAUDE.md coverage cap and spec 013 precedent, LLM/prompt
behaviour (US2) is proven by the offline screen and the golden set, never by fixtures in `tests/`.
US1 is orchestration logic and does take unit tests.

**Organization**: Phase 1–2 are shared and blocking; Phase 3 and Phase 4 are the two user stories
from plan.md and are independently shippable in that order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: `[US1]` containment, `[US2]` correctness. Setup/Foundational/Polish carry no label.

---

## Three failure classes — keep them separate

Two live runs produced three distinct defects that all end in a false `contradicted`. **They are not
one problem and must not be merged into one prompt block.**

| Claim | Run | Class | Stage at fault | In this spec? |
|---|---|---|---|---|
| `68da8ff4` | `9a784003` | **Negated claim + weaker affirmative evidence** — VERIFY polarity failure | VERIFY STEP 2 | **Yes — US2 primary** |
| `ed8b3a37` | `be72361c` | **Reporting claim + mixed passage set** — VERIFY STEP 1 fact-selection failure | VERIFY STEP 1 | **Yes — screened alongside, see T011** |
| `181d6ebb` | `be72361c` | **Referent widening** — "*the* article the post links to" became "*an* article on the website" | EXTRACT | **No — different contract, separate spec** |

### Incident 1 — `68da8ff4` (negation polarity)

| | |
|---|---|
| Claim | "The Pentagon has not issued an official finding on the Minab strike." (**true**, verbatim) |
| Cited evidence | C:6 — "…the Pentagon saying in a five-word statement to the Guardian: 'The incident is under investigation.'" |
| VERIFY's label | CONFLICT → `contradicted`, confidence 1.0 |
| Correct label | **PARTIAL → `partially_supported`** (T008, registered 2026-09-02) |

Sources A and B — Senate releases stating the investigation *"remains under review by senior
military officials"* — ranked **above** C (llm 90/90 vs 70) and were not cited.

### Incident 2 — `ed8b3a37` (reporting claim, mixed bundle)

| | |
|---|---|
| Claim | "Social media posts **claimed** the University of Rochester announced it will cut academic ties with Israel." (**true**) |
| Cited evidence | A:11 / B:11 — "administrators made no commitment… **as is being inaccurately reported on some social media channels**" |
| VERIFY's label | CONFLICT → `contradicted`, confidence 0.9 |
| Correct label | SAME → `supported` |

The cited sentence **confirms the reporting in its own subordinate clause** while rebutting the
content. The bundle also held three independent confirmations VERIFY did not cite: A:9 ("in recent
social media and other online posts the student activists claim to have won concessions"), B:1
(Newsweek's lede), and source C — the Fight Back! News post itself, at the highest llm rerank score
in the set (95).

**This is not a missing rule.** REPORTING CLAIMS has said since v4.2.0: *"A passage that confirms the
person said/claimed it, then adds its own separate rebuttal of the underlying content… is SAME…
Only a passage that says the person did NOT make the claim is CONFLICT."* The rule is on-point,
correctly worded, and was not applied. The failure is **STEP 1 selection under distractor pressure**:
given a bundle holding both the meta-fact and the object-fact, VERIFY reached for the object-fact.

**Blame, settled for both incidents — do not re-litigate:**

- **VERIFY prompt 4.6.0** — sole origin of both wrong labels. STEP 2 for incident 1, STEP 1 for
  incident 2.
- **`reconcileContradictedVerdicts`** (D026 §22/T064) returned `consistent: true` on both.
  Structurally blind: `checkReasonVerdictConsistency` receives claim + verdict + reason and **never
  the cited evidence text**, and is told to judge only whether the verdict follows from the reason.
  VERIFY's reason self-certifies, so `true` is correct under its own rules. Out of scope.
- **`escalation_replacement`** ([pipeline.service.ts:932](../../src/orchestrators/grounnel/pipeline.service.ts#L932))
  fired `escalation_no_valid_evidence` on **all three** contradicted claims across the two runs,
  discarding a tier-2 verdict each time. Did not cause any error; **kept** all three. That is US1 —
  but see T005, it only reaches two of the three.
- **Exonerated**: search, rerank, citation resolution, all 10 gates. EXTRACT is exonerated for
  incidents 1 and 2, and is the sole cause of incident 3.

---

## Phase 1: Setup (shared)

**Purpose**: freeze the evidence before the session that produced it is gone. Everything downstream
reads the frozen file, not the database and not this conversation.

- [ ] T001 Freeze **both** incidents, one file each, to `specs/014-verify-negated-claim-polarity/incident-9a784003.json` and `incident-be72361c.json` — separate files because they are separate failure classes and T009 draws different fixture rows from each. For `9a784003` / `68da8ff4`: the claim id and text, the raw VERIFY result object (prompt 4.6.0, 06:32:22Z, batch of 8, 14,973 input tokens), C:6 verbatim, Sources A and B with their "remains under review by senior military officials" sentences and rerank scores, the `consistency_check` response, the escalation-tier VERIFY result (`unsupported`, conf 0.9, `evidenceCitations: null`), and the `escalation_replacement` gate event. Record both `n_as_verify_numbered: 6` and `n_if_replayed_from_stored_excerpt: 4`. For `be72361c` / `ed8b3a37`: the claim, the A:11/B:11/B:20 citations and their verbatim text, the three uncited confirmations (A:9, B:1, source C's post) with rerank scores (100/90, 67/90, 33/95), both `consistency_check` responses, the tier-2 verdict **`supported`**, and the `escalation_replacement` event. Also capture `181d6ebb`'s EXTRACT excerpt and claim text as evidence for the separate referent-widening spec — do not build fixtures from it here.
- [ ] T002 [P] Delete thirteen spent scratch scripts from `scripts/` (housekeeping, unrelated to the semantic fix): `_q.ts`, `_tmp-check.ts`, `_tmp-check2.ts`, `_tmp-check3.ts`, `_tmp-check4.ts`, `_tmp-check5.ts`, `_tmp-v1.ts`, `_tmp-v2.ts`, `_tmp-v3.ts`, `_callcount.ts`, `_cmp2.ts`, `_re.ts`, `_t32check.ts`

**Checkpoint**: T003, T004 and T009 all read the frozen incident files. Do not start them first.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the two numbers that decide what ships. Both read persisted telemetry only — **zero
API cost**. This is D030 §3n, the step that refuted 7/7 `subject_entity` fix candidates in spec 013.

**⚠️ T004 can veto US1 outright.** T003 cannot veto US2 — see its note.

- [ ] T003 [P] Census the failure class in `scripts/t003-negated-contradiction-census.ts` — over all historical `grounnel_claims` with `verdict = 'contradicted'`, select rows whose `claim_text` matches `\b(not|never|no longer|has yet to|failed to|did not|does not|hasn't|haven't)\b`, hand-label each as genuine CONFLICT vs the weaker-affirmative mislabel, and report **false-CONFLICT rate on negated claims with N**
- [ ] T004 [P] Simulate the escalation exception in `scripts/t004-simulate-escalation-exception.ts` — replay every historical run carrying both a `contradicted` claim and an `escalation_replacement` event, and classify each affected case into exactly one of three buckets

**T003's gate, amended.** A small N means **no rate may be quoted** and wording must not be tuned
off the census — it does **not** block US2. Spec 013 T4's "too rare to decide from" governed
*whether to build a gate*; here a live Cardinal Rule violation already confirms the class exists.
Only T004's veto or a T011 failure cancels a ship. Record the number either way.

**T004's three buckets and the veto:**

| Bucket | Meaning | Effect |
|---|---|---|
| Correct `contradicted` released | The rule destroys a real contradiction | ❌ **veto** |
| Known-false `contradicted` released | The rule frees a false accusation | ✅ desired |
| Ambiguous / unknown | Cannot be labelled from telemetry alone | ⚠️ inspect by hand, report count separately |

**Pre-registered kill criterion: if bucket 1 is not ~0, do not ship US1.** A rule that trades real
contradictions for released false ones fails the Cardinal Rule in the other direction.

**Three known cases to score the simulation against** (all fired `escalation_no_valid_evidence`):

| Claim | Tier-2 verdict | Released by the T005 rule? |
|---|---|---|
| `68da8ff4` (run `9a784003`) | `unsupported` | ✅ yes |
| `181d6ebb` (run `be72361c`) | `unsupported` | ✅ yes — though the claim is a valid contradiction under EXTRACT's widened referent, so releasing it is neutral, not a win |
| `ed8b3a37` (run `be72361c`) | **`supported`** | ❌ **no, and that is correct** — see T007 limit 3 |

Report the simulation's bucket counts **and** how many locks the rule leaves standing. Two of three
is the expected, acceptable answer.

**Checkpoint**: US1 may begin only if T004's bucket 1 is ~0. US2 may begin regardless of T003.

---

## Phase 3: User Story 1 — Escalation may retract a contradiction (Priority: P1) 🎯 MVP

**Goal**: a wrong `contradicted` stops being permanently locked once an escalation tier disagrees.

**Independent test criteria**: replaying run `9a784003` through the new predicate yields
`unsupported` for claim `68da8ff4` instead of `contradicted`, and every unit test in T006 passes.
Deliverable on its own, with no prompt change.

**⚠️ This is containment, not correctness.** It converts the incident's outcome from `contradicted`
to `unsupported`. The claim is **true** and belongs at `supported` — that is US2. Ship them as
separate change sets and never report US1 as fixing the class.

- [ ] T005 [US1] Widen the escalation-replacement floor in `src/orchestrators/grounnel/pipeline.service.ts` (line ~932) so an evidence-empty tier may retract a contradiction: when `prior.verdict === "contradicted"` and the replacement verdict is in `{"unsupported", "unverifiable"}`, accept the replacement; every other combination keeps today's `rejectReplacement` behaviour
- [ ] T006 [US1] Add unit tests in `tests/` for the four branches — prior `contradicted` + empty `unsupported` → **accepted**; prior `contradicted` + empty `unverifiable` → **accepted**; prior `contradicted` + empty `supported` or `partially_supported` → still rejected; prior `supported` + empty replacement → still rejected (behaviour unchanged)
- [ ] T007 [US1] Record the change as an addendum to D030 §3h in `docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md`, including T004's three bucket counts and the two limits below

**Three limits to state in T007, so US1 is not over-claimed:**

1. The exception only helps when escalation runs at all — it is skipped entirely if the primary pass
   hit a rate limit (D026 §13) and is bounded at 2 tiers. It is a net, not a guarantee.
2. `unverifiable` is included deliberately: an escalation tier can land on either label, and naming
   only `unsupported` would leave the other as the next lock.
3. **The UR-shaped lock is out of scope for Phase 1, by design.** Incident 2's tier 2 returned
   **`supported`** with no valid citations, and T005 rejects that — correctly. Widening the rule to
   "any non-`contradicted` replacement retracts" would install **citation-less `supported` as an
   escape hatch**, which is a false-affirmation hole in exchange for closing a false-accusation one.
   Do not do it. Containment for that shape is either an evidence-**backed** `supported` getting
   through `guardEscalatedContradictionReversals`, or VERIFY not emitting `contradicted` at all
   (US2). US1 reaches two of the three known locks; say so plainly rather than rounding up.

**Checkpoint**: US1 shippable and independently verifiable.

---

## Phase 4: User Story 2 — VERIFY labels negated claims correctly (Priority: P2) — **POST-MVP**

**Goal**: the wrong label is not produced in the first place.

**Not MVP.** False `contradicted` runs at ~2% of claims; false `supported` runs at 25–35% on
student-style writing ([spec 015](../015-evidence-provenance-floors/tasks.md)). 015's two gates are
deterministic, zero-API and cannot be vetoed by a screen. This phase is the most expensive work on
either board, is the only work that spends Gemini budget, and rests on a premise with an 0-for-4
live record. It runs after 015 ships, or not at all.

**Independent test criteria**: all eight negation rows hit their T008-registered target, all six
controls hold, R1–R6 hold, and `contradicted` precision does not fall.

**⚠️ T008 strictly precedes T009.** The fixture shape being copied
([eval-t27b-prompt-variants.ts:30-36](../../src/jobs/eval-t27b-prompt-variants.ts#L30-L36)) requires
a literal `expect` value on every fixture. If the pack is written first, four of the eight rows have
no label to put there, the author guesses, and T008 is then written to match code that already
exists — which is exactly the post-hoc tuning T008 exists to prevent.

> **The premise of this phase is a hypothesis, not a plan.** Do not write anywhere that "a
> well-worded section fixes a shape." The measured record in this repo is **two of two against**:
>
> - **v4.3.0 SEQUENCE POSITION** — added for the Wright-brothers ordinal, failed live 2/2, reverted
>   at v4.4.0. The real fix was a deterministic gate, not prompt text.
> - **v4.2.0 REPORTING CLAIMS** — added for the Bukowski case, correctly worded, on-point, and
>   **did not fire** on incident 2 under a mixed passage set.
>
> A third section is worth screening. It is not worth assuming. **Do not write prompt text into
> `system.json` before T008-T012.**

- [x] T008 [US2] Pre-register every target label in `specs/014-verify-negated-claim-polarity/plan.md` under a dated "Fixture semantics" section — each of the **24 rows** gets a written **relationship** *and* its **step-3 verdict**, decided before any fixture code exists and before any call is made. **DONE 2026-09-02** — see plan.md § Fixture semantics (T008)
- [ ] T009 [US2] Build the fixture pack in `src/jobs/eval-negation-polarity.ts` — all 24 rows tabulated below, copying the fixture/role/expect shape of `src/jobs/eval-t27b-prompt-variants.ts`, with every `expect` field filled from plan.md § Fixture semantics. **Five preconditions below must all hold before this file is written.**
- [ ] T010 [US2] Register the screen job in `src/jobs/inngest-functions.ts` and add `scripts/trigger-eval-negation-polarity.ts` plus a `package.json` script entry, mirroring `trigger-eval-t27b.ts`
- [ ] T011 [US2] Run the offline screen — ≥3 candidate wordings of the prompt block, spliced into the live prompt between two markers so every variant shares an identical preamble and footer; **state the exact call count before spending**
- [ ] T012 [US2] Ship VERIFY 4.7.0 in `src/prompts/grounnel/verify/system.json` — the winning block only, plus a `notes` entry naming the incident, run id and screen result, matching how 4.1.0–4.6.0 are recorded
- [ ] T013 [US2] Add golden cases `g30`+ to `evaluations/golden/grounnel/live-eval-golden-set.json` for predicate-strength negation, including at least one `kind: "false"` counterpart


**T009's five preconditions — all must hold, or do not write the file:**

1. plan.md § Fixture semantics is filled and dated. ✅ **2026-09-02**
2. Two variant strings, `block_a` and `block_b`, **never concatenated**.
3. A combined `block_a + block_b` variant may exist as a **third** variant, and only to measure
   whether they interfere — never as the thing intended to ship.
4. Kill criterion unchanged: negation rows **and** R1–R6 / C1–C5, or no 4.7.0.
5. **Nobody triggers the Inngest job until 015's G1/G2 simulations exist.** Writing this file is not
   permission to spend.

### The fixture axis this incident revealed

**The golden set already covers negated claims — narrowly.** `g25`–`g29` are five negated cases,
all `kind: "true"`, all `minCorrectRate: 1.0`, all passing at 28/28. Every one negates a
**substituted entity or value** where the evidence names the correct alternative: *not London*
(Paris), *not Microsoft* (Apple), *not first* (Armstrong), *not 1943* (1945), *not built by the
Roman Empire* (Chinese dynasties). The model only has to spot the alternative.

| Shape | Covered? |
|---|---|
| `NOT X` → evidence says `Y` | ✅ `g25`–`g29`, 5/5 passing |
| `NOT strong-X` → evidence says **weaker-X** | ❌ **absent — this incident** |

No alternative entity exists to key off in the second shape. That is why 28/28 did not catch this,
and it is the axis T013 must add permanently.

### Fixtures (T009, labels from T008)

| # | Claim | Evidence | Target |
|---|---|---|---|
| 1 | Pentagon has **not issued an official finding** | incident is **under investigation** | *T008* |
| 2 | Company has **not made a final decision** | proposal **remains under review** | *T008* |
| 3 | Government has **not approved** the measure | measure is **being considered** | *T008* |
| 4 | Pentagon has **not issued an official finding** | Pentagon **officially concluded** X | CONFLICT |
| 5 | Company has **not announced** the acquisition | company **announced** the acquisition | CONFLICT |
| 6 | Government has **not approved** the law | Parliament **approved** the law | CONFLICT |
| 7 | Pentagon has **not issued an official finding** | Pentagon **issued a statement saying** the incident is under investigation | *T008* |
| 8 | Pentagon has **not issued an official finding** | Pentagon **issued an official finding that** X occurred | CONFLICT |

### Controls (T009, labels from T008) — these are what stop an over-correction from scoring well

| # | Control | Target | Guards against |
|---|---|---|---|
| C1 | **Affirmative** claim "Pentagon issued an official finding" + "incident is under investigation" | PARTIAL — **not** CONFLICT | the fix leaking into affirmative claims |
| C2 | Negated claim + genuinely unrelated evidence | ABSENT → `unsupported` | inferring negation from silence |
| C3 | Negated claim + evidence of the negated event at full strength phrased *beside* hedging language ("the investigation continues, and the Pentagon's official finding released Tuesday concluded X") | CONFLICT | swallowing real findings that sit next to "investigation continues" |
| C4 | `g25`–`g29` regression check — **see the OPEN note below, this is not free** | all still correct | regression on the already-covered sub-shape |

### Distractor rows R1–R4 — required, not optional

A screen made of clean pairs ("reporting claim + one confirming sentence") **would have passed
4.6.0**, because REPORTING CLAIMS scores fine in isolation. Incident 2 proves the live failure mode
is STEP 1 selection when one bundle holds the meta-fact, the object-fact and the source together.
Every row below puts all of them in **one** `passage_sentences` bundle.

| Row | Bundle contents | Target |
|---|---|---|
| R1 | confirm-posts-said + rebuttal-of-content (incident 2 verbatim) | **SAME → `supported`**, citing the confirming sentence. The "inaccurately reported" clause may be cited as *additional* support; citing it as CONFLICT is the failure |
| R2 | confirm + the post itself as a source + rebuttal | **SAME → `supported`**. Must not cite the rebuttal alone |
| R3 | only "the posts did not say that" | **CONFLICT → `contradicted`** |
| R4 | only the object-fact, no reporting sentence anywhere | **ABSENT → `unsupported`** — must not "helpfully" answer the object-level question it was not asked |
| C1′ | **affirmative** claim "UR cut academic ties" + the *same* mixed bundle | object-fact rules apply → CONFLICT. Must not be forced to SAME merely because posts exist |
| R5 | claim about what a course **taught** someone + a bundle whose only on-topic sentence is about that course becoming **required** (run `fddb57fa`, the ISP100 row) | **ABSENT → `unsupported`**. Same STEP 1 family: an adjacent fact about the same named entity is not the asserted fact |
| R6 | claim about **why an artist painted** a work + a bundle whose only on-topic sentence is about a **theft and forgery rumour** concerning the same work (run `9ec37df1`) | **ABSENT → `unsupported`** |
| C5 | **near-miss that must stay on-point**: same subject, *narrower wording of the **same** predicate* — e.g. "has not issued an official finding" + "the investigation remains under review" | **must NOT be ABSENT** — this is a T008 polarity row, not a distractor row | the mirror rule cannibalising the negation fix |

**R7 dropped, deliberately.** The plumbonacrite row (visual texture claimed, pigment chemistry cited)
was originally listed here as ABSENT. It is **not clean**: a conservator would reasonably treat lead
compound analysis as mechanism evidence for surface texture, making the honest target PARTIAL or even
SAME. Marking it ABSENT would train the screen to reward discarding real mechanism evidence. An
ambiguous fixture is worse than no fixture — it is out of the pack.

**C5 is the row that stops the two fixes fighting.** The mirror rule says "same subject, different
predicate → ABSENT." The negation fix says "same subject, weaker form of the *same* predicate →
SAME/PARTIAL." Those are one character apart in the model's eyes. Without C5, a candidate block can
score well on R5/R6 by turning every weaker-same-predicate sentence into ABSENT — which destroys T008
and re-breaks `68da8ff4`. C5 must hold for any candidate to pass.

**R1/R2 are governed by REPORTING CLAIMS, not by the mirror rule.** For `ed8b3a37` the target stays
**SAME on the reporting predicate**; the illegal move is CONFLICT on the object-fact. If a candidate
block makes reporting-claim rows read as ABSENT, the two sections are fighting and T011 becomes
unreadable. Write the mirror so it explicitly defers to REPORTING CLAIMS.

R3 and R4 are the over-correction guards: R3 proves a real reporting contradiction is still
reachable, R4 proves the fix does not turn silence into an answer. C1′ proves the meta-fact
preference does not leak into object-level claims.

**These rows ship in the T011 screen even though the candidate block is about negation.** The two
classes are separate (see Three failure classes) and must not be merged into one block — but a
4.7.0 that fixes negation while still false-accusing reporting claims is not shippable, so both
must be measured in the same run.

> **OPEN — C4 has no cheap implementation.** A golden case stores only an article `text` plus
> `claims: [{match, kind}]`; there are no passages, no `passage_sentences`, no evidence text, and
> `evaluations/golden/grounnel/live-eval-fixtures/` holds nothing but `.gitkeep`. Evidence is produced
> by live search + rerank at run time. So `g25`–`g29` **cannot** be "re-run as VERIFY-only fixtures" —
> there is nothing to feed VERIFY. Two options, pick one before T009:
> 1. **Capture once, freeze.** Run the five cases live once, persist their selected passages into
>    `live-eval-fixtures/`, and replay those as VERIFY-only fixtures. Costs one small live run and
>    makes C4 permanent. Note the replay skips retrieval, which is part of what `g25`–`g29` prove.
> 2. **Drop C4.** Accept that regression on the covered sub-shape is caught only by T013's
>    post-ship golden run. Cheaper, weaker, and moves the risk after the ship.
>
> **Direction given (2026-09-02): option 1 — resolve empirically, capture and freeze.** Sequenced
> after T001/T003, not before; it is the only live spend in Phase 2–4 outside the screen itself.

### T008 — the two decisions that must be written down first

**(a) SAME or PARTIAL for rows 1, 2, 3 and 7? Default PARTIAL.** SAME maps to `supported`, which
would have VERIFY *affirm* a negative claim off weak compatible evidence — a false-affirmation risk
in the opposite direction, against a prompt whose CORE PRINCIPLE is "false positives are worse than
false negatives". PARTIAL (`partially_supported`) removes the false accusation without buying that
risk. Compatible does not mean supported: uncertainty should stay uncertainty unless the evidence
actually establishes the negative proposition. **SAME may only be chosen per-row with a separate
written justification** — note that this run's real evidence was *stronger* than row 1 in isolation
(A and B said "remains under review"), so SAME may be right for the live case and wrong for the
bare fixture. Do not let the pack default to SAME.

**(b) C2's target is `unsupported`, not `unverifiable`.** Under the live prompt's own STEP 3
mapping ABSENT → `unsupported`; `unverifiable` is only a confidence-threshold downgrade applied
*after* the relationship is fixed. Scoring C2 against `unverifiable` would mis-score the screen.

Recording both **before** T011 is what stops the screen becoming post-hoc prompt tuning.

### T011 — placement, scope and pass bar

**Placement — the family is not contiguous, so pick one anchor.** The live section order in
`system.json` is:

```
QUALIFIED RANK VS ABSOLUTE SUPERLATIVE  →  ATTRIBUTION STRENGTH  →  DATE PRECISION
→  REPORTING CLAIMS  →  INFERENCE TOLERANCE  →  PARALLEL CLAIMS
```

The three rules that already teach "a weaker form in the evidence is PARTIAL, not CONFLICT" —
QUALIFIED RANK, ATTRIBUTION STRENGTH, INFERENCE TOLERANCE — are separated by DATE PRECISION and
REPORTING CLAIMS. **No single insertion point sits alongside all three**, so the block goes in one
place and the "family" framing is rationale, not a location.

**⚠️ Splice hazard.** `buildVariantPrompt`
([eval-t27b-prompt-variants.ts:144-151](../../src/jobs/eval-t27b-prompt-variants.ts#L144-L151)) does
`slice(0, start) + block + slice(end)` — it **replaces everything between the two anchors**. Anchoring
on `"QUALIFIED RANK"` → `"PARALLEL CLAIMS"` to reach the whole family would silently delete
ATTRIBUTION STRENGTH, DATE PRECISION and REPORTING CLAIMS from every variant, and the screen would
then score C1/C3 against a prompt production does not run. **Anchor on exactly one section boundary.**

> **OPEN — decide before T011.** Which single anchor: immediately after ATTRIBUTION STRENGTH (tightest
> topical neighbour, but adjacent to DATE PRECISION), or immediately after INFERENCE TOLERANCE (the
> general entailment rule, but two sections past REPORTING CLAIMS)? Note REPORTING CLAIMS pulls the
> wrong way here — it is the only rule about a statement being made, and it teaches that confirming
> the *act* of stating is SAME. Record the choice and the anchor strings with the T008 registration.

**Scope**: narrow — *negated claim + weaker affirmative evidence*. **Not** a general negation rule,
which risks teaching VERIFY to infer negation everywhere.

**Budget**: fixture-level VERIFY calls only, no full pipeline runs. **24 rows** (8 negation + R1–R6 + C1/C2/C3/C5/C1′ + C4's five `g25`–`g29` cases, if C4 survives
its OPEN note) × ≥3 variants × repeats; compute the exact
number from the harness's batching and state it before running. For scale, the full golden set is
**~1680 calls** and is **not** part of T011.

**Pass bar, pre-registered**: all 8 negation fixtures hit their T008 target, **all four controls
hold**, **all five distractor rows R1–R4 and C1′ hold**, and `contradicted` precision does not fall.
A candidate that fixes rows 1–3 but breaks C1 or C3 is a refutation, not a partial win. Judge on the
**false-CONFLICT rate on negated claims**, not on whether `68da8ff4` alone flips.

**Kill criterion, not a footnote: if the screen cannot hold R1–R4 and the negation rows together,
do not ship 4.7.0.** The next move after a failed screen is **not** a fourth paragraph — that would
be the third prompt section added on the same reasoning that has already failed twice. It is one of:

1. **STEP 1 isolation** — verify reporting claims in a separate call, or with a filtered passage
   view, so the object-fact is not in the bundle to be selected. Structural, not textual.
2. **A schema field before `verdict`** — make "name the claim's asserted predicate" an output field
   the model must fill *before* choosing a label. T27's finding holds: Gemini generates in schema
   order, so a field placed before `verdict` can shape it while one placed after cannot. This is the
   only upgrade that makes "name the predicate" non-decorative rather than another paragraph.
   **Do not add it in the same change as 4.7.0** — one instrument at a time, or neither result is
   readable.
3. **Containment only** — ship US1, leave VERIFY at 4.6.0, and accept the known false-accusation
   rate until a structural fix is designed.

**Assume a text-only splice can fail the same way.** SUBJECT ENTITY shipped with a worked example
and did not fire; the mirror is the same instrument pointed the other way. "It's a mirror of an
existing rule" is a reason to screen it, not evidence it will hold.

Record which, and why, in D030 rather than opening a fourth wording round.

### T013 — golden-set budget

A full golden-set run before and after T012 is **~1680 calls each way**. Do not book it without an
explicit yes.

**A `g30`+ case cannot be run by the T011 screen.** Cases written in the golden schema
(`text` / `claims[{match, kind}]`) are full-pipeline cases by construction — they carry no passages,
so a VERIFY-only fixture harness cannot execute them. The earlier claim that the minimum guard is
"C4 plus `g30`+ inside the T011 screen job" was wrong on both halves. What is actually available:

| Option | Cost | What it guards |
|---|---|---|
| Screen-only fixtures (the 8 + C1–C3) | included in T011 | the new sub-shape, pre-ship |
| C4 via captured frozen passages | one small live run | the covered sub-shape, pre-ship, retrieval skipped |
| `g30`+ as golden cases | a golden run, ~1680 calls | both sub-shapes end-to-end, **post-ship only** |

Include at least one `kind: "false"` negated case so the additions cannot be passed by a model that
has simply learned "negated ⇒ supported".

**Checkpoint**: US2 shippable; the class is now fixed at source, not merely contained.

---

## Deferred — not MVP

Recorded, unscheduled, **no task IDs**: these are low-severity and must not compete with Phase 0–3.

- Citation-index provenance defect — `grounnel_search_pages.excerpt` is built against the *search
  query* and newline-collapsed, so VERIFY's `{source, n}` numbering is not reproducible from the DB.
  Grounding is unaffected (resolved evidence *text* survives); this is forensics debt. The schema
  comment at `src/db/schema.ts:458` is inaccurate for both consumers and should be corrected whenever
  that file is next touched.
- `.specify/memory/constitution.md` is an unfilled template, so `/speckit-plan`'s Constitution Check
  cannot be evaluated. Fill it or delete it.
- `.specify/feature.json` still points at `specs/012-…`; speckit scripts need
  `SPECIFY_FEATURE_DIRECTORY` set by hand until it moves.

## Dependencies & execution order

```text
T001 (freeze)
  ├── T002 [P]
  └── Phase 2 ─┬── T003 [P]  census ────────────► informs US2, cannot block it
               └── T004 [P]  simulate ──────────► VETO GATE for US1
                              │
                              ▼ (bucket 1 ~0)
                    Phase 3  US1  T005 → T006 → T007        ← MVP, ships alone
                              │
                              ▼
                    Phase 4  US2  T008 → T009 → T010 → T011 → T012 → T013
                                  (labels) (pack) (wire)  (screen)   ← POST-MVP
```

**Hard orderings**: T001 before everything. T004 before T005. **T008 strictly before T009** — the
labels must exist before the pack that must carry them; this is the whole anti-tuning safeguard.
**T009 before T010** — `inngest-functions.ts` top-level-imports the job module into one shared
`base` array, so registering before the module exists fails the build and de-registers *every*
Inngest function, not just this one. T010 before T011. T011 before T012.

**Parallel opportunities**: T003 ∥ T004 (different scripts, both read-only). T002 ∥ all of Phase 2.
Phase 0–2 here ∥ spec 015's simulations. **Nothing inside Phase 4 is parallelisable** — T008
through T012 is a strict chain.

## Implementation strategy

**MVP = User Story 1.** It is code-only, zero prompt risk, gated on a zero-API simulation, and
removes the false accusation from this incident's outcome. Ship it alone.

**Then User Story 2**, as a separate change set. It is the only thing that makes the verdict
*correct* rather than merely not-accusatory. Bundling the two would let an improved Cardinal Rule
number read as an accuracy win it has not earned.

## Explicitly out of scope

- **`consistency_check` / `checkReasonVerdictConsistency` evidence access.** A real defect — the
  auditor cannot see what it is auditing — but a different component with its own review history
  (spec 013 T21's lesson). Separate spec, separate change set.
- **The 10 gates.** None models "does this sentence entail the negation", and none should be taught
  to. No gate change would have caught this.
- **`SENTENCE_SPLIT_RE` / citation numbering.** T014 records it; nothing in this feature rewrites it.
- **Anything from spec 013** — eligibility, the `subject_entity` disable, Zod field order. Do not
  bundle.
- **False `supported` from self-citation or missing citations** — [spec 015](../015-evidence-provenance-floors/tasks.md).
  Different mechanism, opposite direction of harm, and larger: 25% of claims in run `fddb57fa` vs the
  ~2% false-accusation rate here. **015 runs in parallel with this spec**, on the condition that the
  two never share a deploy and never both touch `src/prompts/` — 015 never does. Only the ISP100 row
  (R5 above) crosses over, because it is a STEP 1 defect rather than a provenance one.
