# Phase 1 Data Model: Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering

No database schema migration in this feature — both additions reuse existing tables/columns. This
document covers the in-memory shapes and the one enumerated-value extension to persisted data.

## 1. `applyReasonOrdinalGate` — Input / Result

Follows `applyReasonYearGate`'s *policy shape and abstention discipline* (same input/output field
names, same negation-aware / one-directional / abstain-by-default structure) — but not its
extraction logic. A year is a context-free 4-digit token; an ordinal word isn't (see `research.md`
Decision 2), so ordinal extraction uses a separate, claim-anchored strategy, not a token swap:

```text
OrdinalGateInput
├── claimText: string
├── verdict: Verdict            # current verdict before this gate runs
└── reason: string | null       # VERIFY's own natural-language explanation

OrdinalGateResult
├── verdict: Verdict            # unchanged, or forced to "contradicted"
├── overridden: boolean
└── reason: "reason_ordinal_mismatch" | null   # new reason-code value
```

**Anchor definition (acceptance criterion, not left implicit)**: a claim-side ordinal is eligible for
this gate only when the implementation can identify a **single, unambiguous noun phrase that
directly scopes the ordinal** ("the **first flight**," not "the first" with the noun inferred from
elsewhere). This is deliberately conservative — it is not a claim to understand arbitrary noun
attachment. If no single anchor can be established, the gate abstains. This is what keeps "derive
the anchor from the claim" from quietly becoming the same kind of brittle heuristic
(`ordinal + immediately-following noun`) that claim-anchoring was introduced to avoid.

**Abstention short-circuits** (in order — matches `applyReasonYearGate`'s structure):
1. `verdict` is already `contradicted` or `unverifiable`, or `reason` is null → no-op.
2. The claim doesn't satisfy the anchor definition above (zero ordinals, or ambiguous attachment) →
   abstain, don't guess.
3. `reason` contains zero ordinal tokens → abstain.
4. The claim's own ordinal is confirmed in `reason` (same value, same anchor noun, negation-aware) →
   no override.
5. No competing ordinal in `reason` is attached to the same anchor noun as the claim's ordinal (the
   claim-anchoring check from `research.md` Decision 2) → abstain — this is what prevents discourse-
   enumeration ordinals ("First,... Second,...") and unrelated-fact ordinals from false-firing.
6. Otherwise → `{ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" }`.

**Override-direction semantics, stated explicitly** (FR-002's "downgrade" is otherwise ambiguous —
`unsupported → contradicted` isn't a downgrade in the ordinary sense, it's adding stronger
information): this gate follows `applyReasonYearGate`'s existing behavior exactly — **any eligible
verdict other than `contradicted` or `unverifiable`** (i.e. `supported`, `partially_supported`, or
`unsupported`) **can be forced to `contradicted`** when step 6 fires. The one-directional guarantee
is narrower than "only downgrades": it never promotes *toward* `supported`, and it never touches a
verdict already at `contradicted` or `unverifiable`. That's the actual invariant — see FR-002's
updated wording in `spec.md`.

**Validation matrix** (from D030 §3a — the fixture set `gates.test.ts` must cover before this is
wired into `runGateChain`):

| Claim | Reason | Expected |
|---|---|---|
| "The first flight covered 852 ft" | "...the airplane flew 852 ft on its fourth and final flight" | fires → `contradicted` (the Wright regression) |
| "The second attempt reached 100m" | "...the third attempt reached 100m" | fires → `contradicted` |
| "The first flight covered 852 ft" | "First, the source reports 852 ft. Second, it says the flight lasted 59 seconds." | abstains — discourse enumeration, no shared anchor |
| "The first flight covered 852 ft" | "...discusses the first flight and later the fourth flight" | abstains — ambiguous, no clear single fact being restated |
| "The first flight covered 852 ft" | "...the first flight reached 852 ft, while the fourth flight also reached 852 ft" | does NOT fire — same value, not a contradiction of the claim's specific attribution |
| "The first flight covered 852 ft" | "The fourth flight covered 852 ft, while the first flight lasted 59 seconds" | abstains — the competing ordinal ("fourth") attaches to a *different* measurement (852 ft) than the one the claim's anchor is about; doesn't merely fire because both ordinal words appear |
| "The first flight covered 852 ft" | "First, the source discusses the history. The fourth flight covered 852 ft." | fires → `contradicted` — one ordinal is discourse structure, the other is a genuine competing fact on the same anchor; don't let the presence of a discourse ordinal suppress a real one |
| "The second attempt reached 100m" | "The third unsuccessful attempt reached 100m" | fires → `contradicted` — a modifier ("unsuccessful") between the ordinal and the anchor noun must not break anchor matching |
| "The first flight covered 852 ft" | "It was not the first flight; the fourth and final flight reached 852 ft" | fires under negation → `contradicted` |
| *(all existing `applyReasonYearGate` golden cases)* | — | unchanged — the two gates must not interfere |

Out of scope for this matrix: ordinal words used as fixed phrases unrelated to sequence position
("first principle," "second opinion") — the anchor definition above should already exclude these
(no sequence-position noun phrase to scope), but it's called out explicitly so a test author doesn't
have to rediscover that boundary.

## 2. `classifyClaimVerifiability` — Input / Result shape

```text
ClaimVerifiabilityInput
├── claimText: string
└── sourceExcerpt: string | null   # the claim's own verbatim source context (D028) — required to
                                    # tell "I discovered X in 1928" (private assertion) apart from
                                    # `"I discovered X in 1928," said Fleming` (attributed quote);
                                    # claim text alone cannot make this distinction

ClaimVerifiabilityResult
├── category: "checkable" | "personal" | "opinion" | "prediction"
├── certainty: "clear" | "uncertain"   # drives the exclusion decision directly — see Policy
└── reason: string                     # one-line rationale, for observability/telemetry only
```

