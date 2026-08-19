# D030 — Claim-Verifiability Pre-Filter and Reason-Grounded Ordinal Gate

## Summary

| # | Issue | Fix | How |
|---|-------|-----|-----|
| 1 | Ordinal/sequence-position conflation (Wright-brothers bug — "first flight" graded `supported` against evidence naming "fourth flight") | `applyReasonOrdinalGate` (new gate in `gates.ts`) | Read VERIFY's own `reason` text, not the evidence. Find the noun the claim's ordinal attaches to (e.g. "flight"), check if `reason` states a *different* ordinal on that same noun → force `contradicted`. Agreement never confirms `supported`. Validate against a false-positive matrix offline first (§3a); wire into `runGateChain` only after that passes. |
| 2 | Personal/opinion claims misgraded `unsupported` instead of excluded (e.g. "I was in need of a new laptop...") | `classifyClaimVerifiability` (new LLM pre-filter, before search) | LLM call right after EXTRACT classifies each claim as checkable / personal / opinion / prediction. Only excludes on a clear non-checkable call — anything uncertain still goes to search. Existing 3 regexes stay as a cheap first pass in front of it. |

## §1. Trigger

Two independent open correctness gaps, both from real live-test failures:

1. **Personal/autobiographical claims** (backlog, `specs/009-grounnel/tasks.md`, 2026-08-18): "In
   2023, I was in need of a new laptop that should hopefully last me for a while" is graded
   `unsupported` — not technically wrong (no evidence exists either way), but misleading UX: it
   reads as "we searched and found nothing," when this was never a checkable claim. Gate #3's
   `isOpinionClaim` (three regexes: value judgments, vague intensifiers, hedged predictions) has no
   category for first-person private-circumstance statements and was never designed to.
2. **Ordinal/sequence-position conflation** (tasks.md Phase 34/35, 2026-08-17/18): claims about the
   Wright brothers' FIRST flight's distance/duration (852 ft / 59 s) graded `supported` against
   evidence explicitly attributing those numbers to the fourth and final flight — VERIFY's own
   `reason` field quoted "fourth and final flight" and still returned `supported`. Two fix attempts
   were built, live-tested, and abandoned:
   - a `SEQUENCE POSITION` prompt section (mirroring the working `DATE PRECISION` section) — deployed,
     failed live 2/2, reverted (`verify/system.json` 4.3.0 → 4.4.0).
   - `applyOrdinalGate`, a keyword-anchored deterministic gate modeled on `applyYearGate`'s
     `ROLE_KEYWORDS` whitelist — passed unit tests, never wired in, ultimately deleted rather than
     shipped (see §2).

## §2. Investigation — is `MULTIPLE SOURCES` masking the conflict, and does it matter?

`verify/system.json`'s own v4.4.0 changelog names a working hypothesis: the `MULTIPLE SOURCES`
section's carve-out — "if sources disagree with each other on the same fact, that is not
automatically a CONFLICT with the claim — evaluate the claim against the strongest, most directly
on-point sentence(s)" — may be overriding an explicit ordinal/date conflict whenever one source
states the disqualifying detail explicitly and another is silent on it.

Confirmed by reading the live prompt content directly: this instruction is real, current, and
structurally capable of producing exactly this failure. A model told "source disagreement isn't
automatic conflict, use the most on-point sentence" has explicit license to discard the source
naming "fourth and final flight" in favor of a source that's merely silent on which flight — nothing
in the prompt defines "most on-point" for this shape of case. The same live-test round caught a
one-off miss on the older, previously-reliable `DATE PRECISION` rule (Pluto reclassification year,
1/2 runs) in a similarly asymmetric-source scenario, consistent with this being a cross-cutting
weakness rather than ordinal-specific.

**However, this does not turn out to be the load-bearing fix.** `gates.ts` already has a shipped,
live-verified precedent for exactly this failure shape: `applyReasonYearGate` (T069, gate #3
`reason_year` in the 8-gate chain, live-verified via `grounnel_gate_events`). It fixed the same
asymmetric-source Pluto miss — **regardless of why VERIFY's raw verdict was wrong** — because it
never inspects the prompt or the raw evidence text at all. It reads only the model's own `reason`
string:

1. Extract a single token of the relevant type from the claim text (exactly one year — abstains on
   0 or 2+, side-stepping ambiguity).
