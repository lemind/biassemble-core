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
`specs/012-grounnel-ordinal-eligibility-gates/data-model.md` §2.

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

**Still open**: one of the 3 live runs had no ordinal token in the reason at all ("the longest flight
... covered 852 feet" — no "fourth"), a pure superlative with nothing to anchor on — this is §3e's
already-accepted, deliberately-unfixed gap, not something this anchor-window fix (or any anchor-window
fix) can reach, since there's no ordinal match to extend anchoring from in the first place.

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
