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