2. Extract same-type tokens from `reason`.
3. If `reason` confirms the claim's value (negation-aware) → no override.
4. If `reason` states a different value **in a sentence sharing ≥2 key terms with the claim**
   (negation-aware, via the same `extractKeyTerms`/`scoreKeyTermMatches` helper combination
   `applyClaimReasonOverlapGate` (gate #1b) already uses for its own key-term-overlap check) →
   force `contradicted`.
5. Otherwise abstain — never touches an already-`contradicted`/`unverifiable` verdict, never
   promotes toward `supported`.

This works precisely because it doesn't depend on evidence phrasing at all — the failure mode that
killed both the original `ROLE_KEYWORDS` whitelist widening and the deleted `applyOrdinalGate`
(tasks.md Phase 35: "a hand-maintained keyword whitelist can only ever cover phrasings someone has
already noticed in a bug report"). The model's own `reason` field has independently and correctly
named the true fact in every observed failure case (Wright brothers, Pluto, COBOL/Hopper); the gate
only has to compare that against the claim — a bounded string-matching problem, not an
evidence-parsing one.

**Conclusion**: `MULTIPLE SOURCES` plausibly contributes to the raw VERIFY verdict being wrong, but
fixing the prompt is not the load-bearing decision — the reason-text-extraction pattern already
neutralizes its effect on the stored verdict. Amending `MULTIPLE SOURCES` is a secondary, optional
follow-up (§4), not a prerequisite.

## §3. Decision

**§3a — Ordinal conflation.** Build `applyReasonOrdinalGate` as its own policy function (not a
generic `applyReasonFactGate<T>` — see §4), reusing `applyReasonYearGate`'s *architecture*
(negation-aware, `contradicted`-only, abstain-by-default) but not its extraction logic verbatim.
Ordinals are not the same extraction problem as years:

- A year is a distinctive, context-free 4-digit token. An ordinal word ("first", "second"...) is
  not inherently a fact about anything — it's equally likely to be discourse structure ("First, the
  source says X. Second, it says Y.") as a factual attribute of an event. Reusing the year gate's
  logic unmodified would treat discourse enumeration as a claim contradiction.
- **No global role-noun whitelist** ("flight"/"attempt"/"round"/"edition"/"trial"/"place"/
  "position", the deleted `applyOrdinalGate`'s approach). Instead, **anchor to the claim's own
  structure**: derive the local noun the claim's ordinal attaches to directly from the claim text
  (e.g. "flight" out of "the first flight covered 852 ft"), then look in `reason` only for a
  competing ordinal attached to that same anchor — not a fact type recognized ahead of time from a
  fixed vocabulary. This is what a hand-maintained whitelist structurally cannot do (§2's
  `ROLE_KEYWORDS` "redesignated"/"downgraded" miss), and it doesn't require guessing the universe of
  role-nouns in advance.
- Prefer sentence-scoped attachment over an arbitrary character window for locality: "fourth and
  final flight" (same sentence, same clause, same anchor noun) is a strong signal; "the source
  discusses the first flight, it later mentions the fourth" is weaker; two ordinals each introducing
  a separate list item ("First, ... Second, ...") must not fire at all.
- **Trust-boundary framing, stated precisely**: `reason` is not "trusted" as ground truth — it's an
  observable output of VERIFY that, when it explicitly states a fact conflicting with the claim, is
  a strong-enough signal to override a verdict. Agreement between `reason` and the claim proves
  nothing and must never promote or confirm a verdict — the gate is one-directional, same as
  `applyReasonYearGate` and every other gate in this chain.
- **Anchor definition, made explicit (not left implicit)**: a claim-side ordinal is eligible for
  this gate only when a single, unambiguous noun phrase directly scopes it ("the **first flight**,"
  not an ordinal with the noun inferred from elsewhere). If no single anchor can be established, the
  gate abstains. Without this stated as an acceptance criterion, "derive the anchor from the claim"
  risks quietly becoming the same brittle `ordinal + nearest noun` heuristic claim-anchoring was
  introduced to avoid.
- **Override direction, stated exactly** (the "one-directional" language above is necessary but not
  sufficient — "downgrade" is ambiguous for `unsupported → contradicted`, which adds information
  rather than weakening it): the gate follows `applyReasonYearGate`'s existing behavior — any
  eligible verdict other than `contradicted` or `unverifiable` (`supported`, `partially_supported`,
  or `unsupported`) can be forced to `contradicted`. It never promotes toward `supported` and never
  touches an already-`contradicted`/`unverifiable` verdict. See `spec.md` FR-002 for the precise
  requirement wording.

**Validation before wiring into `runGateChain`**: build a small false-positive-focused test matrix
before this touches production, since the wrong error direction here (an ordinal false-positive
downgrading a genuinely correct `supported` claim) is exactly what §5 of AGENTS.md's testing
philosophy (behavior over schema) is for. Minimum cases:
  - must fire: claim "first flight, 852 ft" vs. reason "fourth and final flight, 852 ft" (the Wright
    regression itself).
  - must fire: claim "second attempt reached 100m" vs. reason "third attempt reached 100m".
  - must abstain: reason uses ordinals as discourse markers ("First, the source reports X. Second,
    it says Y.") with no shared anchor noun.
  - must abstain: reason mentions both the claim's ordinal and a different one for what is
    ambiguously a separate fact ("discusses the first flight and later the fourth flight").
  - must NOT fire: reason states the claim's own ordinal AND a different one for an unrelated
    instance of the same value ("the first flight reached 852 ft, while the fourth flight also
    reached 852 ft") — same value, not a contradiction of the claim's specific ordinal attribution.
  - must fire under negation: "it was not the first flight; the fourth and final flight reached
    852 ft."
  - regression guard: every existing `applyReasonYearGate` golden case must still pass unchanged —
    the two gates must not interfere with each other in the chain.
  Follow T068's own precedent (tasks.md Phase 35: `applyOrdinalGate` built pure/unwired first,
  decision to wire in made separately after reviewing abstention behavior) — implement and evaluate
  the false-positive rate against this matrix before adding it to `runGateChain`, not as part of the
  same change.

**§3b — Personal/opinion claims.** Add a pre-search LLM classifier (`classifyClaimVerifiability`),
per this repo's own AGENTS.md rule #12 ("prefer LLM judgment over regex for semantic/contextual
checks"), additive to the existing `isOpinionClaim` regex filter — refined during a second review
pass into three concrete design points beyond the original one-line decision:

- **Ordering: regex first, classifier second**, not the reverse. Both mechanisms independently
  produce the same `unverifiable` outcome when they fire, so order doesn't change what gets
  excluded — only whether an LLM call gets spent on a claim ("the movie was terrible") the free,
  already-validated regex would have caught anyway. Pure cost optimization, no correctness cost.
- **The classifier needs source context, not claim text alone.** `"I discovered X in 1928"` and
  `"I discovered X in 1928," said Fleming` are the same claim text with opposite correct answers —
  distinguishing a private assertion from an attributed quote is a context question. Input includes
  `sourceExcerpt` (already produced by EXTRACT, D028).
- **`personal` is not synonymous with non-checkable.** "I was born in 1987," "I served as CEO from
  2015 to 2020" are first-person but plainly verifiable if the speaker is a public figure — the
  actual question is whether a claim is reasonably verifiable through external evidence available to
  the system, not whether it uses first-person grammar. The exclusion decision is driven by an
  explicit `certainty: "clear" | "uncertain"` field the classifier states directly, not by a raw,
  uncalibrated confidence float thresholded after the fact.

Conservative policy unchanged: only excludes on a clear non-checkable call with `certainty: "clear"`;
any uncertainty still goes to search — the cost of wrongly excluding a real claim is worse than the
cost of searching one that turns out unverifiable anyway. Existing regexes stay as-is (cheap, already
reliable for their narrow categories); the classifier is additive, not a replacement. Full shape in
`specs/012-grounnel-ordinal-eligibility-gates/data-model.md` §2.

## §4. Explicitly not doing

- **Amending `MULTIPLE SOURCES` in the VERIFY prompt** — plausible contributing cause (§2), but the
  reason-grounded gate already neutralizes its effect on the stored verdict. Revisit only if
  `applyReasonOrdinalGate` itself is observed to abstain on a live failure (i.e. the model's `reason`
  field stops correctly naming the true ordinal, unlike every case observed so far).
- **A generic `applyReasonFactGate<T>` abstraction** unifying year/ordinal (and future
  currency/percent/entity) extraction behind one parameterized function. Premature: the two known
  instances aren't actually structurally identical (years are context-free tokens; ordinals need
  claim-anchored attachment, see §3a), so a shared interface today would either leak
  ordinal-specific logic through a "generic" API or force year-extraction into ordinal-shaped
  complexity it doesn't need. Only genuinely common mechanics (e.g. the negation check, the
  key-term-overlap helper combination `applyClaimReasonOverlapGate` already exposes) should be
  shared as small helpers, not a unifying type. Revisit extraction into a shared framework only once
  a *third*
  instance shows the same structure as the first two — one shared pattern plus one adaptation isn't
  enough evidence for a generic abstraction yet.
- **A general-purpose `checkClaimReasonConsistency` LLM classifier** covering all contradiction
  types (ordinal/numeric/entity/scope) in one call — the deterministic, per-type `applyReason*Gate`
  pattern is cheaper (zero LLM cost) and has a live track record (T069). Revisit only if per-type
  gates keep needing to be added faster than new failure classes actually recur.
- **A global ordinal role-noun whitelist** (the deleted `applyOrdinalGate`'s approach applied to
  `reason` instead of evidence) — claim-anchored attachment (§3a) avoids needing one at all; a
  whitelist reintroduces the exact "can only cover phrasings already seen" ceiling this ADR is
  trying to get away from.
- **Extending `applyReasonOrdinalGate` to the value-less role+ordinal-only form** ("someone says
  fourth, claim says third, no shared value to anchor them") — same danger flagged and deliberately
  excluded from the deleted `applyOrdinalGate` v1: proving two ordinals refer to the same underlying
  fact without a shared anchor is unsolved, not just deferred.
- **Designing now for "the reason itself is eventually wrong, not just the verdict."** Every
  observed case so far (Wright, Pluto, COBOL/Hopper attribution) has the model's `reason` correctly
  naming the true fact while the verdict is wrong — `reason > verdict` in every sample collected.
  Building speculative hedges against `reason` itself being wrong has no observed case to design
  against yet; revisit if one appears, consistent with this repo's gates all being born from
  reproduced live failures, never hypothetical ones.

## Consequences

- New in `src/orchestrators/grounnel/gates.ts`: `applyReasonOrdinalGate` (own policy function, not
  a generic gate), evaluated offline against the §3a test matrix; wired into `runGateChain` as a new
  gate after `reason_year` only after that evaluation, as a separate follow-up decision — not bundled
  into the same change that implements it.
- New (file TBD — likely `claim-eligibility.ts`, sibling to `opinion-filter.ts`):
  `classifyClaimVerifiability`, wired into the EXTRACT → search boundary ahead of `isOpinionClaim`.
- The 4 persistence-layer gate-name/reason-code union types
  (`grounnel-gate-event-store.ts`, `persistence/types.ts`, `db/schema.ts`, `db/queries.ts`) need the
  new gate name added, same pattern T069 already followed for `reason_year` — only once
  `applyReasonOrdinalGate` is actually wired in, not at implementation time.
- Golden-set additions: an ordinal case restoring the intent of the removed `g15-wright-brothers-
  ordinal` (now exercising the gate, not a prompt section) plus the full §3a false-positive matrix,
  and separately new personal/opinion eligibility cases — true exclusions (personal circumstance,
  opinion, prediction) and hard negatives (quoted first-person claims, checkable claims containing
  "I", scheduled future events).
- `verify/system.json` (`MULTIPLE SOURCES`) is explicitly untouched by this decision (§4) — no
  prompt-version bump associated with this ADR.

**Source**: `biassemble-core`, investigation + this doc 2026-08-19; builds on tasks.md Phase 34/35
(2026-08-17/18) and T069 (`applyReasonYearGate`, 2026-08-18). Design refined twice same day after
external review: first pass narrowed ordinal extraction from a direct year-gate copy to
claim-anchored attachment, deferred a generic gate abstraction, and added an offline validation
matrix as a precondition to wiring into `runGateChain`. Second pass, after `/speckit-specify` and
`/speckit-plan` turned this ADR into `specs/012-grounnel-ordinal-eligibility-gates/`: made the
ordinal anchor definition and override-direction semantics explicit acceptance criteria rather than
implicit; gave the eligibility classifier `sourceExcerpt` context input (claim text alone can't
distinguish a private assertion from an attributed quote) and an explicit `certainty` field
(replacing an uncalibrated raw confidence float); reordered it to run after, not ahead of, the
existing regex filter (cost optimization, no correctness change); and clarified that `personal` is
not synonymous with non-checkable.
