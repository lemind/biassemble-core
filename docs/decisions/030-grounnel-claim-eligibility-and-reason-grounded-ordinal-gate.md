# D030 — Claim-Verifiability Pre-Filter and Reason-Grounded Ordinal Gate

## Summary

| # | Issue | Fix | How |
|---|-------|-----|-----|
| 1 | Ordinal/sequence-position conflation (Wright-brothers bug — "first flight" graded `supported` against evidence naming "fourth flight") | `applyReasonOrdinalGate` (new gate in `gates.ts`) | Read VERIFY's own `reason` text, not the evidence. Find the noun the claim's ordinal attaches to (e.g. "flight"), check if `reason` states a *different* ordinal on that same noun → force `contradicted`. Agreement never confirms `supported`. Validate against a false-positive matrix offline first (§3a); wire into `runGateChain` only after that passes. |
| 2 | Personal/opinion claims misgraded `unsupported` instead of excluded (e.g. "I was in need of a new laptop...") | `classifyClaimVerifiability` (new LLM pre-filter, after the existing regex) | Runs after the existing 3 regexes (cheap first pass, unchanged), only for claims they didn't already catch. Takes `claimText` + `sourceExcerpt` as input — needed to tell a private assertion apart from an attributed quote using the same words. Reports `category` (checkable/personal/opinion/prediction) + an explicit `certainty: clear \| uncertain` (not a raw confidence float) — only excludes when certainty is clear that the claim isn't reasonably externally verifiable; `personal` alone is never sufficient grounds for exclusion. |

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
`src/orchestrators/grounnel/claim-eligibility.ts`.

**Amendment (2026-08-27, spec 013 T4/T13): the conservative policy is CONFIRMED, not reversed.**
Spec 013 opened T13 to consider excluding `prediction` regardless of `certainty` — i.e. reversing the
rule above for that one category. **It was measured first and then closed won't-do.** T4 pulled every
historical `eligibility_check` call (**n=2,724**) and found **exactly one** claim classified
`prediction`. That one case behaved correctly: `certainty: uncertain` → not excluded → full pipeline →
`unsupported`, which is the right outcome for a claim with no fixed timeframe to check against.
One data point is not a rate. Reversing a documented policy on n=1 is the same reasoning that produced
the four refuted `subject_entity` fixes in §3n, and it would risk excluding dated-but-checkable claims
("will report earnings on October 15") that this section's own third bullet exists to protect. The
category fires roughly 1 in 2,724 classifications, so the blast radius is small in *either* direction —
which is an argument for leaving a documented policy alone, not for churning it. Reopen only on
materially higher `prediction` volume or a real harmful case.