**Why the input includes `sourceExcerpt`, not just claim text**: the whole point of this classifier
is separating a private first-person assertion from a publicly attributable one, and that's a
*context* question, not a claim-text-only one — `"I was born in 1987"` reads identically whether
it's an anonymous author's own private fact or a public figure's well-documented history until you
know who's speaking and how the article frames it. `sourceExcerpt` (already produced by EXTRACT per
D028) is the cheapest available signal for that; a bounded window of surrounding source text is a
fallback if `sourceExcerpt` alone proves insufficient during evaluation, not designed here.

**Why `certainty` replaces a raw confidence float**: an LLM-reported `0.0–1.0` confidence score isn't
calibrated, and "exclude when the classification is unambiguous" was previously left undefined
against that number — there was no stated threshold, so "unambiguous" had no machine-checkable
meaning. `certainty: "clear" | "uncertain"` makes the classifier state its own decision-relevant
judgment directly instead of code trying to threshold an uncalibrated probability. A raw numeric
score can still be logged for telemetry if the provider returns one, but it does not drive policy.

**Category semantics — `personal` is not synonymous with non-checkable.** Examples that are
first-person but plainly verifiable: "I was born in 1987," "I served as CEO from 2015 to 2020," "I
was arrested in 1994" — all checkable if the speaker is a public figure or the claim is otherwise
externally traceable. The classifier's job is not "does this use first person," it's closer to: **is
this claim reasonably verifiable through external evidence available to the system** — not a
metaphysical "could any record possibly exist anywhere" standard (almost anything could in
principle), but a practical one. `personal` names a *speaker-relative* category the classifier can
report; whether a given instance ends up excluded is decided by `certainty`, not by the category
label alone.

This classifier is general eligibility infrastructure, but the specific new capability this feature
needs is recognizing non-public personal claims. The `opinion`/`prediction` categories exist mainly
to make the classifier's judgment observable end-to-end — the existing regex filter
(`isOpinionClaim`) remains the authoritative, already-validated mechanism for those two categories
(see Policy below for why it runs first).

**Policy** (conservative, matches D030 §3b and the spec's FR-007):

```text
existing isOpinionClaim regex (unchanged) catches it
                           → excluded via the existing mechanism; classifyClaimVerifiability is
                             never called for this claim (avoids paying LLM cost for cases already
                             solved deterministically and cheaply)
not caught by the regex
  ↓
classifyClaimVerifiability
  ├── category === "checkable"        → proceed to search, unchanged
  ├── category !== "checkable"
  │     AND certainty === "clear"     → excluded, verdict stored as the existing non-checkable/
  │                                      unverifiable shape (reusing the current "unverifiable"
  │                                      verdict value — see below)
  └── certainty === "uncertain"       → proceed to search (default to checkable)
```

No new `Verdict` enum value is introduced for "excluded pre-search" — it reuses the existing
`unverifiable` verdict (same value gate #3's `isOpinionClaim` already produces), per spec FR-008's
requirement that it be *labeled distinctly* from "checked and found nothing"
(`unsupported`) at the reporting layer, which this pipeline already achieves by keeping
`unverifiable` and `unsupported` as separate values — this feature extends which claims land in
`unverifiable`, it doesn't add a new value.

**Validation set** (spec FR-010 / SC-002, SC-004) — two distinct kinds of test, not one:
- *Orchestration* (mocked provider responses): given a fixed classifier output, does the pipeline
  wire the exclusion/search decision correctly? Standard unit tests.
- *Classifier behavior* (does the model actually classify correctly): requires a live/golden-set
  evaluation, not mocks — same distinction this repo already applies to prompt changes elsewhere
  (`docs/testing-philosophy.md`). Cases:
  - True exclusions: personal circumstance ("I was in need of a new laptop..."), opinion ("the movie
    was terrible" — expected to be caught by the existing regex, not this classifier), vague
    prediction ("might well announce a merger" — same).
  - Hard negatives (must NOT exclude): quoted first-person claims (`"I discovered X in 1928," said
    Fleming`), checkable personal claims about a public figure ("I was born in 1987," said of the
    article's subject), scheduled/dated future events ("will report earnings on October 15").

**Telemetry**: no new storage mechanism. Classifier input/output is captured through the existing
LLM-call observability path (`recordLlmCall()`/`executeAndRecordLlmCall()`, same as every other LLM
call in this pipeline), with the resulting eligibility decision associated with the claim/run — not
a new table.

## 3. Persistence extension (deferred until the ordinal gate is wired in — D030 Consequences)

One new value added to the existing gate-name/reason-code union types, following the exact pattern
T069 already established for `reason_year`:

| File | Change |
|---|---|
| `src/persistence/grounnel-gate-event-store.ts` | gate-name union gains `"reason_ordinal"` |
| `src/persistence/types.ts` | mirrors the same union |
| `src/db/schema.ts` | check-constraint / enum equivalent gains the new value |
| `src/db/queries.ts` | any exhaustive-switch or literal list touching gate names gains the new case |

No migration needed if the column is a free-text/varchar with an application-level union check
(matches how `reason_year` was added for T069); if it's a Postgres `enum` type, this becomes a
single additive `ALTER TYPE ... ADD VALUE` migration — confirm which by reading the live
`db/schema.ts` before implementing, don't assume.
