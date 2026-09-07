# Implementation Plan: VERIFY Negated-Claim Polarity

**Branch**: `014-gr-upd4` | **Date**: 2026-09-02 | **Spec**: not written — scope defined in this plan's Summary

**Input**: Live incident, production run `9a784003-4cd7-4923-9a4c-a0b9ae18f74a`, claim `68da8ff4-8d3e-4172-950d-d8d805417451`

---

## Summary

A **true** claim — "The Pentagon has not issued an official finding on the Minab strike." — was
returned `contradicted` at confidence 1.0. That is a false accusation: a Cardinal Rule violation,
not a recall miss.

VERIFY cited Source C sentence 6 ("…the Pentagon saying in a five-word statement to the Guardian:
'The incident is under investigation.'") and labelled the relationship CONFLICT. An ongoing
investigation is compatible with — and here evidences — the absence of a completed official
finding. VERIFY dropped the qualifier `official finding`, kept the bare speech act
`issued a statement`, and evaluated that affirmative fragment against the negation.

**Failure class**: negation over a *predicate-strength / speech-act qualifier*, where the evidence
contains a **weaker affirmative of the same predicate family**.

**A second live run (`be72361c`, 2026-09-02) added two more classes.** They are distinct and are
deliberately not merged — see tasks.md "Three failure classes":

| Claim | Class | Fault | Scope |
|---|---|---|---|
| `68da8ff4` | negated claim + weaker affirmative evidence | VERIFY **STEP 2** | US2 primary |
| `ed8b3a37` | reporting claim + mixed passage set | VERIFY **STEP 1** fact selection | screened alongside US2 |
| `181d6ebb` | referent widening (*the* article → *an* article) | **EXTRACT** | out — separate spec |

**The premise has been downgraded.** Incident 2 was not a missing rule: REPORTING CLAIMS has covered
that shape correctly since v4.2.0 and did not fire. With v4.3.0 SEQUENCE POSITION already reverted
after failing live, the record for "add a prompt section to fix a claim shape" is **two of two
against**. US2 is a screened hypothesis with a pre-registered kill criterion, not a planned fix.

**Technical approach**: two independently-shippable increments, in dependency order, with a
zero-cost measurement gate in front of both.

| | Increment | What it delivers | Kind |
|---|---|---|---|
| **US1** (P1) | Escalation may retract a contradiction | A wrong `contradicted` stops being permanently locked once an escalation tier disagrees | **Containment** |
| **US2** (P2) | VERIFY labels negated claims correctly | The wrong label is not produced in the first place | **Correctness** |

**US1 and US2 are not substitutes.** US1 turns incident 1's outcome into `unsupported`; the claim is
true and belongs at `supported`. Shipping US1 must not be reported as fixing the class.

> **STATUS 2026-09-02 — US1 IS REFUTED.** T004's simulation of the escalation exception against all
> 49 historical `escalation_replacement` rejections showed it would release 41, of which **~38 are
> correct contradictions on golden `kind: false` claims** (Bukowski, Wright, Apollo-on-Mars,
> Amazon-electronics, CSS-before-Internet, first-mouse-wireless, Apple-by-Gates, Eiffel-in-London)
> against **1** genuine false accusation freed. The pre-registered criterion was "bucket 1 must be
> ~0"; it is ~38. **D030 section 3h's floor is doing its job and must not be widened.** Phase 3 is
> cancelled. `68da8ff4` has no containment path; only US2 (post-MVP, unproven) remains.
>
> T003 also **corrected this plan**: the golden negation cases are not "all passing". `g27` (Aldrin,
> ordinal) and `g28` (WWII, year) false-accuse at **8.1%** and **10.8%** over ~37 runs each, while
> the three entity-substitution cases are clean at 0%. The unreliable sub-shape is negation over an
> **ordinal or a year**, not negation generally.

**US1 reached two of the three known locks, by design — before it was refuted.** `escalation_replacement` fired
`escalation_no_valid_evidence` on all three contradicted claims across both runs. Incident 2's
tier 2 returned **`supported`** with no citations, and US1 rejects that deliberately — accepting it
would install citation-less `supported` as an escape hatch, trading a false-accusation hole for a
false-affirmation one. That lock is out of scope for Phase 1 and is US2's to close.

## Technical Context

**Language/Version**: TypeScript 5.9.3, Node 22, ESM

**Primary Dependencies**: `@google/generative-ai` 0.21.0 (Gemini — the only LLM provider here),
`drizzle-orm` 0.40.0, `inngest` 3.54.2 (eval jobs), `zod` 4.4.3

**Storage**: Postgres (Supabase) `grounnel` schema via Drizzle — `grounnel_claims`,
`grounnel_llm_calls`, `grounnel_gate_events`, `grounnel_search_pages`, `grounnel_rerank_decisions`.
Upstash Redis is authoritative for live run state (D023 §7); Postgres is best-effort history and is
what both Phase 2 (Foundational) tasks read.

**Testing**: `vitest` 3.2.4 (1241 tests currently green). Prompt behaviour is **not** unit-tested
per the CLAUDE.md coverage cap — it is proven by an offline Inngest screen job and the live golden
set. Orchestration logic (US1) does take unit tests.

**Target Platform**: Vercel serverless (`maxDuration: 300`), Fastify for local runs

**Project Type**: private HTTP API (web service)

**Performance Goals**: N/A — this feature changes verdict correctness, not throughput

**Constraints**:
- **Cardinal Rule**: a false accusation is the failure mode being fixed; no change may increase
  false accusations in any other direction to buy this one.
- **Eval budget**: measure the minimum, state the spend before spending. Gemini is prepaid credit,
  not a daily quota. The full golden set is **~1680 calls** and is not part of this plan without an
  explicit yes.
- **No deploy.** No commits without an explicit ask.
- Cost model: **~2.9 Gemini calls per claim measured**. Budget with the rounded-up rule of thumb
  `claims × 3 + 1` per run — an upper bound, not the measured figure.

**Scale/Scope**: one orchestration one-liner plus tests (US1); one prompt block plus a fixture
screen job and golden-set additions (US2). Two Phase 2 scripts, both zero-API.

## Constitution Check

*GATE: must pass before any task in tasks.md begins. Re-checked before US2 ships.*

`.specify/memory/constitution.md` **is an unfilled template** — every principle is still a
`[PRINCIPLE_N_NAME]` placeholder, so there are no ratified constitutional gates to evaluate against.
Rather than invent them, this plan is gated on the project's actual governing rules, which are
written down elsewhere and are binding in practice:

| Gate | Source | Status |
|---|---|---|
| Simulate against persisted telemetry before writing production code | D030 §3n | **PASS** — Phase 2 (T003, T004) precedes all code; this is the step that refuted 7/7 `subject_entity` fixes in spec 013 |
| False positives are worse than false negatives | VERIFY prompt CORE PRINCIPLE | **PASS** — drives the PARTIAL-over-SAME default in T008 and control C1/C3 in T009 |
| Prompt changes are screened offline before shipping | spec 013 T27b; v4.3.0→v4.4.0 revert | **PASS** — T011 gates T012 |
| No unit tests for LLM behaviour; golden set instead | CLAUDE.md coverage cap | **PASS** — tests only on T006 |
| Measure before building | spec 013 T3/T4 precedent | **PASS with amendment** — see Complexity Tracking |

**Recommendation, not part of this feature**: fill in `constitution.md`, or delete it so
`/speckit-plan` stops reporting a gate that cannot be evaluated.

## Project Structure

### Documentation (this feature)

```text
specs/014-verify-negated-claim-polarity/
├── plan.md                     # This file
├── tasks.md                    # Task breakdown
└── incident-9a784003.json      # T001 output — the frozen artifact every later task reads
```

`research.md`, `data-model.md`, `quickstart.md` and `contracts/` are **not generated**: this
feature adds no entities, no external interface, and no new dependency to research. The unknowns
this feature does have are empirical, not architectural, and are resolved by T003/T004 rather than
by a research document.

### Source Code (repository root)

```text
src/
├── orchestrators/grounnel/
│   ├── pipeline.service.ts          # US1 — escalation-replacement floor (line ~932)
│   └── passage-sentences.ts         # read-only; citation numbering (backlog item only)
├── prompts/grounnel/verify/
│   └── system.json                  # US2 — 4.6.0 → 4.7.0
├── jobs/
│   ├── eval-t27b-prompt-variants.ts # pattern to copy for the screen harness
│   ├── eval-negation-polarity.ts    # US2 — new screen job
│   └── inngest-functions.ts         # register the new job
└── providers/search/hybrid-provider.ts  # backlog only, not touched

scripts/
├── t003-negated-contradiction-census.ts   # Phase 2, zero-API
├── t004-simulate-escalation-exception.ts  # Phase 2, zero-API
└── trigger-eval-negation-polarity.ts      # US2 trigger

tests/
└── (US1 only — escalation replacement branch)

evaluations/golden/grounnel/
└── live-eval-golden-set.json        # US2 — new cases g30+
```

**Structure Decision**: no new module boundaries. US1 is a predicate change inside an existing
private method; US2 is a prompt block plus a screen job that copies the established
`eval-t27b-prompt-variants.ts` shape (kept in spec 013 T29 precisely as the standing screen for
prompt changes). Everything else is scripts and fixtures.

## Fixture semantics (T008) — pre-registered 2026-09-02

**24 rows.** Every row carries a relationship *and* its STEP 3 verdict, fixed **before** any fixture
code exists and before any call is made. Recording this first is what stops T011 becoming post-hoc
tuning. Do not edit a target after seeing a screen result; a target that turns out wrong is a
finding to write up, not a number to adjust.

### Negation rows — Block A

| # | Claim | Passage | Relationship | Verdict |
|---|---|---|---|---|
| 1 | Pentagon has **not issued an official finding** | incident is **under investigation** | PARTIAL | `partially_supported` |
| 2 | Company has **not made a final decision** | proposal **remains under review** | PARTIAL | `partially_supported` |
| 3 | Government has **not approved** the measure | measure is **being considered** | PARTIAL | `partially_supported` |
| 4 | Pentagon has **not issued an official finding** | Pentagon **officially concluded** X | CONFLICT | `contradicted` |
| 5 | Company has **not announced** the acquisition | company **announced** the acquisition | CONFLICT | `contradicted` |
| 6 | Government has **not approved** the law | Parliament **approved** the law | CONFLICT | `contradicted` |
| 7 | Pentagon has **not issued an official finding** | Pentagon **issued a statement saying** the incident is under investigation | PARTIAL | `partially_supported` |
| 8 | Pentagon has **not issued an official finding** | Pentagon **issued an official finding that** X occurred | CONFLICT | `contradicted` |

**Why PARTIAL, not SAME, on 1/2/3/7 — one reason, applied uniformly.** An ongoing process is
*compatible with* and *evidences* the absence of a completed finding, but does not *establish* it:
the finding could have been issued after the quoted statement. Under CORE PRINCIPLE ("false
positives are worse than false negatives") the conservative label is the right one, and PARTIAL
already removes the false accusation, which is the whole point. Row 7 was considered for SAME —
it confirms the only issuance *was* a statement — and rejected for the same reason: it still does
not exclude a later finding. **No row defaults to SAME.**

### Distractor rows — Block B

| # | Claim | Passage | Relationship | Verdict |
|---|---|---|---|---|
| R1 | posts **claimed** UR announced a cut | confirm-posts-said **+** rebuttal-of-content | SAME | `supported` |
| R2 | same | confirm **+** the post itself **+** rebuttal | SAME | `supported` |
| R3 | same | only "the posts did **not** say that" | CONFLICT | `contradicted` |
| R4 | same | only the object-fact, no reporting sentence | ABSENT | `unsupported` |
| R5 | ISP100 **taught** her writing is personal | ISP100 becoming **required** | ABSENT | `unsupported` |
| R6 | Leonardo painted it **because of** light on curves | a **forgery rumour** about the work | ABSENT | `unsupported` |

**R1–R4 are governed by REPORTING CLAIMS, not Block B.** Their targets are SAME/CONFLICT/ABSENT on
the *reporting* predicate. If a Block B variant makes them read ABSENT, the two sections are
fighting and that variant is refuted. **R5 and R6 are the Block B rows.**

### Controls

| # | Setup | Relationship | Verdict | Fails if |
|---|---|---|---|---|
| C1 | **affirmative** "Pentagon issued an official finding" + "under investigation" | PARTIAL | `partially_supported` | it reads CONFLICT (Block A leaked into affirmatives) or SAME |
| C2 | negated claim + genuinely unrelated evidence | ABSENT | `unsupported` | negation inferred from silence |
| C3 | negated claim + the negated event at full strength, phrased beside hedging language | CONFLICT | `contradicted` | a real finding swallowed by "investigation continues" |
| C5 | "has not issued an official finding" + "the investigation remains under review" | PARTIAL | `partially_supported` | it reads ABSENT — **Block B ate Block A** |
| C1′ | **affirmative** "UR cut academic ties" + the mixed bundle | CONFLICT | `contradicted` | forced to SAME because posts exist |
| C4 | `g25`–`g29`, five golden cases | unchanged | their existing `kind: "true"` expectations | any regression on the covered negation sub-shape |

**C5 is deliberately row 1 repeated.** Its only job is to fail any Block B variant whose two
deference sentences have been weakened or dropped. If C5 and row 1 ever disagree, the variant is
refuted regardless of how the other rows scored.

### Block wording, decided

- **Block A** must say **"weaker or compatible"**, never "related". "Related affirmative" is loose
  enough to let an official finding count as a related speech act, which walks straight back into
  CONFLICT — or, in the other direction, lets a real finding read as compatible. The load-bearing
  phrases are *weaker or compatible* and *CONFLICT only at the claimed strength*.
- **Block A** says "supports" rather than naming a label, so the identical text is screenable under
  either a SAME or PARTIAL decision. With PARTIAL now fixed above, keep the hedge anyway — it costs
  nothing and avoids re-writing the block if a row moves.
- **Block B's two deference sentences are the block.** One excludes weaker-or-narrower forms of the
  *same* predicate (Block A's territory); the other defers to REPORTING CLAIMS. Deleting either is
  what C5 and R1 exist to catch.
- **"Name the predicate before citing" is decorative in a text splice.** It becomes real only as a
  schema field emitted **before** `verdict` (T27's ordering finding). T011 does not add that field,
  so **expect Block B to be able to fail exactly the way SUBJECT ENTITY failed.** A pass on clean
  pairs is not evidence it will fire live.

## Complexity Tracking

> Deviations from the templates and from the reviews, with justification.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Tasks organised by phase-then-story, not purely by user story | Phase 2 is a genuine hard gate that can cancel US1 outright; both stories read the same frozen artifact | Pure user-story organisation would duplicate the freeze/measure/simulate work into both stories, and would hide that T004 can veto US1 |
| No `spec.md` | The two increments and their acceptance are fully stated in this plan's Summary and in tasks.md; a separate spec would restate them | Writing one now, before T003/T004 return, would fix scope against numbers that do not exist yet |
| `T003`'s small-N result no longer gates US2 | **Amended from the previous draft.** T003 sizes the *rate*; it does not decide whether the class exists — a live Cardinal Rule violation already did. Spec 013 T4's "too rare to decide from" governed *whether to build a gate*; here the defect is confirmed | Gating US2 on census volume would let a rare-but-real false-accusation class ship unfixed |
| US1's retraction set is `{unsupported, unverifiable}`, not `unsupported` alone | An escalation tier can land on either; naming only one leaves the other label as the next lock | Naming `unsupported` alone is narrower but reintroduces the same bug under a different verdict |
| Constitution gates substituted with project rules | `constitution.md` is an unfilled template | Failing the plan on an unevaluable gate, or fabricating principles, would both be worse |