**§3c — T034 retry can erase a gate-forced contradiction.** Real live-eval capture (2026-08-20,
g17): `reason_ordinal` correctly forced a verdict to `contradicted` (reason named "the fourth
flight"), but `needsRetry` — computed from diagnostics on the *raw pre-gate* verdict, which never
learns a gate already resolved the inconsistency — still fired T034's single-claim retry anyway. The
retry's fresh VERIFY call reasoned via "the longest flight" instead, a phrasing no gate recognizes,
and its result unconditionally overwrote the correct contradiction with `supported`.

**Fix:** skip the T034 retry whenever the post-gate-chain verdict is already `contradicted`
(`pipeline.service.ts`, `processVerifyResults`) — `reconcileContradictedVerdicts` (existing,
D030-T010-backlog telemetry) already grounds every claim ending a batch as `contradicted` via the
same reason-vs-verdict consistency classifier, so no new check was added; the fix is purely
"don't let an unrelated retry undo a resolved answer first."

**Known gap, not fixed here:** `applyClaimReasonOverlapGate` (gate #1b, cross-claim-contamination
check) only runs when the verdict is *already* `contradicted` at that point in `runGateChain` — a
verdict flipped to `contradicted` later by gate #2/#2b (`applyNumericGate`/`applyYearGate`, both
positioned after #1b) never gets gate #1b's contamination check. Pre-existing gate-ordering
characteristic, not introduced by this fix; revisit if a contaminated-reason-plus-numeric-mismatch
case is ever actually observed live (no case captured yet, consistent with this ADR's own precedent
of only building against reproduced failures, §4's last bullet).

**§3d — Gate-originated ordinal contradictions are not subject to generic contradiction
reconciliation.** §3c's fix stopped T034's retry from erasing a `reason_ordinal` contradiction, but
a *second*, independent erasure path exists: `reconcileContradictedVerdicts` (D026 §23/T064) also
downgrades it.

**Why reconciliation has this authority at all (D026 §23, 2026-08-11):** written 9 days before
`reason_ordinal` existed. Its actual problem: a claim landing on `contradicted` straight off VERIFY's
raw primary pass — no gate involved — with clean, gate-#1-passing evidence but internally wrong
reasoning (their own example: "misreads a nomination as a rejection"), got zero consistency scrutiny.
The fix made `checkReasonVerdictConsistency` run unconditionally on every `contradicted` verdict,
explicitly accepting redundant-but-cheap re-checks of retry/escalation-produced contradictions — the
only two other mechanisms that existed at the time. `reason_ordinal`'s provenance was never evaluated
against this policy, because it didn't exist yet; it was swept into the blanket rule by construction.

**The two provenances are not equivalent.** D026's target: `raw VERIFY verdict → LLM sanity check`.
`reason_ordinal`'s shape: `VERIFY's own reason text → deterministic structural comparison →
contradicted` — only fires when the claim has exactly one resolvable ordinal+anchor, the reason
states a *different* ordinal on that same anchor, negation/discourse safeguards don't abstain, and
gate #1/#1b haven't already invalidated it (§3a). The contradiction is grounded in an explicit
textual mismatch VERIFY itself already produced, not solely in VERIFY's categorical verdict.

**Evidence:** the captured production case (2026-08-21) — `reason_ordinal` identified "first" vs.
"fourth" from VERIFY's own reason; `checkReasonVerdictConsistency`, given that exact reason, answered
`consistent: false`. A follow-up replay of 10 semantically diverse ordinal-contradiction fixtures
(flights, attempts, editions, trials, experiments, matches; varied reason phrasing) against the
classifier in isolation found 4/10 incorrectly rejected — failures span multiple topics, not
concentrated in one. All 4 hard-negative fixtures (reason does NOT establish a real contradiction)
were correctly accepted, ruling out "the classifier is just a broken rubber stamp" — it has real
discriminating power, and is specifically unreliable on confirming true ordinal contradictions.

**Decision:** a `contradicted` verdict produced by `applyReasonOrdinalGate` must not be downgraded to
`unsupported` solely because `checkReasonVerdictConsistency` returns `consistent: false` — nor
re-verified away by escalation. Protecting reconciliation alone is not sufficient: `findUnresolvedClaims`
(D026 §17) deliberately treats `contradicted` as escalation-eligible, and `guardEscalatedContradictionReversals`
only validates a NEW post-escalation verdict's self-consistency in isolation — it has no way to know
a stronger, gate-established signal is being overwritten, so it would not catch a fresh, weaker
escalation VERIFY call flipping the claim to `supported`. Confirmed by tracing the captured case's
full authority chain (not assumed): `reconcileContradictedVerdicts` was the only path that fired that
time, but that was incidental — its downgrade happened to run before escalation ever saw the claim.
Both paths are closed by the same fix: `reason_ordinal`-protected claim ids are collected once per
`run()` (not per-batch — must survive across escalation tiers) and excluded from both
`reconcileContradictedVerdicts`'s classifier call and `findUnresolvedClaims`'s eligible set.

**A third path, found in review, not live**: `applyNumericGate` (gate #2, runs after `reason_ordinal`
in the same synchronous chain) had no guard against un-contradicting a verdict an earlier gate had
just set — unlike `applyYearGate`'s existing `canForceSupported` (added for the same reason on gate
#2b). A numeric-bearing ordinal claim ("the third trial showed 40%" vs. reason "the first trial
showed 40%" — same %, different ordinal) would silently flip back to `supported` inside `runGateChain`
itself, before the claim's persisted verdict is ever `contradicted` — bypassing reconciliation/
escalation protection entirely, since neither mechanism ever sees it. Fixed narrower than
`applyYearGate`'s blanket guard: `applyNumericGate` gained an explicit
`contradictionProtectedFromForceSupported` input, set only when `originatingContradictionGate`
(applied to the chain's own events-so-far) says `reason_ordinal` produced the current contradiction —
a blanket "never un-contradict" guard would have reverted a real, already-fixed live bug (g11,
2026-08-06: a raw ungated VERIFY `contradicted` legitimately corrected to `supported` once the actual
numbers satisfy the claim's threshold). Forcing *to* `contradicted` stays unconditional either way,
same asymmetry as `applyYearGate`.

**A fourth path, also found in review** — `gateEventsByClaimId` (what `originatingContradictionGate`
reads to decide protection) was storing the *concatenated* firstPass+retryPass gate trail whenever a
T034 retry fired, the exact "stale flip" risk already documented on `originatingContradictionGate`
itself but, until now, only actually honored by `checkRetryContradiction`'s own separate
`currentPassGateEvents` parameter. Concretely: a firstPass `reason_ordinal` contradiction that gate #1
later downgrades (triggering a retry) whose retry then independently lands on `contradicted` with no
gate involved would get wrongly attributed to the stale firstPass event, misapplying protection to an
unrelated, unscrutinized retry-contradiction. Fixed by tracking `currentPassGateEvents` (last pass
only) separately from the concatenated trail used for the Postgres audit log.

**This is not a general precedence rule.** It does not mean deterministic gates outrank LLM judgment,
and it does not apply automatically to other gates (`numeric`'s own reconciliation downgrades looked
legitimate on inspection — a defensible 99.9%-vs-100% softening, not the same failure shape). Scoped
narrowly to `reason_ordinal`'s specific provenance today; extract a shared abstraction only if a
second gate demonstrates the same property (same anti-premature-abstraction stance as §4's "no
generic `applyReasonFactGate<T>`").

**§3e — Superlatives deliberately excluded from `ORDINAL_WORDS`.** A same-day live-eval finding
(2026-08-21, `g17-wright-brothers-ordinal`) showed `applyReasonOrdinalGate` abstaining on a reason
using "last"/"final" instead of a plain ordinal word. `last`/`final` were added to `ORDINAL_WORDS`
with an equivalence class (`last` ≡ `final`, same end-of-sequence position) and validated offline
against a 10-case adversarial matrix (idiomatic "at last"/"last year" negatives included) before
being wired in — commit `d6e9738`.

Reverted same day, commit `bb11072`: a live re-run surfaced the case the offline matrix didn't cover
— "last"'s idiomatic/temporal senses in real reason prose (not just the "at last"/"last year"
phrasings already tested) carry real false-accusation risk, and once `reason_ordinal` fires there is
no downstream safety net (§3d made this gate's contradictions immune to reconciliation/escalation
correction specifically *because* it was trusted as high-precision — a property this widening broke).
`last`/`final` removed; `first`...`tenth` only, unchanged since.

**Superlatives (`longest`, `largest`, `best`, `record`) were never added at all**, for a distinct
reason from `last`/`final`'s revert: a ranking descriptor can coincide with *any* sequence position
depending on the data (the longest flight isn't structurally guaranteed to be first, fourth, or any
other fixed slot), whereas `last`/`final` are positional by definition. Extending `ORDINAL_WORDS` to
cover them would be the same under-tested-heuristic shape this ADR's §3a already rejected once (the
deleted `applyOrdinalGate`'s `ROLE_KEYWORDS`) — see §3f for what actually causes `g17` to keep
failing on this axis, and why widening this list further is explicitly rejected again there.

**§3f — `g17-wright-brothers-ordinal` still red: root cause is retrieval, not the ordinal gate.**
Investigated 2026-08-22 after 5 consecutive live runs (4 automatic Inngest retries of one stale
event, replaying memoized `step.run` output per D019 §4's per-case checkpointing design, plus 1
genuinely fresh trigger) all landed `supported`, never `contradicted`, on the same claim: "The first
flight covered 852 feet." — golden spec expects `contradicted` (`ACCEPTABLE.false =
["contradicted"]` only; `unverifiable` does not satisfy it).

**Finding:** `extractKeyTerms("The first flight covered 852 feet.")` → `["852"]` — "first" and
"flight" both score zero (capitalization-gated proper-noun/number classifier, D026 §6). Gate #4
(`isPassageRelevant`) admits a passage only if it contains a key term, so every passage that survives
filtering is *structurally guaranteed* to contain "852" — i.e. every candidate VERIFY ever sees is
about whichever flight covered 852 feet (the fourth, the source material's own "longest"), never
about the actually-first, shorter flight that would refute the claim. VERIFY is not reasoning
poorly; it is being handed a confirmation-biased evidence pool with no counter-evidence in it. This
matches the reason text observed across all 5 runs — no run's reason ever cites a differing figure
for "the first flight," only ever 852ft/59s under varying phrasing ("longest," "first," or no
selector at all).

**This is upstream of `applyReasonOrdinalGate` and every other reason-grounded gate** — no
downstream gate can force a correct verdict from an evidence pool that structurally never contained
the refuting fact. Confirms §3e's standing rejection of widening `ORDINAL_WORDS` for superlatives:
even a perfect "longest ≠ first" detector would still need the refuting sentence to reach VERIFY
first, which it currently cannot.

**Decision:** treat "first flight" / "second attempt" / "final trial" as **instance selectors** —
identifying *which occurrence* of a repeated entity a claim is about — as a concept distinct from,
and additive to, `extractKeyTerms`'s existing entity/number classification. `extractKeyTerms` itself
is explicitly NOT changed: it's shared by `reason_year`'s locality check, `claim_reason_overlap`, and
the Case-A gate (§3a's own `applyImplicitNegationGate`) — widening it to score "first" as a key term
would silently change what those three already-validated gates admit as collateral damage. The
selector is a new, separate signal (`lib/instance-selector.ts`), consumed only by retrieval
(`isPassageRelevant`/rerank ranking) so the refuting sentence can reach VERIFY at all — reusing the
anchor/stopword machinery `applyReasonOrdinalGate`'s `ordinalAnchorWords` already validated, moved to
`lib/` so both sides import one definition instead of drifting.

**Explicitly rejected again, with the mechanism now understood:**
- Widening `ORDINAL_WORDS` further (the tempting one-liner) — would only fix the ~fraction of runs
  where VERIFY happens to phrase its reason with a selector word at all (observed non-deterministic
  across the 5 captured runs), leaves the biased evidence pool untouched, and reintroduces §3e's
  exact false-accusation risk class.
- Relaxing the golden set's `ACCEPTABLE.false` to also accept `unverifiable` — changes the
  scoreboard, not the defect.
- Modifying VERIFY's prompt or `applyReasonOrdinalGate` before retrieval is fixed — confounds
  measurement; see the plan's P3 gate below.

**Plan (P0–P3 scoped for this decision; P4 blocked on P3's result):** P0, confirm the confirmation-
bias empirically (read-only — pull the actual passage set a real run sent to VERIFY, not just infer
it from `extractKeyTerms`'s output). P1, extract instance-selector parsing as a pure function with
its own test matrix (sequence selectors like "first"/"fourth" vs. ranking descriptors like "longest",
which are deliberately NOT given retrieval-admission weight — a ranking can coincide with any
position, same distinction §3e already drew for `last`/`final` vs. superlatives) — zero behavior
change, full suite green with no `gates.test.ts` deltas, proving D030 untouched. P2, wire the
selector into gate #4 admission and rerank ranking as an additive OR-condition alongside existing
key-term matching, validated against a matrix covering both the target cases and adversarial ones
(e.g. "the first quarter of 2024" — "first" naming a calendar period, not a repeated-entity
instance — must not over-admit). P3, run `g17` live 3× with the fixed retrieval against VERIFY
**unmodified**, to isolate whether evidence availability alone resolves it before touching VERIFY's
prompt or any gate.

`applyReasonOrdinalGate` (§3a–§3d) is explicitly preserved unchanged throughout — defense-in-depth
for the cases where VERIFY's reason does surface a selector mismatch even with today's retrieval,
which the 5 captured runs show happens some of the time.

**P3 result (2026-08-22, live, 3 runs post-P2-deploy): 1/3 `contradicted`, 2/3 still `supported`.**
Not the S2 scenario the plan anticipated — VERIFY's own reasoning was correct in all 3 runs (P2's
retrieval fix worked: the disambiguating fourth-flight fact reached VERIFY every time, not ~60-70%
of the time as before). The gap was narrower: `applyReasonOrdinalGate`'s anchor window only looked
*forward* from the ordinal. Run 1's reason phrased it "the fourth and final **flight**" (noun after
the ordinal — forward window catches it, fires correctly). Runs 2/3 phrased it "the **flight**, the
fourth and final **one**" — the anchor noun BEFORE the ordinal, in a comma-joined appositive, with
the placeholder "one" standing in for it afterward; the forward-only window found only "final"/"one",
neither overlapping the claim's own "flight" anchor, so the gate abstained.

**Fix**: `anchorWords` (`lib/instance-selector.ts`) now also scans backward from the selector/ordinal
to the nearest content word(s), deliberately crossing clause (comma) boundaries — unlike the forward
window — stopping only at the sentence boundary, since the antecedent is often in a separate,
comma-joined appositive. Additive union with the existing forward window, never a replacement — a
reason phrased noun-after-ordinal (the common case, everything in §3a's matrix) is completely
unaffected. Verified against the full existing D030 §3a–§3e test suite (all passing, including T009's
10/10 held-out recall and the zero-false-downgrade requirement) plus a new regression test using the
exact live-captured appositive phrasing above. One pre-existing lib-level fixture ("This came first.")
changed from abstain to a (harmless) match now that "came" is found behind it — updated, not a
production-behavior regression (no `gates.test.ts` case relied on that shape).

**Still open** (addressed in §3g): one of the 3 live runs had no ordinal token in the reason at all
("the longest flight ... covered 852 feet" — no "fourth"), a pure superlative with nothing to anchor
on — this is §3e's already-accepted, deliberately-unfixed gap, not something this anchor-window fix
(or any anchor-window fix) can reach, since there's no ordinal match to extend anchoring from in the
first place.

**§3g — the superlative gap closed in the consistency classifier, not the ordinal gate.**
Two live eval runs 10 minutes apart on 2026-08-22 (one red, one green, identical code) made the
non-determinism explicit: VERIFY answered the same claim with "the **fourth** and final flight covered
852 feet" in one run (`applyReasonOrdinalGate` fires → `contradicted`, green) and "the **longest**
flight covered 852 feet" in the other (no ordinal token → gate abstains → `supported` stands, red).
Same code, same claim; only VERIFY's word choice differed.

**Finding:** the path that *should* have caught the red run already exists and already runs on it.
`checkReasonVerdictConsistency` (D025 §2) fires on every non-`contradicted` verdict, including this
`supported` one; a `false` answer sets `applyCounterfactIgnoredGate`'s flag, which raises an
ERROR diagnostic, which sets `needsRetry`, which forces a VERIFY retry. The whole chain was wired and
already paid for. It didn't fire because of what its prompt asked: *"a reason that states or implies a
fact **conflicting** with the claim does NOT support 'supported'"*. Read strictly — and the prompt
also forbids using outside knowledge — "the longest flight covered 852 feet" does **not** conflict
with "the first flight covered 852 feet". Nothing in the text says the first flight isn't the longest,
and both cite 852. `consistent: true` was the correct answer to the question being asked. The prompt
had no rule about the reason attributing the claim's fact to a *differently-identified instance*.

**Fix**: one rule added to `prompts/grounnel/consistency-check/system.json` (v1.2.0). It fires **only**
when the claim picks out one member of a set — an ordinal ("the first flight") or a ranking ("the
longest flight") — and treats a member as *different* only when the reason selects by a criterion the
claim did not use (a ranking where the claim used a position, or the reverse).

The first draft was materially broader — it triggered on "ordinal, superlative, **date, name, or
position**" and carved out only *shortenings* of the claim's subject. A pre-commit review found that
draft would have produced false positives across the existing golden set, which is why the scope above
is this narrow:

It took **two review rounds** to land, and both drafts were wrong in opposite directions — worth
recording, because the failure mode is symmetric and easy to repeat:

**Draft 1, too broad.** Triggered on "ordinal, superlative, **date, name, or position**" and carved out
only *shortenings* of the claim's subject. It would have flagged ordinary co-reference across the
existing golden set — `g08-napoleon-birthplace` ("born on Corsica" vs a reason saying "born in
Ajaccio"), `g01-eiffel-tower` ("completed in 1889" vs "dedicated on March 31, 1889"), and most
sharply `g20-apple-earnings-year-over-year`, whose prior-year-quarter claims were added *the same day*
by D031's Gap A fix and would have broken while `g17` got fixed.

**Draft 2, too narrow.** Overcorrecting, it defined a different member as a *criterion-type mismatch*
("a ranking where the claim used a position, or the reverse") and scoped that exclusively with "only
when". Because the clause was exclusive, it affirmatively **licensed** the very cases this gap is
about — worse than saying nothing, since the model previously could still fall back on the generic
conflicting-fact rule:

| Reason phrasing (claim says "the first flight") | Draft 2 verdict | Why it was wrong |
|---|---|---|
| "the **fourth** flight" | same member → `true` | both positional, so no criterion mismatch |
| "the **final** flight" | same member → `true` | positional by definition (§3e says so) — and `SEQUENCE_SELECTOR_WORDS` excludes `final`, so the deterministic gate abstains too: both layers miss it |
| "the **1904** flight" | same member → `true` | date isn't in the two-item criterion list |
| "**Wilbur's** flight" | same member → `true` | person isn't in the two-item criterion list |

**Shipped (draft 3)** inverts the logic: the same-member list is exhaustive (only re-wordings of the
claim's *own* selection — synonyms, aliases/abbreviations, period formats, a narrower name inside the
claim's own), and *anything else* is a different member, with the four rows above named explicitly as
examples. The trigger is also re-cut on a cleaner axis: the rule fires only when an ordinal/ranking
**selects which thing the claim is about** ("the first flight covered 852 feet"), and is explicitly
ignored when the ranking **is what the claim asserts** ("Everest is the tallest mountain"). That second
clause is what keeps `g02-mount-everest` safe — its graded claim is `tallest mountain on Earth`, a
ranking-as-assertion, which draft 2 would still have exposed to a false flag on a reason phrased
"Everest ranks first in elevation" (position vs ranking).

The "judge only how each names the thing, never whether they coincide in reality" sentence from draft 1
was dropped in round 1: combined with the prompt's existing no-outside-knowledge instruction, it left
the model no licensed route to accept *any* co-referring description.

**Why this lever and not another gate**: it generalizes past ordinals in one shot ("longest", "final",
"last", "the 1904 flight", "Wilbur's flight" all fall under one rule), costs nothing (the classifier
call already happens), needs no new gate, and does not touch `ORDINAL_WORDS` — leaving §3e's revert
intact rather than relitigating it. It follows AGENTS.md rule 12 (LLM judgment for a semantic check)
rather than adding the vocabulary list §3e/§3f both rejected. Distinct from §4's rejected
"general-purpose `checkClaimReasonConsistency` classifier": that bullet rejects *replacing* the
deterministic per-type gates with one catch-all LLM call; this adds a rule to the classifier that
already exists and already runs, and leaves every `applyReason*Gate` in place.

**Contrast with the attempt that already failed** (§1): D030 originally tried a `SEQUENCE POSITION`
section in the **VERIFY** prompt and it failed live 2/2. That asked VERIFY to self-police while
simultaneously reading passages, choosing citations, and assigning a verdict. This targets a
dedicated single-purpose classifier that sees only claim + reason + verdict and is already making
exactly this class of judgment for other mismatch types.

**Known sharp edge this widens** (found in review, not introduced by it): `checkReasonVerdictConsistency`
has four call sites in `pipeline.service.ts`, and **only one of them is recoverable**. In
`processVerifyResults` a `consistent: false` costs a VERIFY retry. In the other three —
`reconcileContradictedVerdicts`, `guardEscalatedContradictionReversals`, and `checkRetryContradiction`
— it writes `unsupported` immediately, with no retry. So a false positive from any rule in this prompt
does not merely waste work on three of four paths: it flips a verdict, unrecoverably.

That asymmetry predates this change and applies to every rule in the prompt equally. But a rule that
widens the `false` surface makes it more reachable, which — alongside the golden-set exposure above —
is why the shipped scope is as narrow as it is. Giving the three non-recoverable paths their own retry
(or their own narrower prompt) is the real fix and is **not** done here — logged as follow-up.

**Verification status — NOT yet verified.** No unit test backs this, deliberately: any such test would
have to hardcode the classifier's answer through a mock, exercising none of what actually changed (the
prompt) while duplicating the plumbing coverage the existing D025 case at `pipeline-service.test.ts`
already provides. CLAUDE.md's coverage rule names that shape directly ("only add one when the bug is in
orchestration control flow itself... not prompt/LLM behavior"), and the orchestration here was never
broken.

One throwaway mock-based test was written during investigation and discarded, but it did establish a
fact worth recording: mutating its mock classifier to answer `consistent: true` reproduced the red run
exactly — no gate fired, no retry, verdict left `supported` — confirming the plumbing carries a `false`
answer end to end, and that the *only* missing link was the prompt's judgment.

Whether the real classifier now answers `false` on this phrasing is a live question, and the shipped
rule has never been run against a model. `g17` flips non-deterministically, so this needs **2–3
consecutive green live runs** before it counts as fixed — one green run proves nothing, as the
2026-08-22 red/green pair showed. Both prior drafts looked correct on paper and were not.

**§3h — the escalation-result validity floor.** Same-day follow-up (2026-08-23) after §3g's classifier
fix shipped and was live-verified: a full golden-set run passed 23/23 including `g17`, and a direct
trace confirmed `reason_ordinal`'s value-aware confirmation check (below) closed it end to end. Two
more issues surfaced immediately after, from live traffic, unrelated to §3g:

*Bug 1 — `reason_ordinal` confirmed the wrong value.* The gate's "same ordinal word confirms" rule
took the *first* number+unit in the ordinal's clause, not the one nearest it. Real captured failure
(`g20-apple-earnings`): reason *"Apple reported $23.4 billion (or $23.43 billion)... the third fiscal
quarter"* — the claim's own value (23.43) sits in a parenthetical *after* an earlier rounded restatement
(23.4) in the same clause; the first-match lookup grabbed 23.4, treated it as a mismatch, and forced a
correct `supported` claim to `contradicted`. Fixed by picking the number nearest the ordinal match
(character-distance), not the first one in its clause — `clauseValueNear`,
`src/orchestrators/grounnel/gates-reason-grounded.ts`.

*Bug 2 — an escalation tier with no evidence could overwrite a tier that had some.* Grounnel's
escalation phase (§3d's `escalateUnresolved`) re-searches and re-verifies any non-`supported` claim
through up to 2 wider-pool tiers, and the last tier's result unconditionally overwrites the prior one —
no comparison. Real captured failure (`g12-bukowski-death-year`): the base pool reached a correct,
classifier-confirmed `contradicted` twice in a row (once per tier), then the 3rd retry's passage
reranker scored every candidate near zero, VERIFY got nothing to cite, answered `unsupported` — and
that evidence-empty answer silently overwrote two consecutive grounded, correct answers.

The fix is deliberately **not** "protect `contradicted` from re-escalation" — that would disable
`guardEscalatedContradictionReversals`' own legitimate job of catching a *wrong* contradiction (grounded
evidence, wrong entity) when a wider search finds real conflicting or exonerating evidence. Instead: a
narrow **evidence-validity floor**. `hasValidEvidence(citations)` (`pipeline-helpers.ts`) is `true` when
a result has real, gate-surviving citations — the codebase's own existing signal (`citationsInvariant`,
`grounnel.schemas.ts`, already models `evidence===null ⇒ citations===[]`). `escalateUnresolved` snapshots
each claim's prior verdict + evidence-validity before every tier; at the per-claim write site in
`processVerifyResults`, a new result is only allowed to replace the prior one if either the prior had no
valid evidence to protect, or the new one does too. An evidence-empty result never overwrites a
grounded one; a new evidence-backed result (any verdict, including a confidence-downgraded
`unverifiable`) still competes and overwrites normally, same as before.

Review-caught gap (fixed same pass, not shipped separately): a claim protected this way still had
`reconcileContradictedVerdicts` — called unconditionally at the end of the same `runBatch` — immediately
re-scrutinize it via a fresh classifier call, because `gateEventsByClaimId` for the rejected pass never
shows a `"contradicted"` origin. Fixed by having the floor add the claim to the same
`protectedContradictionClaimIds` set `reason_ordinal` protection already populates — one shared
exclusion, checked by both `reconcileContradictedVerdicts` (stops the immediate re-scrutiny) and
`findUnresolvedClaims` (stops further escalation tiers from re-exposing the same claim to the same
race).

Verified: offline replay of both real captured failures (now pass), the full pre-existing
`reason_ordinal`/escalation test suite (zero regressions), and 3 new integration tests covering the
three cases that must be told apart — evidence-empty rejected, real-new-evidence accepted (any verdict),
confidence-downgraded-but-grounded accepted.

**Live re-verification, completed 2026-08-23 (deployed).** Direct replay of both real captured
failures against the live deployment: `g12-bukowski-death-year` → `contradicted` with real citations
to the 1994 death date; gate trace confirms the floor's own logic on both sides — the primary pass's
evidence-empty `unsupported` was correctly *not* protected, letting tier 1's evidence-backed
`contradicted` overwrite it, and that result then survived a further tier via an accept-type
`escalation_replacement` event. `g20-apple-earnings-year-over-year` → all 13 extracted claims
correct, including the `$23.43 billion` value the same-day `clauseValueNear` fix targeted. Full
golden-set run: 22/23 graded claims correct, zero regressions against any previously-green case. The
sole failure is `g17` — unrelated to either §3h fix; see §3i.

**§3i — `g17` still red after §3g: reclassified from a coverage/rule gap to a reason-representation
limitation. Investigation plan before any further gate or prompt change.** Same live-verification run
(2026-08-23) that closed §3h re-ran `g17` and it failed again, but not the way §3f/§3g's fixes were
built for — two things changed the diagnosis:

*The `59 seconds` claim (extracted alongside the graded `852 feet` one, same article) shows the §3g
rule is present but not reliably applied, not missing.* Its reason — *"the passages state that the
**longest flight** ... lasted 59 seconds"* — names the exact phrasing §3g's shipped prompt rule
(`consistency-check/system.json` v1.2.0, confirmed the live-deployed version via
`grounnel_llm_calls.prompt_version`) gives as a worked example of a *different member* ("a ranking
where the claim used a position (**'the longest flight'**)"). The classifier still returned
`consistent: true`. §3g was written and verified against captured *examples*, not tested for
adherence under load — this is the first live case that isolates the two.

*The graded `852 feet` claim shows a deeper gap §3g's rule cannot reach by construction.* Its reason —
*"Multiple sources state **the flight** covered 852 feet"* — contains no ordinal or ranking word at
all, despite the cited evidence explicitly stating *"the last flight ... was 852 feet ... much longer
than each of the three previous flights of 120, 175 and 200 feet."* Every check built in §3a–§3g reads
VERIFY's `reason`, a lossy natural-language summary VERIFY is free to write without preserving the
claim's discriminating qualifier. No rule refinement fixes a distinction the reason never makes — this
is upstream of prompt quality, the same shape as §3f's "upstream of the ordinal gate" finding, one
layer further back.

**Rejected: iterating the prompt or swapping models without measurement.** §3g's own history — three
drafts, two review rounds, the first two failing in opposite directions (too broad, then too narrow) —
is direct evidence this axis is subtle enough that blind iteration is expensive and previously
regressed into false-accusation risk (§3e's `last`/`final` revert). `g17` is a *miss* (false claim
marked `supported`), not a *false accusation* (true claim marked `contradicted`); ADR-000 §2's
discipline weighs the latter far worse, which argues against another aggressive deterministic
heuristic here.

**Plan (P0–P3, read-only/offline, no production change — same before-measurement discipline §3f used
for its own retrieval fix):**
- **P0**: run `g17` live 10× against the deployed pipeline; capture full `reason` + verdict + cited
  evidence per run. One sample (today's) already produced two different failure shapes across its two
  wrong claims — build the actual phrasing distribution before designing against it.
- **P1**: replay every `(claim, reason, verdict)` triple captured in P0 through the exact
  `consistency-check` v1.2.0 prompt on `flash` and `pro`, offline, diffed against `flash-lite`'s actual
  live answer. Isolates *model-adherence ceiling* (rule present, weakest model didn't apply it — a
  model-tier change becomes a legitimate low-cost fix) from *rule unlearnability* (no model applies
  it — stop iterating this prompt).
- **P2**: offline prototype — run `lib/instance-selector.ts`'s existing extraction against the claim
  and, separately, against each P0 case's *cited evidence sentences* (not `reason`). Evidence is ground
  truth the reason is free to omit; measures whether the discriminating fact survives to citation stage
  even on the `852 feet` shape where the reason drops it entirely.
- **P3**: same P2 prototype against currently-green cases whose evidence contains legitimate
  co-reference — `g01` (tower/Eiffel Tower), `g08` (Corsica/Ajaccio), `g13` (wedlock phrasing), `g20`
  (Q3 FY2025/"third fiscal quarter of 2025"). An evidence-side check must clear the same false-positive
  bar §3g's shipped rule took two review rounds to clear, before it's a wiring candidate, not after.

**Decision gate** (after P0–P3, not before): a selector word present in most failing reasons and a
stronger model gets them right → narrow model-tier change for `consistency_check` only. Present but no
model gets them right → the §3g rule is unlearnable as phrased, stop iterating it. A meaningful
fraction of failures have no selector word in the reason at all → an evidence-side check is load-bearing
regardless of P1's result, since reason-only can never catch that shape. P2 false-positives on P3's
green cases → not ready to wire in; needs the same alias/format-normalization work §3g already did,
moved earlier in the pipeline.

**Explicitly not doing until P0–P3 report back**: widening `ORDINAL_WORDS` again (§3e's revert
stands); another `consistency-check` prompt section: another `applyReason*Gate`; protecting `g17`
specifically; relaxing `ACCEPTABLE.false`; touching escalation semantics again; a production model-tier
change made without P1's comparison data.

**P0 result (2026-08-23/24, 5 live runs, HTTP-rate-limited to 5/hour before a Gemini daily-quota
exhaustion stopped further sampling — small-n but enough to separate mechanisms).** Full gate trace
+ `grounnel_llm_calls.consistency_check` output pulled for both graded-relevant claims
(`852 feet`, `59 seconds`) across all 5 runs — 10 instances total, 4 correct. The 6 wrong instances
split into **three distinct mechanisms**, not one, only one of which P1 as originally scoped would
even test:

- **Mode A — genuine classifier miss (3/6).** `consistency_check`'s *first* call on the reason
  returns `consistent: true` outright, no retry ever triggered, despite the reason using exactly the
  phrasing §3g's rule targets — e.g. run 3: *"Source A states that the longest flight traveled 852
  feet in 59 seconds"* → `consistent: true`. This is what P1 tests.
- **Mode B — retry result never re-checked (2/6, newly found, not anticipated by the P0–P3 plan).**
  `consistency_check` correctly returns `consistent: false` on the primary reason, which correctly
  triggers exactly one VERIFY retry (`counterfact_ignored` diagnostic → `needsRetry`) — but the
  retry's *new* reason is never run back through `consistency_check`, by design (single-retry, no
  loop). Real trace, run 4, claim `04ea3b3a` ("first flight lasted 59 seconds"): primary reason
  flagged inconsistent correctly → retry produces a second `supported` verdict with a new reason that
  happens not to trip any deterministic gate either → stored as final, unchecked. **This is a process
  gap, not a model-capability gap** — the classifier did its job once; nothing asks it again. A
  stronger model on the *original* reason (P1) would not touch this mechanism at all, because the
  original reason was already correctly caught.
- **Mode C — reason omits the selector entirely (1/6, confirms §3i's core finding above).** Run 5,
  claim `f8d7f3a7`: reason *"Multiple sentences across sources A, B, and C state that the first
  flight covered 852 feet"* restates the claim's own ordinal verbatim with no competing selector
  word anywhere — `consistent: true` is the textbook-correct answer to the question actually asked;
  there is nothing inconsistent about a reason that doesn't contradict itself. Happened twice in a
  row for this claim (primary pass, then again independently in the escalation tier's own reason) —
  not a one-off. Only an evidence-side check (P2/P3) can reach this class.

**Revises the P1 framing above**: P1 alone cannot close Mode B regardless of outcome — a model
upgrade only helps Mode A. Mode B's fix is cheap and independent of P1/model choice: extend the
existing `checkRetryContradiction` precedent (already re-checks a retry landing on `contradicted`) to
also cover a retry landing on `supported`/`partially_supported`, and only in the safe direction — a
retry still found inconsistent downgrades to `unverifiable`, never forces `contradicted`, matching
this ADR's standing false-accusation asymmetry. Not implemented yet — flagging here so it isn't lost;
P1/P2/P3 continue as planned once the Gemini daily quota resets, Mode B fix is a candidate to
prioritize independently since it needs no model-comparison data to justify.

**Mode B fix — implemented and tested (2026-08-24).** `checkRetryContradiction`'s early-return
widened from `chain.verdict !== "contradicted"` to also admit `supported`/`partially_supported`; on
an inconsistent retry, `supported`/`partially_supported` downgrades to `unverifiable` (never
`contradicted`, per the asymmetry above). One design correction made during testing, not assumed
upfront: the first version kept the retry's evidence/citations on this downgrade (reasoning it was a
confidence-level judgment, like D030 §3h's floor). The existing suite caught why that's wrong —
`rewriteUngroundedAffirmativeReason` only cleans up an affirmative-sounding reason when
`citations.length === 0`, so keeping citations left the classifier-flagged-as-wrong reason text
(*"the passage confirms... supporting the claim"*) sitting next to an `unverifiable` verdict,
reintroducing the exact incoherence D031 fixed for the other two reconciliation paths. Fixed by
nulling evidence uniformly on both downgrade branches, matching `reconcileContradictedVerdicts` and
`guardEscalatedContradictionReversals`'s own convention — this is a classifier-caught textual
inconsistency, not a confidence call, so the distinction from D030 §3h's floor (which legitimately
keeps evidence) holds up: that floor protects evidence the classifier never disputed.

**Interaction with the D030 §3h escalation-validity floor, discovered via the existing test suite,
not new test-writing — better than designed, not just "not a conflict."** One pre-existing test
(D026 §17: an escalation tier's bogus flip away from a correct `contradicted`) failed after this
change. Root cause, traced with temporary instrumentation rather than assumed: `checkRetryContradiction`
now catches the bad retry *inside* tier 5's own `runBatch`, before `guardEscalatedContradictionReversals`
(which runs afterward, at the escalation-tier level) ever sees a `supported` verdict to react to — and
nulling the retry's evidence, on its own downgrade to `unverifiable`, makes that tier's result look
evidence-empty to the §3h floor (checked immediately after, same `runBatch`). Since the *prior* tier
(the base pool) had real, valid evidence for its `contradicted` verdict, the floor rejects tier 5's
replacement outright — so the claim's final stored state is the base pool's **original `contradicted`
verdict, untouched, with its real evidence and reason**, not `unverifiable`. Two independently-reasoned
safety nets — one checking "does this retry's own reason support its own verdict," the other checking
"can an evidence-empty result overwrite an evidence-backed one" — composed into a strictly better
outcome than either produces alone: not just "no false affirmation" (what Mode B alone gives) but the
actual right answer restored, without either mechanism knowing about the other's existence. Test
updated to expect `contradicted` with real evidence (not `unverifiable`, not `unsupported`) — plus both
gate events on record (`retry_reconciliation` showing the retry was caught, `escalation_replacement`
showing the floor rejected it), since the audit trail preserves what almost happened, not just what
ended up stored. A second, `checkRetryContradiction`-isolated test added (primary-pass retry, no
escalation tier, so the §3h floor never enters — `priorResults` is only threaded into escalation-tier
`runBatch` calls, not the primary pass's) to cover the mechanism on its own, using the actual live
`g17` reason text captured 2026-08-23 ("Both sources state that the longest flight of the day lasted
59 seconds."). Verified: full suite (1164 tests, 85 files) passes, zero regressions beyond the one
updated assertion.

**Considered and rejected: adding a Mode B downgrade to `protectedContradictionClaimIds`.** A
`/code-review` pass (cross-file angle) noted a Mode B `unverifiable` downgrade on the primary pass
(no prior tier, so the §3h floor never applies) isn't protected from further escalation the way
`reason_ordinal`'s contradictions are — it gets re-escalated through both remaining tiers at real
search/LLM cost. Deliberately not fixed: `reason_ordinal` protection exists because that signal is
trusted as high-precision (D030 §3d — "gate-originated ordinal contradictions... trusted as
high-precision"). Mode B's signal is the opposite by construction — it downgrades to `unverifiable`
*because* it's uncertain, not confident — so giving it the same protection would mean permanently
giving up on a claim a wider search tier might genuinely resolve, for a signal that was never claiming
to be precise. Letting it re-escalate normally, same as any other `unverifiable` result, is consistent
with this ADR's own stated basis for when protection is and isn't warranted.

**Also found and fixed in the same review pass** (not spun into their own paragraphs, listed for the
record): `logReconciliationDowngrade`'s log message hardcoded "...to unsupported" regardless of actual
target — now takes `verdictAfter` and reports it accurately (`pipeline-helpers.ts`). The downgrade
target/gate-reason-code pair, previously two independent ternaries on the same `chain.verdict ===
"contradicted"` test, is now one `RETRY_DOWNGRADE` table keyed by verdict, shared by `checkable`'s own
check — removes the risk of the two drifting apart. `gateEventsByClaimId` (current-pass-only, unlike
`chain.gateEvents`) previously never recorded `checkRetryContradiction`'s own gate event — confirmed
currently harmless (only queried for claims ending `contradicted`, which this path never produces on
override) but fixed anyway, since the map's completeness is treated as load-bearing elsewhere in this
file. `verify-experiment.ts`'s P1 comparison ran the two comparison models at `temperature: 0.7`
while the production arm (`callLlmForJson`) always forces `0` — a real confound on top of the
already-noted batch-size one; fixed to `0` for a same-conditions comparison, plus added the timeout
`GeminiProvider` always sets that the direct-SDK comparison path was missing.

**P1 status: blocked on infrastructure, not quota timing.** Retried with pacing once the initial
daily-quota exhaustion cleared; found two separate hard blocks specific to running Gemini calls
directly from this dev environment's API key, neither fixable by retrying: `gemini-2.5-flash` fails
`400: User location is not supported` on 9/9 attempts (not intermittent); `gemini-3.1-pro-preview`
(the deprecated `gemini-2.5-pro`'s suggested replacement) has `limit: 0` on this key's free tier —
zero allocated quota, not a rate limit. The only Gemini path that has ever worked this investigation
is `gemini-2.5-flash-lite` through the deployed Vercel app (P0's successful runs) — presumably
Vercel's egress sits in a supported region/tier this local machine's key does not. Closing P1 for
real requires either a different API key/project with `flash`/`pro` quota, or temporarily changing
the **deployed production** `GEMINI_MODEL` env var and replaying through `/extract` — a live-traffic
config change requiring explicit sign-off, not attempted here.

**P1 result (2026-08-24, resolved via `src/jobs/verify-experiment.ts`, run on the deployed app where
Gemini calls actually work).** Rather than a production config change, the local-blocked comparison
was moved into this repo's existing one-off experiment job (already Inngest-based, already deployed)
as a second part alongside its original VERIFY-formatting variants: the same 9 real captured
`(claim, reason, verdict)` triples from P0, replayed through the exact `consistency_check` prompt on
the current production model plus two stronger candidates, graded against a hand-verified expected
answer per triple (one of the 9 is a Mode C control whose correct answer is `consistent: true` —
tests that a stronger model isn't just answering "inconsistent" more often).

| Model | Correct | Errors |
|---|---|---|
| `gemini-2.5-flash-lite` (current production) | 8/9 | 0 |
| `gemini-2.5-flash` | 7/9 | 0 |
| `gemini-3.1-pro-preview` | **9/9** | 0 |

`gemini-3.1-pro-preview` got every triple right, including the Mode C control (confirming it isn't
just over-triggering). Mid-tier `flash` scored *worse* than the production `flash-lite`.

**Confound — this does NOT cleanly answer the decision gate, contrary to how it first reads.** The
replay sends each triple as a **single-item batch**; production batches the whole VERIFY batch into
one `consistency_check` call (verified: the live calls behind these very fixtures carried
`batch_size: 5`, with the single-item calls being only the T034 retry re-checks). So production
`flash-lite` scoring 8/9 *in isolation* is not comparable to its live behaviour on the same triples,
where it demonstrably missed several — and `pro-preview`'s 9/9 was measured under the same
easier-than-production conditions, so it is not evidence it would hold up at batch size 5 either.
The prompt's own standing `INDEPENDENCE: evaluate each pair independently. Do not let one pair
influence another, even in the same batch.` line indicates batch contamination was already suspected
when the classifier was written.

**Revised reading**: the Mode A misses are consistent with *either* a model-capability ceiling *or*
batch-size attention dilution, and this experiment cannot separate them. The cheap discriminating
follow-up is to re-run the same 9 fixtures at production batch size (pad to 5 with the run's real
sibling claims) across all three models — same job, one changed variable. Until that runs, a
model-tier upgrade for `consistency_check` is **not** justified by this data, and neither is ruling
one out. Mode B/C still need their own independent fixes regardless (§3h/§3i above).

**P2/P3 result (2026-08-23/24, pure deterministic prototype, no LLM calls — `lib/instance-selector.ts`
reused as-is, evidence scanned for `first`..`tenth`/`last`/`final` on the claim's own anchor).**

*P2, against the same 5 real `g17` runs*: catches the Mode C case exactly as predicted — run 5's
`852 feet` claim (reason omitted the selector entirely, `consistent: true` was the correct answer to
the question `consistency_check` was asked) is caught by scanning its *own cited evidence*, which
contains *"the last flight ... was 852 feet ... much longer than each of the three previous flights of
120, 175 and 200 feet"*. Reason-only checks structurally cannot reach this; evidence-side does. But it
missed 3 of the other 5 wrong instances (both `59 seconds` misses, run 3's `852 feet`) — their cited
evidence uses *"the longest traveling 852 feet in 59 seconds"*, a superlative, and the prototype
deliberately excludes superlatives (same §3e exclusion, applied to evidence this time). Closing that
gap means re-litigating §3e's superlative question on evidence text specifically — not done here,
flagged as the next sub-question if this direction is pursued.

*P3, against real cited evidence from tonight's already-green `g20`/`g01`/`g08`/`g13` claims (13 Apple
claims tested, the rest skipped — no single extractable selector)*: **2 real false positives**, both
confirming the exact risk class this prototype was built to test for, just relocated from reason
prose to evidence prose:
- `"Apple disclosed its third fiscal quarter 2026 financial results"` vs. cited evidence *"...its
  third fiscal quarter of 2026, which corresponds to the **second** calendar quarter of the year"* —
  flagged as a different member; it's a fiscal/calendar quarter-numbering aside, not a different
  instance.
- `"Apple reported $94.04 billion in revenue in the third fiscal quarter of 2025"` vs. cited evidence
  *"...up 10% from the same quarter **last** year..."* — flagged via the `last` widening; it's the
  identical "last year" idiom §3e's own revert (commit `bb11072`) was written to avoid, now
  reproduced on evidence text instead of reason text.

**Conclusion**: evidence-side checking is not a free win — the same idiom/dimension-aliasing risk
§3g took two review rounds to close on reason text applies to evidence text too, confirmed with real
data, not speculation. Superlatives still need a carve-out to reach Mode A's Apple-style misses. Not
ready to wire in. Next increment if pursued: exclude `last`/`next`/`this` + `year`/`week`/`month`
(temporal idiom) and `calendar`/`fiscal` + ordinal (dimension aliasing) before even considering a
superlative widening — both fixes are prerequisites, not alternatives, since P2 already needs the
superlative widening to close its own remaining gap and P3 shows the plain widening isn't safe without
them.

**§3j — live false accusation, same day as the Mode B deploy (2026-08-24): `clauseValueNear`'s
nearest-value pick was never the right rule, just under-tested in one direction.** User-reported
golden-set failure minutes after deploying `da17192`: `g20-apple-earnings-year-over-year` regressed
to a false accusation — `"Apple reported $23.43 billion in net profit in the third fiscal quarter of
2025."` (real, evidence-grounded) forced to `contradicted`. Traced via the gate trace: `reason_ordinal`
fired directly, no `retry_reconciliation` event anywhere in the trace — unrelated to the Mode B deploy
that had just gone out; a separate, pre-existing bug in `clauseValueNear` (§3h's own fix, shipped
hours earlier) surfacing on a new phrasing.

**Root cause**: the real captured reason — *"Multiple sources state that Apple reported $23.43 billion
(or $23.42 billion) in profit for the third fiscal quarter of 2025."* — contains `$23.42 billion`, a
value that appears in **neither the evidence nor the claim** (evidence has `$23.43 billion` precise
and `$23.4 billion` rounded only). VERIFY itself generated this near-duplicate — a paraphrase/rounding
artifact, not evidence-grounded. It happened to sit closer to "third" than the claim's real value
(`$23.43 billion`), so `clauseValueNear`'s nearest-only pick chose the hallucinated one, mismatched
against the claim, and forced a contradiction. **Exact mirror image** of §3h's own original bug (there,
a *rounded* value was nearest and wrongly outranked the claim's precise one; here, a *hallucinated*
value was nearest and wrongly outranked the claim's real one) — proving "nearest wins" was never
correct, just under-tested against only one direction of the failure.

**Fix**: `clauseValueNear` (single nearest pick) kept only for the claim side, where one relevant
number per clause is the norm. A new `clauseValues` returns every number+unit in the ordinal's own
clause, nearest-first. The reason-side same-ordinal-word confirmation check (§3g) now asks "does the
claim's own value appear **anywhere** in the clause's same-unit values" rather than "is the single
nearest value an exact match" — the claim's value being present anywhere is confirmation regardless of
which value happens to sit physically closest to the ordinal word. This fixes both directions with one
rule: a rounded restatement or a hallucinated near-duplicate can sit as close to the ordinal as they
like: the real value being present anywhere in the clause still confirms. Genuine mismatch detection
(a different ordinal *word* — "fourth" vs "first") is untouched — that branch never depended on value
proximity at all.

Verified offline against three real cases: this new regression (now `supported`, unchanged), §3h's
original regression (still `supported`, no re-regression), and a genuine value-and-ordinal mismatch
(still correctly `contradicted`) — all three behave correctly under one rule. Full suite (149
`gates.test.ts` tests including the unaffected T009 10/10 held-out recall; 1164 tests / 85 files
repo-wide) passes. New regression test added next to §3h's own, using the exact captured reason text.

**`/code-review` on this fix (same day, before deploy) found a real second regression the offline
verification above didn't cover: presence isn't the same as assertion.** `clauseValues`'s any-match
rule confirms if the claim's value appears anywhere in the clause — but a value can appear while being
explicitly *rejected*: `claimText: "The first flight covered 852 ft."`, `reason: "The first flight
covered 900 ft not 852 ft."` — under the §3j fix as first shipped, this wrongly returned `supported`
(852 is present in the clause, so it "confirmed"), silently swallowing a genuine contradiction the
prior nearest-only code caught correctly. Verified by diffing the two commits' behavior directly on
this input.

**Fixed**: `clauseValues` now keeps each match's own text index; the existing ordinal negation-window
check (`isOrdinalNegated`, renamed `isNegatedAtPosition` — it was never actually ordinal-specific,
just named for its one prior caller) is reused for values too. A value counts toward confirmation only
when it appears **unnegated**.

**The same review also found the mirror bug still open on the claim side** (Q4): `claimValue` was
still single-nearest, unchanged by the first §3j pass. A claim phrased with its own parenthetical
aside — `"The third fiscal quarter profit was $23.4 billion (or precisely $23.43 billion) for
Apple."` — could mispick the rounded figure as "the" claim value, then a reason correctly stating only
the precise one fails to match, forcing exactly the false-accusation class this whole section exists to
prevent. Verified by diffing the two commits on this input too. **Fixed as part of the same change**,
not left open the way §3h left an equivalent asymmetry across `checkRetryContradiction`'s two verdict
branches: `claimValue` (singular) became `claimValues` (every unnegated same-clause value); the
reason-side check now asks whether *any* unnegated reason value matches *any* unnegated claim value of
the same unit, rather than comparing a single pick on each side. `clauseValueNear` (now unused by
both sides) removed; `clauseValues`'s distance-sort (only ever needed for that single-pick use) removed
with it — the confirmation check is a pure membership test over both value sets, order doesn't matter.

**Also flagged, not fixed — pre-existing, not introduced by this diff**: the `for` loop's `return` on
any confirming same-ordinal-word occurrence unconditionally discards an earlier iteration's
`competing = true` from a *different* occurrence in the same reason (documented, deliberate design —
"confirmation takes precedence," data-model.md §1 step 4). The §3j any-match widening makes each
individual occurrence marginally easier to confirm, which makes this existing gap marginally easier to
hit in practice, but doesn't create it. No real captured case has shown this — noted here as a known,
accepted tradeoff, not chased further, consistent with this ADR's standing discipline of building
fixes from reproduced live failures, not speculative ones (§3e's `last`/`final` revert is the concrete
example of what chasing an untested hypothetical cost here before).

Re-verified all 5 cases (2 original regressions, the new negation case, the new claim-side case, one
genuine mismatch) offline after the negation/claim-side fix — all correct under one unified rule.
`tsc --noEmit` clean. Full suite: 87 files / 1170 tests (two ad-hoc probe test files a review agent
left behind inflate this count by a couple of files/tests — untracked, never staged, harmless but not
yet cleaned up as of this writing; core suite is unchanged at 85 files / 1165 tests plus this section's
own 1 new test).

**Deployed 2026-08-24 11:25 UTC and live-verified the same day — outcome is mixed, see §3k.** Both
§3j fixes hold: the two reason phrasings that caused real false accusations (the `$23.4bn (or $23.43bn)`
rounding restatement and the `$23.42bn` hallucinated near-duplicate) no longer fire, confirmed by
replaying every historical firing of this gate through the deployed code. A **third** phrasing of the
same claim, not seen before that day, produced a fresh false accusation within an hour of deploy. §3k
documents it, and the measurement failure that let §3j be reported as verified on the strength of a
single green run.

### §3k. Rounded restatements across a clause boundary; and the measurement error that hid it (2026-08-24)

**Trigger.** Eval run `01M0SS52G1PQXR28HE9Z1PN7MZ`, ~20 minutes after the §3j deploy, fired **two
concurrent passes over the same golden set on the same commit**. Pass A scored 23/23 with zero false
accusations. Pass B scored 21/23 and produced a false accusation. Same code, same inputs, two minutes
apart.

**The first finding is methodological, and it is the more important one.** §3h and §3j were each
reported as live-verified on the strength of one green run. This pipeline is stochastic across
retrieval, rerank, VERIFY sampling and escalation; a single run is a draw from a distribution, not a
verdict. Two runs of the same golden set disagreeing by two cases is the direct evidence. Concretely,
g17's own headline claim lands on the correct `contradicted` in only **9 of 23** eval runs since
2026-08-22 (39%; `supported` 13, `unverifiable` 1) — meaning every green g17 this ADR has recorded,
including the one in §3j, was that coin landing well rather than a fix taking hold. No claim of the
form "verified live" is admissible from a single run anywhere in this ADR going forward. The eval
protocol change this forces (repeated runs, separate safety and detection gates) is being designed and
measured first and will get its own ADR **after** a baseline characterization run, deliberately not
before — writing it now would encode hypotheses as architecture.

**The two Pass-B failures have unrelated causes, and only one of them is this gate's.**

*g20 — this gate, a false accusation.* Claim `Apple reported $23.43 billion in net profit in the third
fiscal quarter of 2025` is **true**. Gate trace: `reason_ordinal: supported → contradicted
(reason_ordinal_mismatch)`. VERIFY was correct and said so explicitly — its reason ends *"The slight
difference in cents is negligible and the claim is supported."* The gate overrode a correct verdict on
a true claim, which is the exact failure class this ADR exists to prevent. Mechanism:

```
"…Source A sentence 7 states net income was $23.43 billion.  |  Source B sentence 5 and Source C
 sentence 4 state net quarterly profit was $23.4 billion for the third fiscal quarter of 2025.  | …"
   ^ confirming value, sentence 1                                ^ rounded value + the ordinal, sentence 2
```

The confirming `$23.43 billion` sits in sentence 1. The ordinal `third` and the rounded `$23.4 billion`
sit in sentence 2. §3j's any-match widening searches only the ordinal's **own clause**, so the
confirmation is out of scope and `23.4 ≠ 23.43` reads as a competing value. This is a genuinely new
instance, not a regression of §3j: the two phrasings §3j fixed both had the confirming value inside the
ordinal's clause. Reproduced deterministically offline against the deployed code.

*g17 — not this gate.* VERIFY's reason claimed *"the first flight covered a distance of 852 feet"*
while its own retrieved evidence says *"record flight"* and *"the longest of four."* The reason
confirms the claim's own ordinal, so this gate correctly abstained; escalation then replaced an
`unverifiable` with that `supported`. No ordinal-gate change can reach this — it is the evidence/verifier
side (§3i's "Mode C"), and it is why this gate is being frozen below.

**Method — replay, not reasoning.** Every historical firing of this gate (34, across `eval` and
`production`, 2026-08-19 → 2026-08-24) was extracted with its claim and reason and replayed through
candidate code. This replaces "does this break the tests" with "what would this have done to every real
firing on record." Caveat recorded for whoever repeats it: `grounnel_claims.reason` stores the *final*
user-facing reason, which `rewriteUngroundedAffirmativeReason` may have rewritten after the gate ran,
so replay fidelity degrades for older rows where the verdict was later reverted; the recent corpus,
where the stored reason is what the gate saw, is the load-bearing part.

**Fix — a rounded restatement is not a competing value.** The semantic error is that `23.4` and `23.43`
were treated as different measurements when one is a rounded representation of the other. Fixing the
*comparison* rather than the clause boundary also avoids adding a fourth positional exception to a gate
that already has three.

> **Rule.** Two values agree iff, rounded half-up to the **lesser** of their two decimal precisions,
> their digit strings are identical. Rounding is decimal-exact. Precision means **decimal places only**,
> never significant figures.

| Pair | Result | Rationale |
| --- | --- | --- |
| `23.4` / `23.43` | agree | the live failure above |
| `1.20` / `1.2`, `0.1` / `0.10`, `852` / `852.0` | agree | trailing zeros carry no information |
| `2.675` / `2.68`, `23.45` / `23.5`, `1.005` / `1.01` | agree | exact-half, decimal semantics |
| `1.20` / `1.21`, `23.4` / `24.4`, `120` / `852` | conflict | genuinely different values |
| `23.45` / `23.4` | conflict | `23.45` resolves to `23.5` at 1 dp |
| `23.4` / `23.49` | **conflict** | see policy note 1 |
| `59` / `59.4` | **agree** | see policy note 2 |
| `852` / `850` | conflict | significant-figure rounding is out of scope, by choice |

*Policy note 1 — `23.4` / `23.49` = conflict.* Stated precisely: under this gate's decimal-precision
policy the two resolve to different values at their shared one-decimal precision (`23.49` → `23.5`).
The looser phrasing "23.49 is not a correct rounding of 23.4" is wrong and should not be used — `23.4`
is a legitimate one-decimal representation of `23.43`, `23.44` and others; it is `23.49` specifically
that resolves elsewhere. Conflict is the conservative call: accepting it would let the gate silently
repair a source that may have rounded incorrectly, which is not this gate's job.

*Policy note 2 — `59` / `59.4` = agree.* This follows mechanically from the rule (shared precision 0).
It is recorded as **numeric representational agreement only** — explicitly *not* a claim that a
59-second and a 59.4-second measurement are semantically interchangeable. Measurement compatibility is a
separate concept that would need a domain-specific tolerance, and no such tolerance is being invented
here on the strength of one example. Noted as known scope, not generalized.

**A defect the boundary table caught before it shipped.** The first candidate used
`Number.prototype.toFixed`, which rounds in binary rather than decimal: `(2.675).toFixed(2) === "2.67"`,
`(23.45).toFixed(1) === "23.4"`, `(1.005).toFixed(2) === "1.00"` — all disagreeing with decimal
half-up. The `2.675` case errs toward **conflict**, i.e. toward a false accusation, the one direction
this ADR cannot tolerate. Replaced with exact-decimal rounding over the digit string (`BigInt`,
half-up), never binary float. This is the concrete argument for demanding an explicit, enumerated
boundary table before adopting any numeric tolerance: the defect was invisible in the motivating case
and in all 151 unit tests, and surfaced only from deliberately probing exact-half inputs.

**Verification.** `tsc --noEmit` clean; 151/151 gate unit tests; the live failure fixed; both §3j
variants still fixed; genuine ordinal mismatches and the §3j negation case still fire; and across the
full 34-firing replay corpus, **19 true positives preserved and 0 false accusations** — the first
version of this gate to record zero across all of its own history.

**Scope limit, stated deliberately.** The defensible claim is *"no false accusations across the
recorded firing corpus,"* not *"`reason_ordinal` is solved."* This fixes the **rounding subclass**. The
clause-scoping blind spot itself remains: a genuinely different value inside the ordinal's clause, with
the confirming value in a neighbouring sentence, would still false-fire. Three separate phrasings of one
claim have now each defeated a different version of this gate, which is the real signal — the gate's
precision depends on how much structure it can recover from free-form reason prose, and prose keeps
producing new shapes.

**Decision: freeze this gate.** After this change, no further edits to `applyReasonOrdinalGate` unless a
**new, independently reproduced** failure mode appears — specifically not in response to another g17
miss. g17 is a verifier/evidence problem (39% catch rate, this section's Pass-B failure being a clean
example), and further ordinal-gate refinement is now negative-value work for it: each of the last three
iterations fixed one phrasing and was defeated by another. g17 continues as a measured detection case
with its fixture semantics unchanged (`kind: false`, `acceptable: ["contradicted"]`) — it is never to be
weakened or quietly excluded to make a suite look green; §3e is the standing example of what mutating
the target instead of the system costs here.

**Amendment (2026-08-26, D032 §3k/§9): unfrozen, on this freeze's own exemption.** Spec 013's T10
measured a new class this freeze did not anticipate: `applyReasonOrdinalGate` overriding `supported`
to `contradicted` on a **negated** claim ("Buzz Aldrin was not the first man to walk on the Moon"),
because the gate compared its extracted ordinal against the reason with no check for whether that
ordinal sat inside the claim's own negation — a different reason's "second" then read as a competing
value instead of confirmation of the negation. This is exactly what the freeze's own clause carves
out: *"a new, independently reproduced failure mode"*, reproduced 3/10 on a fresh golden case, not
"another g17 miss" (g17 has no negation). The fix (D032 §9) is a negation-scope **precondition** —
one more reason to abstain, not a fourth positional exception layered onto the three this section
already added. `applyReasonOrdinalGate` may be edited again for this class only; the freeze's
original scope (phrasing-variant whack-a-mole against g17) still stands.

**Re-frozen (2026-08-27, spec 013 T20).** T12 shipped and is live-verified; the scoped unfreeze above
is spent. `applyReasonOrdinalGate` is frozen again on the original terms. This is stated explicitly
because a fresh measurement immediately created pressure to reopen it: g17 was measured at a **~33%**
catch rate (n=82 — `supported` 42, `contradicted` 24, `unverifiable` 6, `unsupported` 1), and the
obvious-looking response is to tune this gate. **That is the wrong move and this freeze exists to stop
it.** The gate is not the defect: 25/25 historical g17 catches still fire on current code, and it
overrides correctly whenever VERIFY names a competing ordinal. The miss happens upstream — VERIFY
often reports "the distance covered was 852 feet" without saying *which* flight, leaving the gate
nothing to compare (`reasonMatches.length === 0`, abstain). Tuning a correct gate to compensate for an
unreliable input is how §3k's original whack-a-mole started, and how T17's live false accusation
("12-second" read as the ordinal "second") became possible. g17 stays **red at `minCorrectRate: 1.0`**
— the measured 33% is a measurement, not a revised requirement.

**Incidental observation, deliberately not acted on.** Gate-firing rates across all recorded history
show `counterfact_ignored` at **0 overrides in 7,237 evaluations** — dead in all observed eval and
production traffic. It is *not* being deleted as part of this work. Establishing that a guard hasn't
fired recently is not the same as establishing it is unreachable or unnecessary; removing it needs its
own small decision that first identifies which ADR introduced it, what regression it was built for, and
whether current golden/live traffic actually exercises its trigger path. Recorded here so the
observation isn't lost, not as a mandate.

### §3l. `subject_entity`: measured, root-caused, and NOT fixed yet (2026-08-24)

**Why this section exists at all.** `applySubjectEntityGate` was added in `ed57831` as a "deterministic
backstop for g17" and has **no decision record anywhere** — not in this ADR, not in D026, nowhere in
`docs/` or `specs/`. It is the only gate in the chain in that position. Its ~7.6% lifetime override
rate (165/2171 evaluations) went unexamined until now. That gap is itself the finding: a gate nobody
wrote down is a gate nobody re-checks.

**What it does.** Last in the chain, fires only on `supported`/`partially_supported`, downgrades to
`unverifiable` and nulls evidence when `sameEntity(subjectEntity ?? claimText, evidence)` is false —
i.e. when both the claim's subject anchor and the cited evidence contain proper nouns but share none.
It can never produce `contradicted`, so **it cannot cause a false accusation**; every mistake it makes
is a detection miss, on the safe side of this project's asymmetry.

**Measurement (all 132 distinct claims it ever fired on, reconstructed from history at zero API cost).**
`subject_entity` recovery is possible because EXTRACT's own `subject_entity` output survives in
`grounnel_llm_calls.parsed_output` — it is not persisted on `grounnel_claims`, but it is not lost.

| Ground truth | Firings | Ended `supported` | Ended `unverifiable` | Ended `contradicted` |
| --- | --- | --- | --- | --- |
| TRUE claim (gate was wrong to fire) | 81 | 49 | **31** | — |
| FALSE claim (firing had value) | 32 | 13 | 10 | 8 |
| Unclassified | 19 | 15 | 3 | — |

So ~60% of firings self-corrected on a later pass (costing extra VERIFY round-trips, not accuracy), and
**31 TRUE claims were permanently suppressed to `unverifiable`** — 29 of them Apple product-line revenue
figures, plus real production astronomy claims from a JWST article.

**A proposed fix was tested and REFUTED before implementation.** The obvious hypothesis was that the
gate checks the narrow cited `evidence` span while gate #1 one line above already receives the full
pooled `passageText`, so it should check that instead. Simulating that change against every historical
firing with the real `sameEntity`: **130 of 132 firings would stop firing** (131/132 against all
retrieved pages). Passages are retrieved *by searching for the claim*, so they essentially always
contain the subject entity — the "fix" is not a fix, it is a silent deletion of the gate wearing a
one-line diff. Recorded here because it is exactly the change a reasonable reviewer would wave through.

**Actual root cause: `properNounWords` equates "capitalized" with "is an entity name."** Verified by
running the real function on real rejected evidence:

| Subject anchor | Proper nouns found in evidence | Outcome |
| --- | --- | --- |
| `Apple` | `wearables`, `home`, `accessories` | fires — a product *category*, not an entity |
| `Apple` | `mac`, `perhaps`, `cook`, `parekh` | fires — Apple's own product and its own CEO |
| `Apple` | `services` | fires — a capitalized line item |
| `Apple` | *(empty — "iPhone" starts lowercase)* | abstains, by accident of orthography |
| `WASP-121 b` → tokenizes to `wasp-` | `terminators` | fires — sentence-initial capital |

Three distinct defects compound: capitalized common nouns read as entities; sentence-initial
capitalization is only partly filtered (`SENTENCE_START_STOPWORDS` misses "Perhaps"); and an entity's
own products/executives (`Mac`, `Cook`) never string-match the parent name. The premise "evidence names
proper nouns, none of which is my subject ⇒ evidence is about a different entity" is simply unsound
over free text.

**Decision: measure and document now, do not fix in this change.** Every remedy on the table is worse
than the disease at this stage:

- *Stopword/common-noun filtering* is the `ROLE_KEYWORDS` pattern this ADR already reverted once (§1) —
  an unbounded hand-maintained list over free English.
- *Real entity resolution* (knowing `Mac`/`Cook` belong to `Apple`) is a genuinely different system, not
  a gate tweak.
- *Deleting the gate* is defensible on count (81 wrong firings vs 32 useful ones) but not obviously
  right on severity: those 32 are cases where it downgraded a wrong `supported` on a genuinely FALSE
  claim, and 13 of them still ended `supported` anyway. Whether preventing a wrong affirmation is worth
  suppressing ~2.5x as many true ones is a product judgment about detection-rate tradeoffs, not an
  engineering one — and it belongs in the repeated-run detection metrics (§3k / Stage 1), where both
  sides of it are now measurable, rather than being decided off a single reading of history.

The gate stays as-is, unchanged, now documented. It is **safety-neutral by construction**, so leaving it
costs detection rate, never a false accusation. Revisit once the N≥2 repeated-run baseline can quantify
its effect on detection rate directly, instead of inferring it from post-hoc verdict archaeology.

### §3m. `subject_entity` recovery + fix candidates + decision (2026-08-25)

**Reason.** A 50-claim stress article produced a claim that flip-flopped `supported`/`unverifiable`
across identical repeated runs — same code, same input.

**Research.**
- N=10 live repeats, isolated case (`g22`): 11% recovery from a false `subject_entity` trigger (18%
  pooled with an earlier N=2 sample). Cause: claim's stored subject is `"Wright brothers' fourth and
  final flight"`; evidence correctly cites `"Wilbur"` — same person, no literal token match.
- 4 fix candidates simulated offline against the 132 historical firings (no LLM calls): **A** (skip
  override if any citation exists) suppresses 94% — too blunt, ~same failure as an already-refuted
  fix. **C** (require low term-overlap too) suppresses 99% — no discrimination. **B** (null an
  anchor inferred cross-sentence) suppresses 66%, genuinely targeted, but removes protection for
  fully entity-less claims. **B-tight** (only null if claim has its own proper noun) refuted directly:
  fails on sentence-initial "One" (same `SENTENCE_START_STOPWORDS` gap already on record) and drops
  the founding case ("first flight covered 852 feet").
- Full population (159 firings, not just `g22`): **51% aggregate recovery** — `g22` is the worst
  case, not typical. Concentrated in 2 claim families (Apple financials, Wright-brothers flights).
- Cost: ~25–30 true claims/1000 evaluations permanently suppressed (`eval` 3.62%, `production`
  4.02% — checked that repeated test runs aren't inflating this; they aren't).

**Result.** Keep `subject_entity` unchanged. No coreference project — deferred because no affordable
fix exists (4 tested, 4 refuted), not because the cost is low. `sameEntity` is literal proper-noun
overlap, not entity resolution; documented at the function and gate call site. Reopen if: suppression
materially raises detection loss, the gate shows up in a meaningful share of user-visible wrong
verdicts, the failure shape spreads past 2 domains, or a bounded coreference mechanism is demonstrated
sufficient. Keep per-firing recovery outcome + suppression-rate/1000 telemetry going forward.

**Addendum (2026-08-30, spec 013 T24 B0–B2, zero API cost).** Re-measured the false-trigger rate
directly, on a fresh 40-row sample (18 distinct claim/evidence templates) from the same 2 claim
families this section already names (Apple financials, Wright-brothers flights) plus one new one
(Grace Hopper/COBOL). **B0 finding first: `grounnel_claims.evidence` is nulled by design on every
`subject_entity` firing** ([pipeline-gate-chain.ts:143](../../src/orchestrators/grounnel/pipeline-gate-chain.ts#L143),
`if (gate3.overridden) evidence = null`), so the stored column cannot be hand-labeled directly —
0/310 single-pass firings retain evidence in `grounnel_claims`. Reconstructed the actual VERIFY input
instead from `grounnel_rerank_decisions` (`selected=true`) ⋈ `grounnel_search_pages.excerpt` — same
zero-cost persisted-telemetry replay technique this ADR already uses elsewhere.

Result: **75% false-trigger rate among firings (30/40 raw sample), 78% by distinct template
(14/18)** — evidence genuinely confirmed the claim but was suppressed on naming form alone (e.g.
"Wright brothers' fourth flight" vs. evidence's "Wilbur," "JWST" vs. "James Webb Space Telescope"
spelled out). This is measured the same way as this section's own 51% aggregate-recovery figure
(same concept: among firings, would a correct fix restore the true verdict) and is **notably higher**
— but drawn from a smaller, single-article sample concentrated in the same 2–3 families already
named above as the gate's known weak spot, not a contradiction of the 51%/159-firing measurement.
17.5% (7/40) were correct suppressions of a genuinely false claim (evidence about a different specific
instance — e.g. "the first flight covered 852 feet" when the true 852ft flight was the fourth); 7.5%
(3/40) were ambiguous (evidence didn't address the claim's subject at all, e.g. a negative claim about
Microsoft with no Microsoft mention in the retrieved passage).

**Not a re-decision.** The four fix candidates already simulated and refuted (A/B/B-tight/C) are
unaffected by this number — a higher false-trigger rate doesn't make a bad fix good. What it does
argue: **R2's "keep unchanged, revisit only if triggered" reopening conditions may already be met** —
"the gate shows up in a meaningful share of user-visible wrong verdicts" is now measured at ~75–78%
of its own firings, materially above what this section's original cost estimate implied when R2 was
decided. Whether that crosses the bar to justify revisiting R2's disposition is a product call, left
open here — this addendum reports the number, it does not reopen the fix search.

**Addendum 2 (2026-08-30, R2 reopened as an investigation, zero API cost throughout) — mechanism
decomposition, and a 5th and 6th fix candidate simulated and refuted.**

**Root cause found.** `applySubjectEntityGate`'s `evidence` argument
([pipeline.service.ts:836](../../src/orchestrators/grounnel/pipeline.service.ts#L836), `evidence:
result.evidence`) is not the full retrieved passage — it is VERIFY's own **narrowly cited
sentence(s)**, resolved via `resolveEvidenceFromCitations`
([passage-sentences.ts:129](../../src/orchestrators/grounnel/passage-sentences.ts#L129)). The gate
was never comparing "is this evidence about the claim's subject" — it was comparing "does the one
sentence VERIFY happened to cite repeat the same literal proper noun as the claim."

**Simulation 1 — widen the comparison to the full passage.** Replayed `sameEntity` (verbatim) against
the full selected-passage text (`grounnel_rerank_decisions.selected=true` ⋈
`grounnel_search_pages.excerpt`) instead of the narrow cited sentence, across all **310** distinct
firings (corrected denominator — an earlier per-template count in this investigation double-counted
multi-pass claims via a join-multiplicity artifact, same class of bug as the one B0 already caught;
`count(DISTINCT claim_id)` is the number to use). **306/310 (98.7%) would never have fired.** This
confirms the dominant mechanism is the citation window, not entity identity — "Wright brothers" vs.
"Wilbur" looked like a semantic-alias problem (M1) only because the word "Wright" *is* present
elsewhere in the same passage (e.g. "Wright Flyer"), just not in VERIFY's cited sentence. True M1
(zero overlap even against the full passage) is **~1%** of firings, not the dominant case originally
assumed.

**But naive widening is unsafe** — checked directly: `sameEntity("The first flight lasted 59
seconds.", fullPassage)` returns `true`, because the same article that correctly reports the *fourth*
flight's 59 seconds also names "Wright"/"NASA"/other tokens the claim shares — even though the claim
itself is false (conflates first with fourth). Naive widening would recover the false triggers and
erase the genuine wrong-instance catches together — the same failure shape as the already-refuted
Option A (94% suppressed), arrived at via a different mechanism (window size instead of citation
presence).

**Simulation 2 — 5th candidate: widen + reuse `instance-selector.ts` (D030 §3f) for instance
agreement.** Design: accept only if (a) the full passage shares a proper noun with the claim, AND
(b) when the claim names a sequence-selector ("first flight"), the full passage does not name a
*conflicting* selector+anchor ("fourth flight") via the existing `extractInstanceSelector`/
`anchorWords` machinery. **Refuted.** Recovery dropped to 84/310 (27.1%) — worse than doing nothing —
and it fails on the flagship true-positive case: "the fourth and final flight... covered 852 feet"
(correctly attributed, true claim) was wrongly overridden **40/41 times**. Cause: `anchorWords`'
±2-word window was designed for a **local, clause-scoped** comparison (VERIFY's own short reason
text, or one sentence); scanned against a full multi-paragraph article, it finds "first" and "fourth"
both sitting near the generic anchor "flight" throughout the SAME article narrating all four real
flights in sequence — a co-occurrence that looks identical whether the specific fact cited is correct
or not. A window calibrated for one scope silently breaks at a larger one — the same trap this file's
earlier fixes kept hitting, via a new door.

**Tally: 5 of 5 fix candidates for `subject_entity` (this ADR + this addendum) are refuted by
simulation before reaching code.** A+B+B-tight+C (original 4) plus widen+instance-selector (5th).
One untested direction remains, noted but not attempted: scoping the instance-agreement check to only
the specific sentence(s) sharing the claim's own numbers/dates, rather than the whole article or a
single arbitrary cited sentence. Left for whoever picks this up next — this ADR's own "simulate
before implementing" discipline (§3n) has now caught five consecutive bad designs at zero cost,
which is itself evidence the discipline is doing its job, not that a sixth attempt is owed.

**Disposition: unchanged.** Keep `subject_entity` as-is. The investigation sharpened *why* no fix has
worked (citation-window scope mismatch, not entity resolution difficulty) without producing one that
survives simulation. Reopen per the original conditions above; this addendum is evidence gathered
against those conditions, not a decision to act on them.

### Addendum 3 (2026-08-31) — firing-set census, and what today's re-run does and does not show

Prompted by two independent reviews of the §12/T24–T26 findings, both of which flagged that this
file now carries **four different firing counts** (132, 159, 310, and a reviewer's restatement of
310) with no stated query definition — a discrepancy too large to carry into the next decision.
Settled by direct census before any further planning.

**The counts are the same query at different times, plus one different scope.** For
`gate = 'subject_entity' AND overridden = true`, as of 2026-08-31:

| Definition | Count | Notes |
| --- | --- | --- |
| Total gate-event rows | **664** | Every firing including retry re-fires |
| `count(DISTINCT claim_id)` | **314** | The denominator §3m Addendum 2 uses; was 310 the previous day |
| `count(DISTINCT (run_id, claim_id))` | **314** | Identical — `claim_id` is already unique per run, so there is no cross-run dedup ambiguity |
| …of which `source = 'eval'` | **253** | |
| …of which `source = 'production'` | **61** | |

So: **310 was `count(DISTINCT claim_id)` measured on 2026-08-30; 314 is the same query today.**
**132 is that same query measured earlier in this ADR's history**, when less history had accumulated.
**159 is a different scope** — §3m's "full population, not just `g22`". None of these contradict each
other; the number simply grows with traffic. **Whoever cites a firing count must state the query and
the date, because the bare number is not stable.**

The +4 delta is *not* cleanly attributable to today's run, and the temptation to say so is worth
recording as a caution. Runs that fired this gate since 2026-08-30: `a2d4e3b2` (4 claims, the §12
re-eval), then three `eval` runs `fbda419f`/`8728f995`/`41012f9a` (1+2+1 = 4 claims) later the same
afternoon, then `55e13495` (4 claims, today). Whether the 310 census predated or postdated those
three eval runs is not recorded, so the composition of 310 → 314 is ambiguous. **Any future census
must be logged with its timestamp**, or this same ambiguity recurs at the next re-measurement.

**Two things this census changes:**

1. **664 events over 314 distinct claims = 2.1 firings per claim.** The gate re-fires on retry
   passes. Confirmed end-to-end in today's run: `subject_entity` fired on **4 distinct claims but
   only 2 ended `unverifiable`** — retry recovered the other two by re-running VERIFY, which cited
   different sentences the second time. **The gate's firing count overstates user-visible damage by
   roughly 2×, and a fix that reduces firings should also cut retry volume** — a cost effect, not
   only an accuracy one. Track firings and final suppressions as separate series when this section's
   cost estimate is next re-priced.
2. **The corpus is 81% `eval`, not production traffic** (253/314). The 98.7% widening result and the
   40/41 flagship refutation both rest on a golden-set-dominated population. That does not invalidate
   them — the mechanism is the same — but any *rate* quoted from this corpus is a rate over eval
   runs, and should be labelled as such rather than presented as a production rate.

**The gate is deterministic; its input moves.** Direct evidence, same article, two consecutive days:
`"Germany surrendered in 1945."` fired 3× and ended `unverifiable` on 2026-08-30 (`a2d4e3b2`), and
did not fire at all on 2026-08-31 (`55e13495`). Same gate code, same claim text, same article. The
difference is entirely what VERIFY cited — today's stored evidence reads *"…On this Day 7 May 1945:
Germany signs unconditional surrender"* (contains "Germany", `sameEntity` passes); the prior day's
evidence was nulled by the gate itself
([pipeline-gate-chain.ts:143](../../src/orchestrators/grounnel/pipeline-gate-chain.ts#L143)). The same
pattern holds for the Wright pair in reverse (`"really did fly 852 feet"` survived on the 30th,
suppressed on the 31st). **Run-to-run verdict flips on these claims are VERIFY citation-choice
jitter, not gate nondeterminism.** This is the strongest available argument against a sixth
gate-window patch: the variable that actually moves lives upstream, in which sentences VERIFY selects.

**Correction to Addendum 2's framing.** Addendum 2 describes the gate's input as VERIFY's "narrowly
cited sentence(s)". Inspection of stored evidence shows it is already a **multi-sentence
concatenation** (joined by `...`) that can still omit the subject — e.g. today's
`"The Wright brothers' first flight covered approximately 120 feet."` cited three sentences naming
Orville, the Wright Flyer, and a Boeing 747. The defect is therefore **not** "the window is one
sentence"; it is "VERIFY selects fact-bearing sentences without ensuring one of them names the
subject." Any prompt aimed at this must instruct VERIFY to *add* a subject-naming sentence when it
has cited a fact-only sentence — not merely to "cite more", which would lengthen the same
subject-less bundle.

**What remains hypothesis, explicitly.** That M2 dominates firings is measured (98.7%, §3m Addendum
2). That citation scope causes it is well-evidenced. That **a prompt can reliably make VERIFY cite
subject-bearing context is neither measured nor demonstrated** — and this ADR's own record (five
refuted candidates, and T22's field-order change failing live 2/2 after looking correct offline) is
the reason to state that separation rather than assume it. The falsifiable form is: *if VERIFY
consistently cites sufficient subject-bearing context, the existing gate should stop producing M2
false suppressions without weakening the gate.* Testing that requires two steps in order (T28), and
the second must not begin before the first returns.

**Disposition still unchanged.** No gate code change. No sixth lexical patch, no full-passage widen,
no instance-selector at article scope, no threshold retune.

### Addendum 4 (2026-08-31) — T28 Step 1 ran; citation-completeness is refuted, and the gate has no proven catch

The falsifiable hypothesis stated in Addendum 3 was tested offline at zero API cost
(`scripts/t28-passage-inventory.ts`). **Subject present in the full selected passage: 188/191
(98.4%)** across 320 distinct firings — an independent confirmation of Addendum 2's 98.7%, via a
different query. On that number alone the prompt direction was available.

**It is refuted by what the matching text actually is.** Addendum 3 warned that
`passage.includes(name)` is the same unsound identity test the gate itself uses, and required
hand-inspection before concluding. Doing so:

- *"Microsoft did not create the iPhone"* — the sole occurrence of "Microsoft" in the selected
  passage is a scraped **date-picker widget**: `JAN 09 JAN 09 Choose another date OK January 31 1 2 3
  4 5 … Microsoft Apps on iOS`.
- *"The Wright brothers made four flights on December 17, 1903"* — matches a **navigation header
  repeated twice**, not prose.

A prompt instructing VERIFY to add a subject-naming sentence would therefore instruct it to cite
boilerplate. **The 98.4% counts the token, not usable text.** Step 2 was not run; this is the **6th
refuted direction** for `subject_entity`.

**Second, larger finding: true M1 is 0, not ~1%.** All three "no overlap even against the full
passage" cases turn out to be `properNounWords` false positives on sentence-initial common nouns —
`Researchers`, `One` (from *"One product line revenue was later restated…"*), and `Terminators` (an
astronomy term). **Across 320 recorded firings this gate has zero confirmed genuine
entity-mismatch catches**, against the ~75% false-trigger rate measured in §3m Addendum 2. The
justification retained on cost grounds in §3m therefore now has no demonstrated instance behind it.
That is a materially different position from "rare but real", and whoever next re-prices this gate
should start there rather than from the original estimate.

**Spun out, not fixed here:** `PROPER_NOUN_RE` (`/\b[A-Z][a-zA-Z'-]+\b/g`) plus a ~15-word
`SENTENCE_START_STOPWORDS` list accepts any capitalised word as a name. `sameEntity` is shared by
`applySubjectEntityGate` **and** `applyYearGate`, so this corrupts both — filed as spec 013 T30, and
worth doing before any further work on this gate, since it is free to verify and changes the
denominator of every measurement above.

### Addendum 5 (2026-08-31) — T30: the extractor fix is the same treadmill; the real question is whether this gate should exist

Two extractor candidates were simulated offline against 191 scorable firings
(`scripts/t30-simulate-extractors.ts`, zero API cost). Both refuted; no code shipped.

| Candidate | Abstains on | Why refuted |
| --- | --- | --- |
| A — sentence-initial capital counts only if it recurs mid-sentence | 114 (59.7%) | The gate's anchor is `subjectEntity`, a bare FRAGMENT ("Marwick"), not prose — every token is sentence-initial, so real names are dropped. Caught by two pre-existing g17 tests |
| B — drop a capital that also appears lowercase in claim+evidence | 92 (48.2%) | Correctly drops `Strawberries`/`Services`, but also drops **`Apple`** and **`Wright`** because "apple" (the fruit) and "wright" occur lowercase in the passage. A spelling coincidence, not an identity test |

**A safety note that generalises beyond T30.** `sameEntity` is consumed in **opposite senses** by its
two callers: `applySubjectEntityGate` suppresses when it returns false, while `applyYearGate`
*proceeds to force `contradicted`* when it returns true. Any change that yields fewer names therefore
makes the first safer and the second **less** safe — a blanket edit to the shared helper weakens the
year gate's cross-entity guard in the one Cardinal-Rule-unsafe direction. Future work here must be
opt-in per call site. This was not obvious from either gate's own code and is easy to miss.

**What the simulation actually shows.** Both candidates "succeed" only by making the gate abstain on
50–60% of its own firings. Set against Addendum 4's finding of **zero confirmed genuine catches
across 320 firings** and §3m Addendum 2's ~75% false-trigger rate, an extractor fix is not a fix — it
is a partial, unprincipled disabling of a gate with no demonstrated benefit. **Candidate 7 refuted.**

**Recommendation, escalated rather than actioned.** The justification for retaining `subject_entity`
(§3m: rare but real M1 catches, kept on cost grounds) no longer has a single confirmed instance
behind it. The honest options are to **disable the gate outright** — a one-line change whose effect
is measurable and whose direction is safe — or to leave it exactly as-is and stop spending on it.
Writing an eighth lexical heuristic is neither. This is a product decision and is left open.

### Addendum 6 (2026-08-31) — DECISION: `subject_entity` is disabled — SUPERSEDED by Addendum 7 (2026-09-03)

**§3m's retention decision is withdrawn.** It was made when M1 was believed rare-but-real; T28 Step 1
measured **0 confirmed M1 across 320 firings**, and the three apparent exceptions were
`properNounWords` false positives on sentence-initial common nouns. Paying ~25–30 suppressed true
claims per 1000 for an unobserved class is a tax on a hypothesis, not a cost trade.

| Evidence | Value |
| --- | --- |
| Confirmed genuine catches | **0 / 320 firings** |
| False-trigger rate among firings | ~75% (T24) |
| Mechanism | ~99% M2 (citation window), ~1% M1 — and that 1% is extractor noise |
| Fix candidates refuted | **7** (4 coreference variants, widen+instance-selector, VERIFY citation-completeness, extractor A/B) |
| Firings per claim | 2.1 — retry re-runs the gate and recovers about half |

**What was changed:** the call site in
[pipeline-gate-chain.ts](../../src/orchestrators/grounnel/pipeline-gate-chain.ts) is skipped. Nothing
was deleted — `applySubjectEntityGate`, `sameEntity`, every unit test, and the `"subject_entity"`
value in all four persistence gate-name unions remain, so the historical corpus stays queryable and
re-enabling means restoring the five-line call site plus its import — `git revert` of this commit.

**What was deliberately NOT changed: `sameEntity` and `properNounWords`.** The helper is consumed in
**opposite senses** — `applySubjectEntityGate` suppresses when it returns false, while `applyYearGate`
*proceeds to force `contradicted`* when it returns true. "Improving" the shared extractor to help the
disabled gate would weaken the year gate's cross-entity guard in the one Cardinal-Rule-unsafe
direction. T30 stays open and untouched; any future work there must be opt-in per call site.

**Safety claim, stated precisely.** This gate only ever downgrades `supported`/`partially_supported`
→ `unverifiable`, so removing it **cannot directly manufacture a false contradiction**. It can,
however, change what reaches retry and escalation, and those paths *can* emit `contradicted`. Final
verdict behaviour therefore still requires regression verification — which is why the pre-registered
check below is about new accusations, not about the gate's own output.

**Pre-registered verification** (one 44-claim article run, N=1):

| Check | Bar |
| --- | --- |
| `subject_entity` gate events | **0** — deterministic, one run proves it |
| Labelled-true claims gaining `contradicted` | **0** — any instance reverts immediately |
| The three Wright claims | expected to return to `supported` |
| Suppression-count delta | **observed only, not pass/fail** — citation jitter flips these run to run |

**Side effect to watch, not recorded before now:** T6b'''s distinguishing suffix — *"Evidence was
found but could not be confirmed as being about this claim'''s specific subject"* — can no longer
appear, because `composeUserFacingReason`'''s `subject_entity` branch is now unreachable. That is
correct (the condition it labels cannot occur), but it is a visible user-facing copy change: such
claims now take the ungrounded-affirmative rewrite path instead.

**Reversal condition:** a confirmed genuine M1 (evidence about a demonstrably different entity
affirming a claim) appearing in production. `git revert` this commit; the gate function, its tests,
and the persistence enum value are all still present.

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
- (§3f) New `src/lib/instance-selector.ts` — pure sequence-selector/anchor extraction, no LLM cost,
  reusing `applyReasonOrdinalGate`'s anchor-window machinery moved out of `gates.ts` so both sides
  share one definition. Consumed by `passage-filter.ts` (`isPassageRelevant` admission) and
  `pipeline.service.ts`'s rerank ranking, as an additive OR-condition alongside existing key-term
  matching — `lib/claim-terms.ts`'s `extractKeyTerms` output is explicitly unchanged (shared by
  `reason_year`, `claim_reason_overlap`, and Case-A gate; widening it would be collateral, not
  targeted). `gates.ts`/`applyReasonOrdinalGate` untouched.
- (§3f) Golden-set/test-matrix additions for selector-aware retrieval (sequence selectors that must
  now surface counter-evidence; ranking descriptors like "longest" that deliberately must not; a
  calendar-period false-positive check, "the first quarter of 2024") — separate from §3a's own
  ordinal-gate matrix, which stays as-is.

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

---

## §4 Addendum — VERIFY's two known failure modes, and why neither is being fixed (2026-09-02)

Spec 014's investigation closed with two reproducible defects, five refuted fix candidates, and a
decision to stop. This records the holes so they are not rediscovered, and the fix that is designed
but deliberately unshipped.

### Hole 1 — multi-source aggregation manufactures a contradiction

Claim: *"The Pentagon has not issued an official finding on the Minab strike."* (true)

| Bundle | Verdict |
|---|---|
| source A alone ("remains under review") | `supported` |
| source B alone (Senate release, same shape) | `partially_supported` |
| source C alone ("the incident is under investigation") | `unsupported` |
| **A + B + C** | **`contradicted` 3/3** |
| A + B + C + off-topic distractors | `contradicted` 3/3 |

**Every source is labelled correctly alone.** The contradiction exists only in the combination, and
C's own reason inverts: neutral in isolation, *"which contradicts the claim"* alongside A and B.
Adding *supporting* evidence flipped the verdict against the claim. Frozen as golden case
`g30-pentagon-no-finding-aggregation`.

### Hole 2 — a reporting claim is answered on the object-fact

Claim: *"Social media posts **claimed** the University of Rochester announced it will cut academic
ties with Israel."* (true — a claim about what posts said)

Sources A and B each return `contradicted` **alone**, citing *"administrators in fact made no
commitment…"*. Isolation therefore does not help. Under an experimental schema forcing the model to
name the predicate before the verdict, `assertedPredicate` is **correct and identical** on all three
sources — the divergence is entirely in which sentence gets selected. **VERIFY names the right
predicate and then labels against a sentence that does not address it.** Frozen as
`g31-reporting-claim-object-fact`.

### Hole 3 — wrong entity sharing a proper-noun token

`alishabakitchen.com` accepted as evidence about a person named Alishba. `sameEntity` compares
proper-noun tokens and they share one. Refuted work (spec 013 T30); `subject_entity` stays disabled. **[Superseded by Addendum 7 — re-enabled 2026-09-03.]**

### The designed, measured, UNSHIPPED fix for Hole 1

Second-stage isolation, gated hard:

1. Run VERIFY normally, batched.
2. If the verdict is not `contradicted`, stop.
3. If the claim carries no negation cue, stop.
4. Otherwise verify each pooled source separately and apply the **unlock merge**: if **no** isolated
   source is `contradicted`, release to the strongest non-accusation those sources already gave; if
   **any** isolated source is `contradicted`, keep the bundle verdict unchanged.

**The merge is downgrade-only by construction — it can release a false accusation but never create
one.** That property is the whole safety argument, and it was arrived at by discarding an earlier
"any `contradicted` wins" rule which two independent reviews correctly identified as unsafe: on
Hole 2 both isolated sources return `contradicted`, so that rule would have *ratified* a false
accusation instead of fixing one.

Scored on collected data at zero API cost: Hole 1 goes `contradicted` → `supported` (fixed);
Hole 2 is correctly skipped at step 3 and left unchanged.

**Cost, measured against production history:** 10 of 1,032 `contradicted` claims carry a negation
cue — **1.0% of contradicted, 0.122% of all claims**, or roughly **30 extra VERIFY calls across the
project's entire history**.

**Why it is not shipped.** The cost is negligible and the fix is correct, but it is still a second
VERIFY stage — new architecture for a defect measured at ~10 rows in 8,106 claims, in a week that
already shipped two deterministic gates (G1, G2). It is one commit away and fully specified above.
**Reopening trigger:** the `contradicted` ∩ negation-cue rate rising materially above 1.0% of
contradicted, or a user-reported false accusation of this shape.

### Refuted this cycle — do not re-propose without new evidence

| Candidate | Why it died |
|---|---|
| US1 — escalation may retract a contradiction | would release ~38 correct contradictions to free 1 false one |
| E1 — collapse duplicate claims | 2 exact duplicates in 8,106; looser predicates ~93% false-positive |
| E2 — caption/bio detector | 12 rows corpus-wide, 7 already excluded by eligibility; real population 2 |
| G1 span-level | no threshold band; cannot separate "source copies input" from "input quotes source" |
| VERIFY Blocks A and B | control failed the same screen; Block A targets a polarity error that does not exist |
| `reason-first` schema | moved zero rows |
| `predicate-first` schema | **raised false accusations 25%** (12→15 cells) while aggregate accuracy improved |

**Method note worth keeping: judge on false-accusation count, not aggregate accuracy.**
`predicate-first` passed a 4-row screen and looked like a strict improvement; on the full 19-fixture
set it was a Cardinal Rule regression. A narrow screen is not evidence of safety.


---

### Addendum 7 (2026-09-03) — Addendum 6 is REVERTED: the gate's value was its side effect

**Addendum 6's measurements were correct and its conclusion was wrong.** It judged the gate on the
verdict the gate itself writes. That verdict *is* worthless — `supported → unverifiable`, wrong ~75%
of the time, 0 confirmed catches in 320 firings. But the downgrade also nulls `evidence` and leaves
the claim unresolved, and *that* is what drove the escalation tiers into a second retrieval pass.
The second pass is where the right answer came from. Disabling the gate removed the second pass.

**How this was found.** g17 was the only golden case to regress after 08-31. `scripts/eval-drift.ts`
diffs one case across two dates over everything the `grounnel_*` tables record; for g17's
`"first flight covered 852 feet"` claim, 2026-08-28 → 2026-09-03:

| Signal | 08-28 | 09-03 |
| --- | --- | --- |
| `subject_entity` overrides | 36/164 (22%) | gate absent |
| `retry_decision` fired | 14/34 (41%) | 0 |
| `retry_reconciliation` fired | 11/12 (92%) | 0 |
| `consistency_check` / `consistency_retry` calls | 12 / 11 | 0 / 0 |
| sources reaching VERIFY, per run | 5.88 | 2.33 |
| verdict | contradicted 15, supported 1, unverifiable 2 | **supported 3/3** |

Within 08-27/08-28 alone, runs where the gate overrode averaged **7.75** selected sources against
**3.36** where it did not — the escalation is caused by the downgrade, not correlated with it.

**The suite-wide control.** Across the 8 cases with scoreable `false` claims on both dates, g17 is
the only one the gate fired on at any meaningful rate (22%; next highest 3%), the only one that lost
evidence volume (16.2 → 11.3 per run), and the only one whose detection rate fell (0.83 → 0.00).
Every other case held or improved. One-for-one, so this is not a general loss of the retry path.

**What was changed:** the call site is restored at its original position — after `year`, *before*
the spec-015 G2 affirmation floor. Placing it after G2 was tried first and is wrong: G2 demotes
`supported`/`partially_supported` to `unsupported` and nulls evidence whenever the evidence is not
verbatim in the passage, and `applySubjectEntityGate` only acts on `supported`/`partially_supported`
with non-null evidence — so downstream of G2 it never sees hallucinated-evidence-about-another-entity,
the class it exists to catch, and the surviving population is exactly the well-grounded one where its
false-trigger rate is worst. Before G2 the ordering is safe in both directions: `subject_entity` only
downgrades (to `unverifiable`), on which G2 is a no-op, so G2 remains genuinely last and a real floor.

**What this does NOT claim.** The gate is still wrong ~75% of the time on its own verdict, and this
revert re-imposes Addendum 6's measured cost: ~25–30 suppressed true claims per 1000. It buys back
g17's detection with a mechanism nobody designed. **The correct fix is to trigger the retry on thin
evidence directly** — if an affirmative verdict rests on fewer than N sources, escalate — and then
disable `subject_entity` again on its own merits. This revert is a stopgap that should not outlive
that work.

**Precisely which second pass.** Not the D025 §2 retry — `applySubjectEntityGate` pushes no
diagnostic, so `needsRetry` stays false. It is D026 §13 escalation: `findUnresolvedClaims`
([pipeline.service.ts](../../src/orchestrators/grounnel/pipeline.service.ts)) admits
`unsupported | unverifiable | contradicted | partially_supported` and excludes only `supported`, so
the downgrade moves the claim across that one boundary and `escalateUnresolved` re-retrieves at
`ESCALATION_TIERS = [5, 8]`. That filter is the actual load-bearing line and now carries a comment
saying so.

**Known costs this revert re-imposes, measured on the days the gate was live (08-27/08-28):**

| Cost | Measured |
| --- | --- |
| `kind:"true"` golden claims scored incorrect | 7% (08-27), 5% (08-28), vs **0%** with the gate off |
| `supported → unverifiable` overrides | 183 across the two days; ~93% recovered before scoring |
| Escalation vetoes a better tier result | nulled evidence ⇒ `citations = []` ⇒ `rejectReplacement` keeps the weaker prior **and** `protectedContradictionClaimIds` excludes the claim from the next tier |
| Public `grounded_pct` | falsely-downgraded claims move from `grounded_n` to `unclear_n`, lowering the headline score for identical input |
| Escalation budget | non-productive tiers for pronoun-referent evidence: the gate is a pure function of `(claimText, subjectEntity, evidence)`, so a wider pool that yields the same best sentence re-fires it identically |

**Reopening trigger:** once an explicit thin-evidence retry trigger ships, re-run
`scripts/eval-drift.ts` on g17 with the gate off. If detection holds without it, disable the gate
permanently and delete this addendum's stopgap.

**Method note.** Addendum 6 measured the gate in isolation and never asked what else consumed its
output. A gate is not only its verdict; it is also every downstream trigger that reads the state it
leaves behind. Measure the removal, not just the component.

---

### Addendum 8 (2026-09-03) — Addendum 7 refuted by live run; §3f's retrieval diagnosis is now false

**Addendum 7's revert is reverted.** A full golden run at `repeats 2` (672 calls, 28/28 cases, 0
vacuous) with `subject_entity` live: **g17 detection 0.00, unchanged.** The gate is back off.

Every step of Addendum 7's mechanism fired exactly as predicted — and the outcome was still wrong:

| Predicted step | Observed |
| --- | --- |
| gate downgrades `supported` | 11/13 overrides, `supported → unverifiable` |
| downgrade triggers escalation | sources/run 2.33 → **6.75** |
| escalation re-verifies | `consistency_check` 3, `consistency_retry` 3, `instance_attribution` 5 |
| second pass yields `contradicted` | **never** — `escalation_replacement` went `unverifiable → unverifiable` ×5, `→ supported` ×1 |

**The flaw is structural and should have been caught by reading the gate.** `applySubjectEntityGate`
only ever writes `unverifiable`. Detection requires `contradicted`. The gate cannot raise detection
by construction, whatever it does to retrieval volume. The disconfirming evidence was already in
Addendum 7's own data: on 08-27/28, runs *with* an override reached `contradicted` 8/12 (0.67) vs
10/13 (0.77) without — the gate co-occurred with **worse** detection, and that was explained away as
confounding rather than treated as the refutation it was.

**Cost of the experiment:** 1 true claim in 40 (g22), not the 3–7% feared. 0 false accusations.
27/28 cases green. g24 passed at N=2 — noise, not a fix.

**§3f is now factually wrong, and this is the finding worth keeping.** §3f (2026-08-22) concluded
"root cause is retrieval, not the ordinal gate — even a perfect `longest ≠ first` detector would
still need the refuting sentence to reach VERIFY first, which it currently cannot." `input_payload`
(spec 014 T021) makes that testable for the first time, and it is false. In today's run the refuting
sentence reached VERIFY in **every** payload for the claim, verbatim:

> "At noon on December 17, 1903, Wilbur piloted the **fourth and longest** flight of the day,
> covering 852 feet in 59 seconds."
> "The **fourth and last** flight, by Wilbur, took 59 seconds to cover 852 feet (260 m)."

VERIFY read those and returned `supported` for "The first flight covered 852 feet", in all 18 calls.
**Retrieval is solved. The defect is VERIFY's reading of evidence it was given.**

**What this changes about §3e.** §3e's rejection of superlatives stands and is not reopened — but it
is now also *unnecessary* for g17. The evidence sentences say **"fourth"**, a plain ordinal already
in `ORDINAL_WORDS`. No vocabulary widening is required. What is missing is that
`applyReasonOrdinalGate` compares the claim's ordinal against VERIFY's **reason** — free prose the
model authors, and which §3f already observed often omits any selector word. It never compares
against the **cited evidence sentence**, which is retrieved text and contains the plain ordinal.

**Proposed next step (NOT implemented, needs the adversarial validation `d6e9738` skipped):** an
evidence-side ordinal check — claim ordinal vs. ordinal in the cited sentence, same anchor-overlap
and negation machinery `applyReasonOrdinalGate` already uses, no new vocabulary. Note §3d makes this
gate's contradictions immune to reconciliation, so a false positive here has no safety net; validate
on the frozen corpus before wiring, and prefer withholding `supported` over asserting `contradicted`.

---

### Addendum 9 (2026-09-03) — the detection gate fails on significance, not on a raw threshold

**The suite was reporting noise as regression.** `g17` measures 28/44 = 0.64 detection and `g24`
21/32 = 0.66, against a 0.80 floor. A 0.64 process trips a raw 0.80 threshold ~60% of the time at
N=5, and *more* often as N grows: P(pass) is 40% at N=5 and 10% at N=20. A gate that gets less
likely to pass the more evidence you give it is not measuring the pipeline.

**Proof there was no regression behind the red**, three independent ways:

1. 2026-09-01, one binary (`57e9e78`), no deploy between: 16:27 GREEN (28 runs, repeats 1) →
   17:23 GREEN (28 runs, repeats 1) → 19:12 RED (56 runs, repeats 2). Only N changed.
2. Re-enabling `subject_entity` (672 calls, Addendum 8) moved g17 detection 0.00 → 0.00.
3. Per-case before/after across the 09-02 batch: no case significantly worse (g17 z = −1.67,
   g24 z = −0.81). Three cases crossed |z| > 1.96; none survive Bonferroni across 28 tests.

**The rule.** The floor stays 0.80. Detection fails only when the observation is statistically
incompatible with being *at* the floor: one-sided exact binomial, `P(X ≤ k | n, floor) < 0.05`, and
only when `n ≥ MIN_VERDICT_REPETITIONS = 5`. Below that the test has no power, so it is skipped
rather than run and ignored. Simulated over all eval history: **binding reds 23 → 5**, every one of
the 18 removed is small-N noise, every real collapse (0/5, 4/14, 4/15) still red.

Same rate, different N — the behaviour to preserve:

| observation | p | verdict |
| --- | --- | --- |
| 08-26 g17 2/5 = 0.40 | 0.058 | green — cannot distinguish from 0.80 |
| 09-03 g17 4/10 = 0.40 | 0.006 | RED — now it can |

**Gated per false claim, not on the summed rate.** Summing hides one claim at 0/5 behind two at 5/5,
and separate claims do not share a rate. No golden case has more than one `false` claim today, so
this is currently a no-op — it closes the hole before a second one is added.

**Binding-ness is a property of the test that ran, not of the run length.** `verdictIsBinding`
requires `runs.length ≥ 5` **and** no `false` claim observed fewer than 5 times. Without the second
condition a case with 6 repetitions whose claim EXTRACT produced only 3 times reported
`detectionRate: 0` as a *binding pass* — the vacuous-green family §3k exists to stop, reintroduced.

**Failures aggregate per case, never suite-wide.** `bindingPassed` = no false accusation, no case
that both had the observations and failed, no incomplete case. An earlier draft used
`cases.every(c => c.verdictIsBinding)` as a precondition for failing at all, so one infrastructure
casualty disarmed the gate for all 27 other cases.

**Unchanged, deliberately:** `no_false_accusation` is hard at any N; the N=1 `minCorrectRate` path
(a binomial test on n=1 has no power at any alpha, so significance is not the available fix there);
the `matched === 0` vacuous guard; every floor value in the golden set. **No golden-set edit — this
does not make the suite green.** g17 remains red at 4/10, p=0.006, correctly.

**No Bonferroni on the detection gate.** 28 cases at α=0.05 yields ~1 spurious below-floor per full
suite. That is the right trade while the headline that matters is false accusations = 0; correcting
it would make a genuine collapse harder to call, which is the wrong direction for this gate.

**One scorer, not four.** `scripts/eval-last-green.ts` now calls `evaluateGrounnelRun` instead of
reimplementing it, and `scripts/s014-t022-score-golden-run.ts` (a second hand-synced copy, stale
against this rule) is deleted. A hand-synced copy previously reported 2026-08-31 as green when 27 of
28 cases had produced no scoreable claim at all. `scripts/eval-grounnel.ts` now exits on
`bindingPassed`, so the CLI and the Inngest job cannot disagree about what a failure is.

**Detection floors for `g17` and `g24` set to 0.70 (2026-09-03).** With the significance rule in
place the floor no longer has to sit far below the measured rate — the test absorbs the noise, so
the floor can stay near capability and keep its power. Chosen against measured true rates (g17 0.636,
g24 0.656) by the trade that actually matters:

| floor | P(false red) n=10 | P(catching a real collapse to 0.30) n=10 |
| --- | --- | --- |
| 0.80 (was) | 28% | 95% |
| **0.70 (now)** | **11%** | **85%** |
| 0.65 | 3% | 65% |
| 0.60 | 1% | 38% |
| 0.40 | 0% | 15% |

0.40 was the right answer under the old raw-threshold rule and is the wrong one now: it would buy a
few points of quiet at the cost of two thirds of the gate's ability to see a genuine collapse.
0.70 keeps 85% power for a 1-in-9 false red, against 28% before.

**This does NOT make the suite green.** g17 today is 4/10 = 0.40, p=0.047 against the 0.70 floor —
still red, and by a coin's width (alpha is 0.05). Two historical days move to green (08-27, 08-28);
09-03 does not. `minCorrectRate` is unchanged at 1.0 for both cases; only `detectionFloor` moved.
The product target remains 0.80 and is recorded here, not in the pass bar.

**Reopening trigger:** if a genuine decay from 0.80 to ~0.70 is suspected, the alpha and floor are
one-line constants — but check the tracked per-case rates first: they are reported with their N on
every run precisely so a downward trend is visible before the gate fires.

---

### Addendum 10 (2026-09-04) — `instance_attribution` judged evidence VERIFY never saw, at ~8× the cost

**Symptom.** Gemini prepay credits ran out on 2026-09-04. Prices did not change — same
`gemini-2.5-flash-lite` every week since August. Two multipliers stacked over Sept 1–3: calls/day
1,329 → 2,400 (eight golden-suite passes in three days, 81% of all calls), *and* tokens per call
3,150 → 4,300. This addendum is the second multiplier.

**`verify/instance_attribution` was 3.8% of September calls and 42% of all tokens.**

| | value |
| --- | --- |
| calls (September) | 250 |
| avg input | **63,915 tokens** |
| max input | **808,498 tokens** (one call) |
| min input | 1,334 tokens |

On the same 125 runs, reading the *same* passages: `verify/primary` averaged **8,545** input tokens,
`instance_attribution` **69,051** — **8.1×**. One production run makes it concrete: an ordinary
article, 36 claims, largest page 14,612 chars; its 9 VERIFY calls cost 93,375 tokens and every other
call together ~215,000 — and one attribution call cost **808,498**, roughly 4× the whole rest of the run.

**Cause.** `callVerify` runs its passages through `buildPassageSentencesMulti` (`MAX_SENTENCES = 20`,
claim-relevant selection). The attribution call site passed `p.text!` — raw full page text — for
every candidate in the batch, `JSON.stringify`'d into one prompt. Claims from one article share
sources, so the same page was serialised once per claim. `claimId` is only set when
`items.length === 1`, which is why the giant calls carry `claim_id = NULL`: null marks the batched,
expensive ones.

**The real defect is not cost.** Attribution could see evidence VERIFY was never shown and then force
`contradicted` over a verdict formed without that text. A gate that overrides a verdict must judge
the evidence the verdict was formed on.

**Fix.** Build attribution's passages with `buildPassageSentencesMulti` and flatten each source to a
string, keeping the `passages: string[]` contract v2.0.0 requires (its citation check compares
against `passages.join("\n\n")`; passing `Record<label, PassageSentence[]>` would break the prompt).
The function is **pure** and both call sites read `claim.text`/`passages` from the same `byId`
objects, so this is VERIFY's exact slice — not a second, differently-selected 20.

**This is a cost fix with a detection risk, not a free win.** The gate maps
`different → contradicted`, `conflict → unverifiable`, `same`/`absent` → no-op. If the trim drops a
carrying sentence, `different` degrades to `absent` and the gate stops accusing — a missed detection,
never a false accusation, and §3d makes a wrong `contradicted` here unrecoverable, so less text is
the conservative direction. But **g17 is this gate**: 33 of 40 `contradicted` overrides and 15 of 15
`unverifiable` ones in all eval history come from it, against a case already at 0.636 vs a 0.70 floor.

Evidence the risk is small for that case specifically: the `input_payload` captured on 2026-09-03
shows VERIFY's 20-sentence bundle already contains *"Wilbur piloted the fourth and longest flight of
the day, covering 852 feet"* verbatim in **every** payload. The carrying sentence is inside the trim.

**Blast radius:** 193 September answers — `same` 122, `absent` 50, `different` 12, `conflict` 9. Only
**21 of 193 (11%)** move a verdict at all.

**Expected:** attribution drops ~8×, from 42% of tokens to ~5% — **~37% off the total bill**,
production included, independent of eval volume.

**Not verifiable offline:** whether trimming changes an answer. `grounnel_search_pages.excerpt` is
truncated (avg 2,049 chars, max 15,044), so the historical payload cannot be reconstructed.

**Validation when credits return** — g17 at `--repeats 5` (~60 calls), recording three outcomes
separately: unchanged (ideal); `different`/`conflict` → `absent`/`same` (a lost catch, the number
that matters); and `same`/`absent` → `different`/`conflict`, which is **impossible if trimming only
removes text** and therefore indicates an implementation bug. Quote tokens, not call counts.

**Deliberately not in this change:** deduping pages shared across claims in a batch. It is the rest
of the saving and it changes how `passages` key per claim — a separate diff, after this one is
measured. `{ claim, fact: claim }` duplication left alone: noise, not cost, and the schema requires it.

**Do not** reach for `ORDINAL_WORDS` widening or re-enabling `subject_entity` to replace any catch
this loses — both are closed (Addenda 6–8).

### Addendum 11 (2026-09-04) — the trim is EXONERATED: the payload was never the problem

Addendum 10's trim was suspected of costing g17 its catches (the gate fired 0/39 against a 6–17%
historical rate). The controlled experiment (`eval-attribution-trim`, retrieve once, five trims on
the same passages, 3 repeats) **refutes that hypothesis**.

| trim | avg input tokens | verdict-moving | answers |
|---|---|---|---|
| `full` (whole pages) | 14,142 | **0/3** | absent, absent, absent |
| `s20-claim` (shipped) | 1,067 | 0/3 | absent, absent, absent |
| `s20-anyselector` | 1,067 | 0/3 | absent, absent, absent |
| `s40-claim` | 1,067 | 0/3 | absent, absent, absent |
| `s60-claim` | 1,067 | 0/3 | absent, absent, absent |

Three findings, each closing a door:

**1. The refuting evidence is present in the trimmed payload — four times over.** Offline replay of
`buildPassageSentences` on the retrieved Wright_Flyer page (783 sentences → 5 kept) shows all four
`852`-carrying sentences survive the trim, every one attributing 852 feet to the *fourth* flight
("The fourth and last flight, by Wilbur, took 59 seconds to cover 852 feet"). The model reads them
and answers `absent`. **This is a prompt/model failure, not an evidence-availability failure.**

**2. Raising the sentence cap is a no-op.** `s20`/`s40`/`s60` are byte-identical because the cap was
never binding: `ranked` slices `matching` (sentences with `score > 0`), and only 5 sentences score
at all. Anyone proposing "send more sentences" as a fix should be shown this row.

**3. The `anySelectorTrim` hypothesis is dead.** It was built on the theory that the claim-selector
rescue evicts the sentence naming a *different* member. It cannot: those sentences are already kept
on their own key-term score, so the rescue never runs and the variant is identical to `s20-claim`.

**Decision: KEEP the Addendum 10 trim (`2c28cf8`).** It is 13× cheaper than whole pages and loses
nothing measurable — `full` and `s20-claim` produce the same answer on the same passages. The cost
saving stands on its own; the quality objection that motivated this experiment does not survive it.

**Caveat, stated because it bounds the claim:** today's `full` retrieved 14,142 tokens against the
63,915 historical average, so this run does not reproduce the historical `24 different + 9 conflict`
baseline. The experiment proves the *trim* is not the cause.

**What the cause IS — the model's persisted `working` names it.** On all three `full` repeats the
model wrote: *"The passages state that the last flight was 852 feet, not the first … They attribute
852 feet to the longest flight, which was the last flight. Therefore, the attribution is absent."*
It located the fact, identified the member as "the last flight, by Wilbur", and ruled out the
claim's member — which is the prompt's own definition of `different` ("explicitly attributes the
FACT to a different, IDENTIFIED member"). It answered `absent` anyway. **On that evidence, the model
collapsed "not the claim's member" into `absent` rather than `different`.**

**Narrowed 2026-09-04 by the prompt experiment — do not read the above as the general cause.** Four
prompt blocks (control, `different-branch`, `decision-table`, `guarded-different`) all returned
`absent` 0/3 on the target, and the model's `working` shows why: *that* run's retrieval returned
evidence attributing 852 ft only by RANKING — "the record flight", "the longest" — on which `absent`
is the CORRECT answer under the prompt's own superlative rule and D030 §3e. The prompt was behaving
as designed, so the run cannot convict it.

**The variable that actually moved across all three experiments is retrieval.** Whether search
returns a sentence identifying the 852 ft flight by POSITION ("fourth"/"last") or only by RANKING
("longest"/"record") decides the answer before any prompt or trim gets a vote — and it differed run
to run on the same fixture. g17's detection rate is therefore dominated by retrieval variance, not
by the payload or the scaffold.

**Consequence for method:** an experiment that retrieves live cannot isolate a prompt effect here.
`eval-attribution-prompt` now PINS its passages, with the two evidence shapes as separate fixtures
(ordinal-identified = the target; ranking-only = a control where `absent` is right). One earlier
"control failure" (`different-branch` moving `t-genuinely-absent` 3/3) was a bad fixture, not a bad
block: "the first tower" is not a member of a repeated set, so the model's `different` was
defensible. That fixture is replaced.

**Do not** re-litigate this with a bigger cap, a new rescue rule, or whole pages. All three are
measured above.

### Addendum 12 (2026-09-04) — FIXED: `fact` must not contain the member the claim selects

`checkInstanceAttribution` sent `fact: i.claim`. The prompt asks *"which member do the passages
attribute the FACT to"*, so a FACT reading "**the first** flight covered 852 feet" answered that
question itself, and `absent` was literally correct. Four prompt blocks could not fix it because
they all sit downstream of the malformed input. The inline comment ("production has no separate
asserted-value field") documented the bug as a constraint.

**Fix:** `stripInstanceSelector` (same module, same `SELECTOR_RE_G`, gated on
`extractInstanceSelector`) removes the selector word. No selector ⇒ `fact === claim` byte-for-byte,
so the gate can never change a claim it already abstains on. Unit-tested invariant.

| evidence | `fact = claim` (old) | `fact` stripped (new) |
|---|---|---|
| ordinal, FALSE claim | absent 6/6 | **different 3/3** |
| ordinal, TRUE claim | same | same 3/3 |
| ranking-only | absent | absent 3/3 |
| no member named | absent | absent 3/3 |

Both strip forms agree (bare predicate "covered 852 feet" and the shipped "The flight covered 852
feet."), so the result is not an artifact of one phrasing.

**Golden set, N=5, 28/28 cases, scored post-deploy only: FALSE ACCUSATIONS 0, binding failures 0.**
g17 3/5 binding-pass against its 0.70 floor (was 1/5, p=0.031); g24 5/5. Note g24 *does* strip
(selector `first`, anchor `computer mouse`) — it is in scope, not insulated, and it held.

**Method note:** `eval-last-green.ts` aggregates by calendar DAY and reported this run RED — g17 at
N=19, pooling pre-strip runs with post-strip ones. Always window by deploy timestamp when scoring a
run that spans a deploy.

**Do not** revisit the trim (Addendum 11), the sentence cap, `ORDINAL_WORDS` (§3e), or
`subject_entity` (Addenda 6–8) to move this gate. All measured, all refuted.

### Addendum 14 (2026-09-04) — floors set from measurement; g17's minCorrectRate is inert

Post-fix observations (28-case screen + the N=5 pass, strip deployed): only two claims sit below
100%. They need opposite treatment, because the two floors govern different things.

| case | kind | observed | change |
|---|---|---|---|
| g17 | `false` | 4/6 = 0.67 | **none** |
| g22 | `true` | 5/6 = 0.83 | `minCorrectRate` 1.0 → **0.6** |

**g17: nothing to set.** Its only claim is `false`, so `minCorrectRate` never applies — at N=1 a miss
scores 0.00 and fails any positive floor, and at N>1 the floor covers non-`false` claims only. The
field is inert; `detectionFloor` 0.7 is what governs. Lowering that floor would make the gate
*weaker*, not more honest: at N=5 the significance test rejects k≤1 at 0.7 but only k≤0 at 0.6.

**g22: 1.0 was the wrong claim about a stochastic case.** A `true`-claim case at 1.0 is not
rate-shaped, so a screen miss is final and un-escalatable — it would hard-fail the suite on roughly
1 run in 6. At 0.6 it escalates instead and is judged over 5 fresh runs. Floor chosen for noise, not
aspiration: with a true rate near 0.83, a 0.6 floor passes a healthy case 97% of the time, where 0.8
passes only 80% — one red in five runs, all of them wrong.

**Evidence is thin: 6 observations.** These are provisional and should be re-derived once the screen
has accumulated passes; the screen-failure rate per case across runs is the measurement, not any
single pass.

### Addendum 15 (2026-09-04) — detection fails on the plain rate again; Addendum 9 is SUPERSEDED

Addendum 9 replaced `rate < floor` with a one-sided binomial test to stop noise-driven false reds.
It overshot. At N=5 the test can only reject 0/5 and 1/5, so a floor of 0.7 enforced roughly 0.2 —
g17 detected 2/5 (40%) and the suite reported green. A floor that does not mean its own number is
worse than a noisy one.

**Rule now: `rate < detectionFloor`, plainly.** `binomCdf`/`DETECTION_ALPHA` deleted, not left dead.
Variance is absorbed by setting the floor BELOW measured capability, not by weakening the comparison
— the floor is a "broken below this" line, never an aspiration.

Post-fix detection over 12 observations per case, and how often each floor false-reds a healthy case
at N=5:

| case | observed | floor 0.6 | floor 0.7 | decision |
|---|---|---|---|---|
| g03, g04, g05, g09, g12, g14 | 7/7 = 1.00 | 0% | 0% | keep 0.8 |
| g24 | 10/12 = 0.83 | 4% | **20%** | 0.7 → **0.6** (calibration) |
| g17 | **6/12 = 0.50** | 50% | 74% | **left at 0.7 — it will fail** |

g24 was a calibration error: capability 0.83 against a 0.7 floor false-reds one run in five.

**g17 is not a calibration error — it detects half the time.** Lowering its floor to make it green
would be moving the number to fit the result, which is the one thing this ADR keeps refusing to do
(§3e, Addenda 6-8). It stays at 0.7 and fails honestly until the underlying case is fixed. A
permanently-red g17 is a true statement about the product, not a broken gate.

### Addendum 16 (2026-09-05) — seven prompt variants refuted; g17 is a product gap, not a prompt gap

g17 detects 50% (6/12). Its misses are `supported`, not `unverifiable` — the pipeline affirms a
false claim rather than abstaining. VERIFY receives ordinal-identified evidence in 45 of 46 real
payloads, so this is not an evidence-availability failure.

**Attribution prompt — 6 variants, all refuted.** Four answer-list wordings (Addendum 11), then a
member-comparison scaffold with `fact` correctly stripped: byte-identical to control. The stage
contributes 1 catch in 12 in production. Stop screening it.

**VERIFY prompt — 2 variants, real persisted payloads, 36 calls.**

| variant | false claim | g22 control |
|---|---|---|
| control | `supported` 6/6 — reproduces production | held |
| selector-conflict (mismatch ⇒ CONFLICT) | `supported` 6/6 — no effect | held |
| selector-partial (mismatch ⇒ PARTIAL) | `partially_supported` 6/6 | held |

The stronger rule did nothing, the weaker one moved everything. VERIFY carries a heavy anti-CONFLICT
prior (TEMPORAL SCOPE, NUMERIC, QUALIFIED RANK, ATTRIBUTION STRENGTH all route away from CONFLICT,
under "false positives are worse"). An appended paragraph asking for CONFLICT gets outvoted — do not
retry that shape.

**Two hypotheses were backwards.** The trim was exonerated (Addendum 11). The "first+852 distractor"
was the *disambiguator*: removing it flipped `different` → `absent`.

**Method lesson.** The same payload gave `absent` 3/3 and `different` 3/3 in two runs an hour apart.
Attribution output is unstable at temperature 0, so N=3 screens cannot characterise it — P(3/3 either
way) = 25% at a true 50%. Arm A survives only because 6/6 has p=1.6% under that null. Size screens
against the process rate, not the budget.

**Closed by measurement, do not re-propose:** passage trimming, sentence caps, `ORDINAL_WORDS`,
`subject_entity`, attribution answer-list wordings, attribution scaffold, VERIFY selector-as-CONFLICT.

### Addendum 17 (2026-09-05) — g17's catch depends on regex-matching VERIFY's prose; 4.7.0 REVERTED

VERIFY 4.7.0 (INSTANCE SELECTOR block, screened 6/6 in isolation) took g17 detection from 6/12 to
**0/6** in the pipeline. Reverted (`5391652`).

`grounnel_gate_events` names the mechanism. All six pre-4.7.0 catches came from **`reason_ordinal`**,
which fired 6× before and **0× after**. The block never changed a verdict — it changed how VERIFY
*words its reason*, and the deterministic gate's pattern stopped matching.

| `reason_ordinal` | VERIFY's reason | count |
|---|---|---|
| FIRED | "the **fourth** and final flight covered 852 feet" | 6 |
| missed | "the **longest** flight covered 852 feet" | 6 |

g17's 50% is entirely **whether VERIFY writes "fourth" or "longest"** — same evidence, same verdict
logic, different prose. Superlatives are excluded from `ORDINAL_WORDS` by §3e.

**The structural finding, which outlives this case:** detection here depends on a deterministic gate
regex-matching an LLM's free-text reason. Any VERIFY prompt edit — for any unrelated purpose — can
silently break it. Screening a prompt change against VERIFY in isolation predicts nothing; it must be
screened end-to-end through the gate chain.

**No clean lever remains.** Widening `ORDINAL_WORDS` to superlatives is closed (§3e, and this is the
unrecoverable-FP gate); the evidence-side ordinal gate is refuted (§3i — 25 catches vs 8 unrecoverable
FAs). The only untried option is a narrow nudge asking VERIFY to name the member by position in its
reason — but that is another VERIFY prompt edit, and this addendum is what those cost.

### Addendum 18 (2026-09-05) — §3d protection was applied on one reconciliation path, not both

`reconcileContradictedVerdicts` filters `PROTECTED_CONTRADICTION_GATES` before the classifier call.
`checkRetryContradiction` computed the same originating gate, **logged it, and downgraded anyway** —
so a `reason_ordinal` contradiction was immune on one route and destroyed on the other.

Census over every persisted gate trail (141 protected contradictions, zero API cost):

| | |
|---|---|
| a retry path undid the catch | 11 (8%) |
| still ended `contradicted` anyway | 3 |
| would change to `contradicted` with the guard | **8** |
| of those, claim NOT ground-truth false | **0** |

All 11 leaks are g17 or its sibling claim from the same text — no other case exercises this path, and
no leak ever rescued a true claim from an unrecoverable contradiction.

**Fix:** the guard now mirrors line 260 — a protected origin returns the chain unchanged. Regression
test verified to fail without it.

**This is not the g17 fix.** It restores ~4 leaked catches; expect roughly 50% → 60-70%, not the 0.7
floor. It is worth shipping because §3d says these contradictions are immune and on this path they
were not — a spec violation independent of g17.

### Addendum 19 — the §3d guard measured: leak closed, detection unchanged

Deployed `a76558d`, ran g17 at N=5 (run `01M1R8TR9WFT5ENTH0RSJ67HPD`, ~60 calls).

| | baseline | with guard |
|---|---|---|
| target claim `contradicted` | 1/5 | 1/5 |
| false accusations | 0 | 0 |
| retry path undoing a protected `contradicted` | 1 | **0** |

The prediction stated before the run (2-3/5) was falsified. The guard closes the leak it was written
for and mints nothing, so it stays — but it is not a detection fix, and Addendum 18's estimate of
~4 restored catches was wrong at this sample size.

**Why detection did not move.** Three protected contradictions were minted across the 5 runs, but only
one landed on the scored claim:

| run | "the first flight covered 852 feet" (scored) | "the first flight lasted 59 seconds" (unscored) |
|---|---|---|
| 1 | supported | `contradicted` — `instance_attribution` |
| 2 | `contradicted` — `reason_ordinal` | supported |
| 3 | supported | unverifiable |
| 4 | supported | unverifiable |
| 5 | supported | `contradicted` — `reason_ordinal` |

Both claims are false by the same error: 59 s and 852 ft both belong to the *fourth* flight. All three
catches are correct. The golden set scores only the 852 ft claim, so two of them score as zero.

**The finding.** The gate fires on whichever sibling VERIFY happens to write ordinal prose for, and
which one that is varies run to run. This is Addendum 17's fragility confirmed at claim level rather
than inferred: detection is conditional on free-text wording, so no gate-side or reconciliation-side
change can raise the rate. The remaining option is the structured `member` field in the VERIFY schema
(§3m, open) — matching a field instead of prose. No further gate or reconciliation work on this case.

### Addendum 20 — the input cannot move it either: 27/27 `supported`

Prompt held fixed at v4.6.0, nothing spliced; the INPUT varied. Nine pinned fixtures built from real
persisted payloads, 3 repeats (run `01M1RDPYCJB40X8Y03DYD3SQ2G`, 27 calls).

| fixture | lever | expect | result |
|---|---|---|---|
| f0-baseline | reproduction check | contradicted | `supported` 3/3 — screen valid |
| f1-subject-member | `subject_entity` = "the first flight of December 17, 1903" | contradicted | `supported` 3/3 |
| f2-no-title-crumbs | drop heading/worksheet lines | contradicted | `supported` 3/3 |
| f3-drop-other-member | delete the only "fourth … 852" sentence | unsupported | `supported` 3/3 |
| c1–c5 | five true-claim controls | supported | `supported` 3/3, all held |

**The mechanism, demonstrated.** Identical payload, claims differing only in the ordinal:

- f0 (claim says *first*) → "Multiple sentences across A, B, and C state that **the first** flight covered 852 feet."
- c1 (claim says *fourth*) → "The passage states that **the fourth** flight covered 852 feet."

VERIFY copies the claim's member into its reason and reports it as what the passage says. It is not
performing member identification at all — a STEP 1 failure, not the STEP 2 misapplication Addendum 19
assumed. f0 additionally cites `C:2` ("The fourth flight lasted 59 seconds and went 852 feet!") as
*support* for the first-flight claim.

**f3 closes the door on containment.** With the member sentence deleted, the model dropped C from its
citations and stayed `supported` on A:2/A:3/B:3 — sentences stating 852 with no member named. The
fusion never depended on the member sentence, so neither sentence removal nor a deterministic
cited-selector filter can reach it.

**Cost: none.** All five controls held. The predicted new-miss from a narrow `subject_entity` (c3) did
not occur — because the narrow entity changed nothing in either direction: the model reads "the first
flight of 17 Dec 1903" and "the fourth and final flight of 17 Dec 1903" as the same entity.

**Combined with Addenda 11–17: 8 prompt levers and 3 input levers refuted, 11 total.** No lever on
either side of the call has moved this case. Do not spend further calls on g17 without a materially
new mechanism.

### Addendum 21 — g17 marked known-fragile; floors set to 0

Eleven levers refuted (Addenda 11–20). Stopping work on this case and setting the gate to assert only
what the pipeline actually delivers here.

| | |
|---|---|
| measured detection, last two pinned N=5 runs | 1/5, 1/5 = **0.20** |
| pooled 3 days, 51 observations, mixed code states | 16/51 = 0.31 |
| false accusations, every run | **0** |

`minCorrectRate` 1.0 → 0 and `detectionFloor` 0.7 → 0. Not a number we can meet otherwise: a 0.4 floor
fails today, and a 0.2 floor still flakes 33% of the time (P(0 catches in 5) = 0.8^5) — the file's own
rule is to set the floor BELOW measured capability, and below 0.20 is 0. `minCorrectRate` had to move
too: the screen phase runs each case once, so one miss is 0/1 and fails before escalation scores it.

**What the case still enforces.** `no_false_accusation` is a separate violation rule independent of
both floors, so g17 goes red the moment it calls a true claim false — the property that has held in
every run. Detection is still recorded per run; it is no longer gated.

Revisit only with a materially new mechanism, not another prompt or payload variation.
