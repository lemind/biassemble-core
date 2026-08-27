# D032 — Grounnel failure taxonomy: what to fix, what to rework

Status: **analysis + plan, nothing implemented.** Supersedes nothing. Extends D030 §3m (the
`subject_entity` decision) with the architectural context that decision was missing.

Source data: one 13.8KB adversarial article (run `c94d2954`, 2026-08-26, 44 claims), plus the
132-firing historical `subject_entity` dataset from D030 §3n. Everything below is measured from
persisted telemetry, not inferred.

---

## §1. Why this exists

A deliberately adversarial article — false facts alongside their own corrections, opinions,
predictions, near-miss numbers — was run through the live pipeline. An external review scored it
~52% and named "EXTRACT takes the correction instead of the false claim" as the headline defect.

Re-scoring against the telemetry produced a different picture, and the difference matters more than
the score: **the headline defect is a contract disagreement, not a bug**, and the real failures
cluster into far fewer causes than the symptom count suggests.

## §2. The extraction contract — decide this first, it changes the denominator

The article says *"I remembered the Great Fire happened in 1766… Later I learned it actually
happened in 1666."* EXTRACT emits `The Great Fire of London happened in 1666` and never emits the
1766 version.

| Contract | EXTRACT should emit | Score on this run |
| --- | --- | --- |
| **A** — what the text asserts as true | the corrected fact only | **34/44 = 77%** |
| **B** — every proposition present, including retracted ones | both `1766` and `1666` | **34/63 = 54%** |

Same verdicts, same pipeline; only the denominator moves. The external review's ~52% is contract B.
Verified against `source_excerpt`: **0/44 claims contain a year absent from their own cited span** —
EXTRACT fabricates nothing. Where the text states a correction it emits the correction (9 cases);
where the text only expresses doubt it emits the original claim, which is then correctly
`contradicted` (3 cases: Eiffel/London, Apple/Gates, Amazon/electronics). That is a coherent rule,
not a coin flip.

**Recommendation: adopt A explicitly and write it down.** Contract B would flag a self-correcting
article as containing misinformation, which inverts the product's purpose. A is already what the
code implements. Recording it prevents this from being re-litigated the next time an adversarial
story is run. **Not yet ratified — this is a product call, deliberately left open here.**

**Proposed ratification wording** (all four reviews converged on A; this phrasing is the strongest
of them, and deliberately broader than "what the text asserts as true" so it covers quotation
and hypotheticals, not just self-correction):

> EXTRACT identifies claims the submitted text presents as **current assertions**, excluding
> propositions explicitly retracted, corrected, quoted only as mistaken beliefs, or otherwise
> negated by the surrounding discourse.

If ratified, this must also be applied to the evaluation harness's scoring and stated in the API
docs — otherwise the same rubric mismatch recurs on the next adversarial article.

## §3. What the telemetry actually shows

Four findings, each measured, each with consequences for what is worth building.

### §3a. Nine of ten deterministic gates fired zero times

| Gate | Evaluations | Fired |
| --- | --- | --- |
| `subject_entity` | 75 | 12 (16%) |
| `reason_consistency`, `implicit_negation`, `reason_year`, `reason_ordinal`, `counterfact_ignored`, `contradiction_evidence`, `claim_reason_overlap`, `numeric`, `year` | 75 each | **0** |

Zero firing is not automatically failure — `contradiction_evidence` firing zero times means every
`contradicted` verdict VERIFY produced was properly evidence-grounded, which is the guard working.
But the reason-* gates exist to catch VERIFY contradicting *itself*, and on the run's actual
failures VERIFY was never self-contradictory. It was **confidently, coherently wrong**.

The one gate that did fire was net-negative here: 2 of its 12 firings produced failures (§4, cases
5–6), and none prevented one.

**Consequence: the gate chain is built to detect self-inconsistency. The failures that occur are
confident wrongness. These are different detector classes, and the existing one does not cover the
other.** That is an architectural gap, not a tuning problem.

**Read this correctly — fire rate is not a quality metric.** A high-value safety gate may
legitimately fire almost never (`contradiction_evidence` firing zero times here means every
`contradicted` verdict was properly grounded — the guard succeeding), while a gate that fires often
may indicate an upstream representation problem rather than usefulness (`subject_entity`, D030 §3l).
Nothing in this section licenses optimising for gate hit rate, or deleting a gate because it was
quiet on one article. The finding is about **coverage of a failure class**, not about the gates'
individual value.

### §3b. Confidence carries no information

| Verdict | n | mean confidence | min |
| --- | --- | --- | --- |
| `supported` | 29 | 0.993 | 0.9 |
| `contradicted` | 6 | 1.000 | 1.0 |
| `unverifiable` | 6 | 0.975 | 0.9 |
| `unsupported` | 3 | 0.967 | 0.9 |

Minimum confidence across all 44 claims is **0.9**; the code-side `CONFIDENCE_THRESHOLD` check (0.6)
therefore never fires. The single false affirmation (§4 case 1) carried high confidence like
everything else.

**Correction (review finding, verified against the prompt): the threshold is NOT dead code, and the
distribution above is its effect, not evidence against it.** `CONFIDENCE_THRESHOLD` is interpolated
into the VERIFY system prompt, which instructs: *"if confidence is below {{threshold}}, replace the
mapped verdict with `unverifiable` for reporting purposes."* The model applies the threshold to
itself and reports `unverifiable` instead of a low number — so low confidences never reach the code
path. The code-side checks (`pipeline.service.ts` lines ~743, ~798) are a redundant second
application of a rule already enforced upstream, not the primary mechanism.

**Consequences, revised:**
1. **Any remedy keyed on the reported confidence value is still dead on arrival** — the number has
   no variance by construction. This retrospectively explains D030 §3n's Option A (124/132
   suppressed).
2. **Deleting `CONFIDENCE_THRESHOLD` would change the VERIFY prompt and therefore model behaviour**
   — it is not a safe dead-code removal. Any change here needs live re-verification, not a refactor.
3. The interesting unmeasured question is the *self-censoring rate*: how often does VERIFY choose
   `unverifiable` via this instruction rather than via a genuine ABSENT relationship? That is
   invisible in current telemetry and would need a prompt-level experiment to separate.

### §3c. Retrieval succeeded; ranking and reasoning failed

For the false affirmation (`The first computer mouse was wireless`), the refuting sources **were
retrieved** — SRI, DARPA, and Polymer Innovation all describe Engelbart's 1964 corded mouse. Rerank
then scored a listicle timeline highest:

| Combined | LLM score | Source |
| --- | --- | --- |
| **95.0** | 90 | `proedit.com/history-of-the-mouse` — contains the line *"1984 — First Wireless Mouse"* |
| 85.0 | 70 | `yesterdaysoffice.com` |
| 68.3 | 70 | `sri.com` — the authoritative account of the actual first mouse |
| 63.3 | 60 | `darpa.mil` |

VERIFY then cited the top passage and concluded `supported`, conflating *"the first wireless mouse"*
with *"the first mouse was wireless"*.

**Consequence: "better search" is not the fix for this class.** The correct evidence was one rank
below. The failure is qualifier-scope reasoning, compounded by a reranker that rewards lexical
density over source authority.

**Correction (review finding, verified against `src/prompts/grounnel/verify/system.json`): the
VERIFY prompt already contains a section for exactly this reasoning class** —
`QUALIFIED RANK VS ABSOLUTE SUPERLATIVE`, with worked examples (Nauru "third-smallest" vs
"smallest"; Hopper "led the team" vs "designed primarily"). It covers a **lesser rank** in the
evidence against an **unqualified extreme** in the claim. It does **not** cover the inverse shape
seen here: a **narrower qualified superlative** in the evidence (*"first wireless mouse"*) against a
**broader one** in the claim (*"first mouse"*). The modifier narrows the referent class, so the two
superlatives are about different things entirely.

This materially changes the remedy for §4 case 1: it is an **extension to an existing prompt
section**, not a new detector — which is a far more bounded change than "prompt hardening" implied,
and is why case 1's fix confidence is revised from Low to Medium.

### §3d. The pipeline is support-seeking only

Three separate symptoms share one cause. `The Roman Empire began in Greece` and `Vikings discovered
Australia` both returned *"the passages do not state that…"* → `unsupported`. `Microsoft did not
create the iPhone` returned empty evidence → `unverifiable`.

In all three the pipeline searched for evidence **supporting** the claim, found none, and stopped.
There is no symmetric path that asks "is there evidence this is *false*." For a confidently false
claim, and for any negatively-phrased claim, absence of support is the expected outcome and carries
no signal.

**Consequence: what looks like three retrieval/VERIFY bugs is one missing pipeline stage.**

### §3f. `unverifiable` collapses three distinct states (review-4 finding, measured)

The original draft framed #8/#9 as a two-way conflation (excluded vs. genuinely-unverifiable). It is
a **three-way** collapse. Across every `unverifiable` claim ever stored (n=277), classified by
whether search ran and whether `subject_entity` fired:

| Cause | n | % | What it actually means |
| --- | --- | --- | --- |
| Excluded by eligibility — never searched | 116 | **41.9%** | Correctly identified as opinion/personal/prediction. Zero search calls. Not a verification outcome at all. |
| `subject_entity` downgrade | 69 | **24.9%** | Searched, evidence retrieved, then the gate rejected the evidence on lexical entity mismatch (D030 §3l). |
| Genuine verification failure | 92 | **33.2%** | Searched, evidence retrieved, genuinely could not resolve. |

**Only a third of `unverifiable` means what the word implies.** Same pattern in the source run
(2 excluded / 3 gate-downgraded / 1 genuine out of 6).

**Consequence, and it changes #8/#9's scope:** adding an `excluded` verdict fixes the 41.9% slice
only. The 24.9% `subject_entity` slice remains conflated with genuine failure — and that slice is
precisely the one D030 §3m measured as ~25–30 true claims per 1,000 evaluations wrongly suppressed.
A user (or an analyst) currently cannot distinguish "we never checked this" from "we checked, found
evidence, and a lexical heuristic threw it away" from "we checked and genuinely don't know."

This does **not** argue for changing `subject_entity`'s behaviour (D030 §3m stands, R2 unchanged) —
it argues that its downgrades should be *labelled distinctly*, which is a telemetry/contract change
of the same class as #8/#9 and carries the same near-zero risk.

### §3g. MEASURE-1: case-1 does NOT reproduce at N=10 — T8 cancelled

Spec 013's T3 re-ran the exact case-1 fixture (`g24-mouse-superlative`, "The first computer mouse
was wireless") 10 times against the live pipeline (2026-08-26, run window 13:07–13:11 UTC).

**Result: 10/10 `contradicted`, 0/10 `supported`.** Every repetition correctly distinguished the
1984 Logitech "first *wireless* mouse" from the 1964 corded Engelbart prototype — the exact
qualifier-narrowing distinction §3c described VERIFY missing. This is the inverse of §4 case 1's
outcome and satisfies SC-3's bar (`contradicted`/`unsupported`, never `supported`) *without* the
planned prompt extension.

**This changes T8's status.** Spec 013 T3 states explicitly: *"If it never reproduces, T8 is
cancelled — do not harden a prompt against a single unlucky draw."* That condition is met.
**T8 is cancelled.** §4 case 1's fix confidence is revised from Medium to **N/A — not reproducing**;
no prompt change is scheduled against this failure mode.

**What this does and doesn't mean.** It does not mean the original observation was fabricated — the
rerank scores in §3c were read from real persisted telemetry for that one run. It means a single
draw is not evidence of a *systematic* failure, which is the entire reason MEASURE-1 existed as a
gate rather than shipping the prompt change on the strength of one example. Reranking is
non-deterministic (§3c: "a reranker that rewards lexical density over source authority" — density
scoring over a stochastic retrieval set), so which passage lands on top varies run to run; the
original occurrence may have been the unlucky tail, not the mode.

**Not fully closed:** N=10 rules out "this fails often." It does not rule out a lower-frequency
recurrence (e.g. 1-in-20). Given the qualifier-narrowing section already exists in the prompt
(§3c's correction) and this is a zero-risk, zero-cost, do-nothing outcome, the pragmatic call is to
leave it uninstrumented rather than spend a MEASURE-1-sized budget again chasing a tail rate — flag
here so a future recurrence isn't mistaken for a new bug.

### §3h. MEASURE-2: `prediction` misclassification rate — N too small to answer

Spec 013 T4 pulled every historical `eligibility_check` call (n=2,724) and filtered to
`category='prediction'`. **Result: n=1.** It is the same claim as §4 case 7 ("AI would eliminate
most programming jobs within five years"), `certainty: uncertain`, so `isEligibilityExcluded`
correctly did not exclude it; it ran the full pipeline and landed `unsupported` — a genuinely
unfalsifiable claim (no fixed timeframe), correctly not excluded and correctly not force-verified
as true or false either.

**This does not clear or fail T13's ~5% cancellation threshold — a rate needs a denominator, and 1
isn't one.** What it does show: `prediction` is a vanishingly rare classification in real traffic
(1 in 2,724 eligibility checks). Whatever T13's policy ends up being (exclude `prediction`
regardless of certainty, per D030 §3b's proposed reversal, vs. the current conservative fallback),
**the blast radius of getting it wrong is small either direction**, because the category barely
fires. Recommendation: leave T13 gated as specced — this is not evidence for reversing D030 §3b,
just evidence that the decision is low-stakes whenever it's made. Revisit if production volume of
this category increases.

### §3j. MEASURE-4: reranker source-authority counterfactual — 7.5% of flippable claims

Spec 013 T14, run 2026-08-26 against all persisted `grounnel_rerank_decisions` (n=3,874 claims,
18,330 candidate rows). Question: not "does authority correlate with rank" but the counterfactual —
*on how many claims would adding a domain-authority term have changed the top-`MAX_VERIFY_PASSAGES`
(3) set VERIFY actually received?*

**Method:** for each claim's rerank decisions, took only the **final invocation** (a claim can have
up to 3 — initial plus 2 escalation-tier retries at wider candidate pools, `ESCALATION_TIERS=[5,8]`;
using an earlier invocation would score a passage set VERIFY never actually saw for that claim's
final verdict). Added a flat +15 (on the 0–100 `combined_score` scale — §3c's real rank1/rank2 gap
was ~10 points) to any candidate on a `.gov`/`.edu`/`.int`/`.mil` domain or in a small fixed set of
major reference/wire domains (Wikipedia, Britannica, Reuters, AP, BBC, Nature, ScienceDirect).
Re-ranked, re-sliced top-3, compared the URL set to what was actually persisted as `selected`.

**First pass was wrong and is not the number below** — merging all of a claim's invocations
together (instead of isolating the final one) inflated apparent "selected" counts past 3 per
invocation and produced a spurious 85% flip rate. Caught via a sanity check (no single invocation
should ever have `selected=true` on more than 3 rows) before this got written down as a result.

**Result, final-invocation-only:**

| | n | % |
| --- | --- | --- |
| Claims with a rerank decision | 3,874 | — |
| Claims with >3 candidates (only these *can* flip — ≤3 candidates means the "top 3" is everything) | 881 | 22.7% |
| Top-3 set changes under the authority term | 66 | **1.7% of all claims / 7.5% of flippable claims** |

**Reading it:** this is a real, non-trivial minority, not noise, and not a crisis. It confirms §3c's
mechanism exists beyond the single case-1 draw — reranking does sometimes hand VERIFY a different
passage set when authority is weighted in — but at ~7.5% of the claims where it's even possible, it
bounds R3's ceiling rather than dominating it: even if every one of these 66 claims was *also* a
predicate-structure misread, R3 could only ever be "responsible for" the other 92.5% of flippable
cases, and most claims (77.3%) have so few candidates the question doesn't even arise.

**Decision, per D032 §5's ordering correction:** does not clear or kill R4/R3 outright. It gives R4
a concrete, bounded number instead of one anecdote — enough to say "worth a real design pass if R3
is ever picked up," not enough to say "rerank is broken" or "R3 is unnecessary." Characterisation
only, per this task's own scope note; no reranker change is made here.

### §3k. MEASURE-3: negative claims false-accuse at 14% — and it's not a retrieval problem (§3d revised)

Spec 013 T10, run 2026-08-26. 5 new golden cases, "X did not do Y" with a well-documented positive
form, N=10 each (50 repetitions total).

| Case | supported | unsupported | contradicted |
| --- | --- | --- | --- |
| "Microsoft did not create the iPhone" | 10 | 0 | 0 |
| "The Eiffel Tower is not located in London" | 10 | 0 | 0 |
| "Buzz Aldrin was not the first man to walk on the Moon" | 7 | 0 | **3** |
| "World War II did not end in 1943" | 1 | 5 | **4** |

**Aggregate: 38/50 (76%) `supported`, 5/50 `unsupported`, 7/50 (14%) `contradicted`.**

**The 7/50 `contradicted` result is a Cardinal Rule violation, live, today, with no fix applied.**
These are `kind: true` claims (the negation is factually correct) — `contradicted` on a true claim
is the one unsafe failure this entire project is built to prevent, and this measurement produced it
at a rate an order of magnitude above the "essentially never" bar every other golden case holds to.

#### VERIFY is not the guilty layer. Our own gates are.

**Correction to this section's own first draft.** It originally concluded that VERIFY "inverted the
polarity of its own conclusion," inferred from reading the `reason` prose. That was wrong, and it
was wrong for a specific, repeatable methodological reason: **the `reason` field was read without
checking `grounnel_gate_events`** — exactly the archaeology step D030 §3n exists to force. Querying
the gate events inverts the conclusion completely.

**In all 20 repetitions of the two failing cases, VERIFY returned `supported` — the correct answer.
Every single wrong verdict was produced by a deterministic gate overriding it.**

| Gate | Cases | Override | n |
| --- | --- | --- | --- |
| `reason_ordinal` (FROZEN, D030 §3k) | Aldrin | `supported` → `contradicted` | 3 |
| `reason_year` | WWII | `supported` → `contradicted` | 4 |
| `reason_consistency` | WWII | `supported` → `contradicted` | 7 |
| `retry_reconciliation` | WWII | `contradicted` → `unsupported` (partial rescue) | 5 |

`verdict_before` is `supported` on **100%** of the overrides that produced a `contradicted` verdict.
Not one false accusation originated in the LLM.

**Total gate damage: 12/50 repetitions (24%)** — the 7 `contradicted` plus the 5 `unsupported`.
The `unsupported` five are *also* wrong (the claims are true); they are cases where
`retry_reconciliation` caught the bad `contradicted` and downgraded it, but to `unsupported` rather
than restoring VERIFY's original `supported`. The safety net works and is still not enough: it
converts an unsafe wrong answer into a safe wrong answer.

#### The mechanism: negation-scope blindness

Each gate extracts a token from the claim and compares it against the reason, with **no check for
whether that token sits inside a negation scope**:

| Claim | Token extracted | Reason states | Gate's inference | Reality |
| --- | --- | --- | --- | --- |
| "WWII did **not** end in **1943**" | year `1943` | `1945` | mismatch → contradicted | a different year **confirms** the negation |
| "Aldrin was **not** the **first**" | ordinal `first` | `second` | mismatch → contradicted | "second" **confirms** the negation |

This is a textbook negation-scope bug: a negation cue (`not`) has a syntactic scope, and any
token-level comparison must know whether the compared token falls inside it. Ours don't.

`reason_consistency` fails differently and more subtly. It fires on contradiction language in the
reason prose. VERIFY's prose here reads *"...which contradicts the claim that it did not end in
1943"* — garbled wording — **while its verdict was `supported`**. The gate treated the prose as
authoritative and overrode the verdict. That inverts the correct trust ordering: the verdict is
VERIFY's actual judgment; the prose is a fallible narration of it.

#### Consequence for T11/T12: the planned fix targets the wrong layer twice over

D032 §5 (and spec 013's T11 acceptance) describes the fix as *"detect a negative claim and invert
the search query... let VERIFY evaluate the negation against the positive answer"* — a retrieval-side
fix, premised on support-seeking search returning nothing for a negative claim. **Both halves of
that premise are refuted:** search retrieved the correct passage in all 50 repetitions, and VERIFY
evaluated it correctly in all 50. Neither retrieval nor VERIFY needs changing. Query reframing would
not move a single one of these 12 outcomes.

**§3d's framing is narrowed accordingly.** Its claim that the pipeline is support-seeking-only still
stands for cases #2/#3 (a confidently *false* positive claim with no supporting evidence). It does
**not** explain case #4 or this measurement — negatively-phrased claims are retrieved and verified
correctly, then broken by the gate chain.

#### Architectural observation, larger than this fix

All three culprit gates share a direction: they can only escalate a verdict **toward
`contradicted`**, the one verdict the Cardinal Rule treats as unsafe, and they do it on the strength
of reason prose that this measurement shows is unreliable on negated claims. `subject_entity`, by
contrast, is downgrade-only. A guard family whose only available move is to manufacture the unsafe
verdict is worth revisiting on its own terms, independently of the negation fix — recorded here, not
proposed as work.

**T11's design is re-scoped by this finding — see §9 for the design and the options scored against
it.**

### §3e. Cost distribution (context for any proposal that adds calls)

128 LLM calls, ~435K tokens, for 44 claims. Reranking alone is 68 calls / 171K tokens — comparable
to VERIFY primary (10 batched calls / 176K tokens). Any new stage competes with reranking for
budget, and §3c suggests reranking is currently mis-scoring the thing it costs the most to do.

## §4. Case-by-case: guilty layer, fix, and confidence in that fix

Ten symptoms; **seven distinct causes** (cases 2/3, 5/6, and 8/9 are each one cause).

| # | Case | Guilty | What happened | Fix | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | "First computer mouse was wireless" → `supported` | **VERIFY** | Qualifier-narrowing conflation: *"the first **wireless** mouse"* read as support for *"the first mouse was wireless."* The modifier changes the referent. Refuting sources were retrieved but ranked lower (§3c). Only false affirmation in 44. | ~~Extend the VERIFY prompt's `QUALIFIED RANK VS ABSOLUTE SUPERLATIVE` section~~ — **cancelled, §3g.** Re-run at N=10 (spec 013 T3): 10/10 `contradicted`, 0/10 `supported`. Does not reproduce; no prompt change scheduled. | **N/A.** Confidence was Medium pending N≥10 confirmation; the confirmation came back negative. |
| 2 | "Roman Empire began in Greece" → `unsupported` | **Pipeline design** (§3d) | No supporting evidence → `unsupported`. Absence of support never converted into refutation. | Refutation search stage: on a checkable claim with no support, issue a second query seeking contradiction. | **Low–medium.** Mechanically clear, but it is a new path that *creates* `contradicted` verdicts — new false-accusation surface, the risk this project guards hardest. |
| 3 | "Vikings discovered Australia" → `unsupported` | **Pipeline design** (§3d) | Same mechanism as #2. | Same as #2 — one stage covers both. | Same as #2. |
| 4 | "Microsoft did not create the iPhone" → `unverifiable` | **Pipeline design** (§3d) | Negative claim; evidence empty. Searching for proof a thing did *not* happen is structurally unsupported by a support-seeking design. | Reframe negatives before search (query the positive, evaluate the negation against it). | **Medium.** Failure well understood, but a real feature with its own edge cases. |
| 5 | Wright fourth flight "lasted 59 seconds" → `unverifiable` | **`subject_entity`** | Anchor `"Wright brothers' fourth and final flight"`; evidence cites *"Wilbur"*. No literal proper-noun overlap → downgrade. D030 §3l/§3m/§3n. | Real coreference resolution. A/B/B-tight/C all simulated against 132 firings — **all four refuted**. | **None — deliberately unfixed.** Cause certain; affordable fix does not exist. |
| 6 | Wright "really did fly 852 feet" → `unverifiable` | **`subject_entity`** | Same gate, same run, same mechanism. | Same as #5. | Same as #5. |
| 7 | AI-eliminates-jobs prediction → `unsupported` | **Eligibility policy** | Classified `prediction` but `certainty="uncertain"`; `isEligibilityExcluded` requires `certainty === "clear"`, so it fell through to a full 11-page search. | One line: exclude `prediction` regardless of certainty. | **High mechanically; medium as policy.** Reverses D030 §3b's deliberately conservative rule. Needs the classifier's misclassification rate measured first. |
| 8 | "SQL is more useful than NoSQL" → `unverifiable` | **Output contract** | Pipeline was **correct** — classified `opinion`, excluded it, ran 0 searches. Only storage is wrong: no `excluded` value in the verdict enum, so exclusion is indistinguishable from "tried and failed." | Add `excluded` to `GrounnelVerdictEnum` + DB enum, or surface the already-distinct `reason` string. | **High.** No LLM behavior involved. Caveat: enum touches Zod contract, frontend, DB, and every verdict-enumerating test — check first whether the frontend already reads `reason`. |
| 9 | "GraphQL is better than REST" → `unverifiable` | **Output contract** | Identical to #8. | Same as #8. | Same as #8. |
| 10 | "A person really did die in a particular year" → `unverifiable` | **EXTRACT** | Emitted a contentless claim with no resolvable referent — unverifiable by construction. | Eligibility rejects claims with no resolvable subject, or tighten the EXTRACT prompt. | **Medium.** Direction clear, but "has a resolvable referent" is a fuzzy predicate — the same class of judgment that made `properNounWords` brittle. |

Layer tally: **pipeline design 3, VERIFY 1, `subject_entity` 2, output contract 2, eligibility 1,
EXTRACT 1.** Zero attributable to the correction-extraction behaviour the external review named as
the headline problem.

## §5. Fix vs rework

The distinction used here: a **fix** is a change whose blast radius is bounded and whose success
criterion is already measurable. A **rework** is a change to a premise — where continuing to patch
the current mechanism has a track record of refuted attempts, or where the mechanism is
structurally unable to address the observed failures.

### Fix now (bounded, safe, measurable)

| Item | Why it qualifies | Gate before starting |
| --- | --- | --- |
| `excluded` verdict value (#8/#9) | No LLM behaviour; the correct pipeline decision is already being made and merely mis-stored, which corrupts D023 analytics — `unverifiable` currently conflates "tried and failed" with "correctly never checked". | Frontend `reason` handling (§7 Q3). Two reviews split on whether this blocks: the backend data-model correction stands on its own analytics merit, but the enum touches the shared contract, so the frontend must be coordinated, not ignored. |
| Enriched `reason` for unsupported (#2/#3) | Replaces R1 entirely (see §5 rework). Text-only change to how absence is explained; no new search, no new verdict, no false-accusation surface. | None — lowest-risk item on this list. |
| Negative-claim reframing (#4) | Split out of R1 (see §5). Stays inside the support-seeking paradigm; measurable against a targeted golden subset. | Needs a design + a golden subset of negative claims; none exists yet. |
| Prediction exclusion (#7) | One line. | **Blocked on measurement.** Reverses D030 §3b's deliberately conservative rule. Requires a held-out sample (N≥10, including explicitly dated/scheduled future events) showing the `prediction`-misclassification rate on genuinely checkable claims is low. Two reviews independently flagged this as the most over-confident item in the original draft. |
| ~~Remove `CONFIDENCE_THRESHOLD`~~ **— withdrawn** | Original draft called it dead code. **That was wrong** (§3b correction): it is interpolated into the VERIFY prompt and the model self-applies it, so removing it changes model behaviour. Reclassified as a prompt-level experiment, not a refactor. | Would need live re-verification, not a code review. |

### Rework candidates (premise is the problem, not the parameters)

**R1 — Symmetric refutation (covers #2, #3 only — see the split below).** Not a bug fix: the
pipeline has no disconfirmation path at all. Adding one is a genuine architectural addition, and it
must be designed against the false-accusation asymmetry from the start — a refutation stage that
produces `contradicted` verdicts is the highest-risk component this system would contain.

**Recommendation, after review: do not build R1.** Absence of supporting evidence is not evidence of
falsehood, and a refutation search that manufactures `contradicted` from that absence inverts the
Cardinal Rule. A search for "Vikings discovered Australia" returning nothing has not established the
Vikings didn't — and the sources such a search *would* surface (fringe, satirical, SEO filler) are
exactly the ones least safe to accuse on. The principle to keep: **a claim becomes `contradicted`
only on affirmative counter-evidence.** Under that principle `unsupported` is the *correct* verdict
for #2 and #3, and the real defect is that users cannot distinguish "we found nothing" from "this is
false" — a **reporting problem, not a retrieval one**. Cheaper remedy: enrich the `reason` text to
state explicitly that no supporting evidence was found and that this is not a finding of falsehood.

**Split out of R1 — negative-claim reframing (#4) is a bounded fix, not a rework.** Review finding,
and D032 originally conflated the two. "Microsoft did not create the iPhone" fails for a structural
reason unrelated to refutation: it is a *negative* proposition, and a support-seeking search cannot
confirm a non-event. The fix is to detect negative claims and **invert the query** ("who created the
iPhone?"), then let ordinary VERIFY logic evaluate the negation against the positive answer. This
stays entirely inside the support-seeking paradigm, creates no new `contradicted` surface, and is
measurable against a targeted golden subset. It belongs in "fix now" scope, gated on a design.

**R2 — `subject_entity`: replace or delete, do not patch (covers #5, #6).** Four candidate fixes
simulated against 132 real firings; all four either gutted the gate (A: 94% suppressed, C: 99%) or
failed on the cases they targeted (B, B-tight). The gate's premise — *lexical proper-noun overlap
implies entity identity* — is unsound over free text and cannot be repaired by adjusting its
conditions. D030 §3m keeps it on cost grounds (~11–18% recovery, ~25–30 true claims/1000
permanently suppressed, but structurally incapable of false accusation). This ADR does not reopen
that; it records that **the next attempt must change the mechanism, not its thresholds.**

**R3 — Detector class: self-inconsistency vs. confident wrongness (covers #1).** §3a is the core
finding. Ten gates check whether VERIFY contradicts itself; the observed failures are internally
coherent and externally wrong. No amount of additional reason↔verdict gating reaches case #1,
because VERIFY's reason there *correctly describes what it found* — it found the wrong thing. A
detector for this class compares the claim's **predicate structure** (subject, superlative scope,
relation) against the evidence's, which is a different kind of component from anything currently in
the chain. **Speculative; no design, no evidence it is tractable.** Recorded so the zero-firing
measurement isn't mistaken for "gates are fine."

**R4 — Reranking (contributes to #1). Investigate this BEFORE R3.** Ranks a listicle above SRI/DARPA
on the one claim that produced a false affirmation, while consuming token budget comparable to
VERIFY itself (§3c, §3e). Whether source authority belongs in ranking is a real design question and
is currently unmeasured — one case is not evidence.

**Ordering correction (review finding): R4 is a prerequisite for judging R3, not a peer of it.** If
the reranker systematically prefers lexical-density pages over authoritative sources, some unknown
share of what looks like "VERIFY interpretation failure" is really "VERIFY was handed the wrong
passage." Measuring that share is cheap — rerank scores are already persisted per claim in
`grounnel_rerank_decisions` — and it bounds how much work R3 is actually responsible for. Building a
predicate-structure detector before knowing that share risks solving the smaller half of the problem.

## §6. Explicitly not doing

- **Acting on any of R1–R4 now.** This ADR is analysis. Every rework above needs the same treatment
  D030 §3n applied to `subject_entity` — simulate against historical data before writing code.
- **Re-tuning gate thresholds in response to §3a's zero-firing result.** Zero firings on one article
  is not evidence the gates are wrong; several are guards that correctly had nothing to guard.
- **Treating the ~52% vs 77% gap as a regression.** It is a contract disagreement (§2), and until §2
  is ratified neither number is the system's score.
- **Any remedy keyed on VERIFY confidence** (§3b).

## §7. Open questions blocking work

1. **Ratify the extraction contract (§2).** Blocks any re-scoring; changes the denominator of every
   future measurement. *Status: **ANSWERED (2026-08-26) — Contract A ratified.** EXTRACT identifies
   claims the submitted text presents as current assertions, excluding propositions explicitly
   retracted, corrected, quoted only as mistaken beliefs, or otherwise negated by the surrounding
   discourse (exact wording, §2). T9 (align the eval harness) is unblocked.*
2. **Should a confidently-false, unsupported claim read `contradicted`, or is `unsupported` correct
   and the real gap a user-facing one?** *Status: answered — `unsupported` is correct. Two reviews
   converged on the principle that a claim becomes `contradicted` only on affirmative
   counter-evidence, which the Cardinal Rule already implies. R1 is therefore **not built**; the
   remedy is the enriched-`reason` reporting fix in §5, and #4 splits out as its own bounded item.*
3. **Does the frontend already distinguish exclusion via `reason`?** Determines the sequencing (not
   the merit) of #8/#9. *Status: **ANSWERED (2026-08-26)** — no. Checked
   `biassemble/frontend/src`: `verdictStyle.ts`'s `VERDICT_HIGHLIGHT_CLASS`/`VERDICT_DOT_CLASS` key
   only on `ClaimVerdict`; a repo-wide grep for `.reason` usage outside the type declaration itself
   returns zero hits — `Claim.reason` is fetched but never rendered or branched on. `Score`'s
   `not_checked_n` field is likewise declared but unread by any component. **FIX-1 ships
   backend-only**; the frontend needs its own small follow-up (one `VERDICT_*_CLASS` case each,
   plus a UI decision for what `excluded` looks like) before a user actually sees the distinction —
   tracked as new task T16, not blocking T5/T6.*

## §8. Review round (2026-08-26) — what changed and why

Four independent external reviews of the first draft. Corrections applied:

| # | Correction | Verified how | Severity |
| --- | --- | --- | --- |
| 1 | `CONFIDENCE_THRESHOLD` is **not** dead code — it is interpolated into the VERIFY prompt and the model self-applies it, which is *why* min confidence is 0.9. Removal would change behaviour. | Read `src/prompts/grounnel/verify/system.json` + the 4 `grep` call sites. | **High — reversed a "fix now" item.** |
| 2 | The VERIFY prompt **already has** a `QUALIFIED RANK VS ABSOLUTE SUPERLATIVE` section. Case 1 is an *extension* of it (modifier-narrowing), not a new detector. Fix confidence Low → Medium. | Read the prompt. | **High — changed the remedy class.** |
| 3 | Case #4 (negative claims) does **not** belong in R1. Query reframing stays support-seeking and adds no `contradicted` surface. | Reasoning, unanimous across two reviews. | Medium — moves an item from rework to fix. |
| 4 | R1 should **not** be built. `unsupported` is the correct verdict; the gap is reporting. | Cardinal Rule + two reviews. | Medium — closes §7 Q2. |
| 5 | R4 must be investigated **before** R3 — reranker bias bounds how much of case 1 is VERIFY's fault at all. | Ordering argument; rerank scores already persisted. | Medium — reordered the research track. |
| 6 | §3a's zero-firing result must not be read as "gates are useless" or as a licence to optimise hit rate. | Own `contradiction_evidence` counter-example. | Medium — prevents a foreseeable misreading. |
| 7 | Prediction exclusion (#7) is more dangerous than the draft implied; blocked on a held-out misclassification measurement. | Two reviews flagged independently. | Low — tightened an existing caveat. |
| 8 | `unverifiable` collapses **three** states, not two — measured at 41.9% / 24.9% / 33.2% (§3f). Adding `excluded` fixes only the largest slice. | SQL over all 277 historical `unverifiable` claims. | **High — expanded #8/#9's scope.** |
| 9 | MEASURE-4 should ask the *counterfactual* ("would authority features have flipped the rank?") rather than report a correlation. | Reasoning; rerank scores already persisted per claim. | Low — sharpened an existing task. |

Points where the reviews were **not** followed: one review proposed a manual labelling study of
~50 historical `unsupported` claims to decide R1's value. Correction #4 makes R1 moot on principle
rather than on prevalence, so the study would measure something we have already decided not to act
on. A reranker-authority study (R4) is the better use of the same effort.

**Methodological note — reviewer consensus was wrong once, and it mattered.** Three of four reviews
(plus this ADR's own first draft) recommended deleting `CONFIDENCE_THRESHOLD` as dead code. Exactly
one review instead said *verify its consumers first*. That check found it interpolated into the
VERIFY prompt, where the model self-applies it — making deletion a behaviour change, not a cleanup
(correction #1). Agreement across independent reviewers is not evidence; the single reviewer who
asked for verification was right against the majority. Worth remembering the next time several
reviews converge on the same "obvious" cleanup.

## §9. T11 re-scoped: negation-scope guard for the reason-family gates

Supersedes the query-reframing design in §5 for case #4. Written after §3k's gate-event archaeology
established that VERIFY is correct 50/50 and the gate chain produces 100% of the wrong verdicts.

### §9a. The two options that were on the table, scored

Scored against this ADR's own constraints — the Cardinal Rule, D030 §3n's simulate-first rule,
CLAUDE.md's coverage cap and prompt-change policy.

| Criterion | **A — VERIFY prompt fix** | **B — new deterministic gate** |
| --- | --- | --- |
| Targets the actual defect | **0/10** — VERIFY returned the correct verdict in 50/50 repetitions; there is no defect here to fix | **4/10** — right layer (gate chain), wrong shape: needs three *existing* gates corrected, not a fourth added |
| Cardinal Rule fit | 2/10 — prompt tuning has no floor; a reduced rate still ships false accusations | 7/10 — a downgrade-only gate can only remove accusations |
| Verifiability | 3/10 — stochastic, needs live N≥10 per D030 §3k, real quota | 9/10 — pure/sync, unit-testable against the 12 captured real cases at zero cost |
| Regression risk | 4/10 — a new section competes for attention with the existing `QUALIFIED RANK` section (§3c) | 6/10 — a fourth gate stacking on three buggy ones adds interaction surface |
| Precedent in this codebase | 5/10 — §3c is prompt-shaped, but D031's backstops are gate-shaped | 6/10 — right family, but D030 §3n refuted 4/4 gate fixes at the simulation step |
| **Total** | **14/50** | **32/50** |

**Neither was adopted.** A is disqualified outright: changing a prompt whose output was correct
50/50 is a behaviour change with no defect to justify it, and it would be verified against the very
gates that are actually broken. B is directionally right but misidentifies the work as additive.

### §9b. Adopted: correct the three existing gates (option C)

Add a **negation-scope check** to the gates in the reason family. Before a gate compares an extracted
claim token against the reason, it must establish that the token is **not inside a negation scope in
the claim**. If it is, the gate **abstains** — which returns VERIFY's own verdict, already correct in
100% of the observed cases.

| Gate | Current trigger | Added precondition |
| --- | --- | --- |
| `reason_year` | claim's single year token ≠ a positively-stated year in reason | claim's year token is not inside a negation scope |
| `reason_ordinal` (FROZEN) | claim's ordinal ≠ reason's ordinal | claim's ordinal is not inside a negation scope |
| `reason_consistency` | contradiction language present in reason prose | claim carries no negation cue **and** the override does not contradict VERIFY's own `supported` verdict |

**Why this scores ~44/50 where A and B did not:** it removes overrides rather than adding
logic — the heuristic surface *shrinks*. It is downgrade-only by construction (a gate that abstains
can never manufacture a verdict). It is testable against 12 captured real repetitions with zero API
cost. And it fixes the layer the evidence actually indicts.

### §9c. Constraints and open items

- **`reason_ordinal` is FROZEN** (D030 §3k). This design requires unfreezing it. **Decided
  2026-08-26: unfreeze, on the freeze's own terms** — D030 §3k's freeze exempts *"a new,
  independently reproduced failure mode"* and explicitly distinguishes that from *"another g17
  miss."* This is a different gate anchor (year/ordinal-token negation-scope, not a reason-phrasing
  variant), independently reproduced (3/10 on a new golden case, not a single g17 draw), and
  structurally different from the churn the freeze was guarding against — a precondition that can
  only *reduce* firings, not a fourth positional exception layered onto the existing three. See
  D030 §3k, amended entry recording this.
- **`reason_consistency` needs a trust-ordering decision, not just a regex.** Its real defect is
  preferring fallible reason prose over VERIFY's own verdict. Narrowing it to "abstain when the claim
  is negated" fixes the measured cases; the general question — should a prose-driven gate *ever*
  override an explicit verdict toward `contradicted`? — is the §3k architectural observation and is
  deliberately left open here.
- **Negation detection must be conservative, not complete.** Litotes, double negation, and "not
  only… but" are out of scope; the predicate should abstain when unsure. Under-firing costs detection
  (safe side); over-firing costs a false accusation (unsafe side). D030 §1's ban on hand-maintained
  keyword whitelists over free English applies to *claim-text semantics*, not to detecting a closed
  set of negation cues in the claim's own surface form — but the predicate stays small and its
  false-positive behaviour is the thing to test.
- **Simulate before implementing** (D030 §3n). The 12 captured repetitions plus all historical
  `reason_year`/`reason_ordinal`/`reason_consistency` firings in `grounnel_gate_events` are the
  simulation corpus: the fix must clear the 12 and must not gut the gates' legitimate firings. This
  step killed 4/4 `subject_entity` fixes and is not optional here. **Result (2026-08-26): of 109
  historical `overridden=true` firings, exactly 31 change — the negated-claim set, all from T10's own
  measurement, all confirmed false accusations. The other 78 are untouched**; verified by isolating
  the new guard's claim-text-only precondition from a confound in the replay itself (retry/escalation
  can rewrite `grounnel_claims.reason` after a gate ran, so replaying against the *final* stored
  reason is unreliable for the general historical corpus — exactly this section's own documented
  caveat, reproduced directly during this replay).
- **Review finding, fixed: negation must be checked in both directions.** The first implementation's
  `isNegatedAtPosition` only scanned backward from the extracted token, so it caught "did not end in
  1943" but missed the equally natural postposed phrasing "1943 is not the year it ended" — the exact
  same bug, undetected. `reason_year`/`reason_ordinal` now use a bidirectional
  `isClaimTokenNegated`, scanning forward via the file's existing `firstClauseBoundaryForward`
  helper too. `isNegatedAtPosition` itself is untouched and still backward-only at its four
  pre-existing call sites (reason-side checks, value-negation filtering) — deliberately not widened
  there, to avoid changing already-tested behaviour outside this fix's scope.
- **Review finding, accepted as a documented gap, not fixed: `reason_consistency`'s presence-only
  check can suppress a genuine, unrelated contradiction.** Unlike `reason_year`/`reason_ordinal`,
  this gate has no single extracted claim token to scope a check around — it abstains on ANY
  negation cue anywhere in the claim. Concrete counter-example: claim *"The unarmed suspect, who did
  not resist arrest, was taken into custody in 1990"* with reason correctly contradicting the 1990
  date — the unrelated "did not resist" now suppresses that catch too. This is safe-side (lost
  detection, not a manufactured accusation — the same asymmetry the Cardinal Rule already accepts
  elsewhere) and rests on EXTRACT's atomicity rule (a compound claim like this should already have
  been split before reaching VERIFY) — a rule that is prompt-level, not code-enforced, so the gap is
  real, not hypothetical. Documented with a test (`gates.test.ts`, "known gap" case) rather than
  silently left implicit. Not fixed here: a precise fix needs either parenthetical/relative-clause
  stripping (comma-scoped, risks new bugs of its own — a bare comma also appears in legitimate
  non-parenthetical claims like "ended in 1945, not 1943") or the trust-ordering redesign this
  section already left open above. Revisit together if `reason_consistency` is ever redesigned.

## §10. New finding (2026-08-26, SC-5 regression run): `SELECTOR_RE_G` matches "second" inside "12-second"

Found incidentally while running T12's SC-5 regression subset (not caused by T12 — see below).
`g23-confidence-floor-despite-agreeing-reason` produced a real false accusation: `contradicted` on
the true claim *"The Wright brothers' first successful powered flight lasted 12 seconds."*

**Mechanism.** `instance-selector.ts`'s `SELECTOR_RE_G` is
`` \b(first|second|third|...|tenth)\b(?!-to-) ``. `\b` is a zero-width transition between a word
character and a non-word character — a hyphen is non-word, so `\b` fires on **both** sides of it.
VERIFY's reason described the flight as *"the Wright brothers' 12-second flight"* — the regex reads
`second` out of `12-second` as if it were the ordinal word, not the duration unit. That spurious
match then anchors against the claim's real `first` via `ordinalAnchorWords` (both share "flight"),
`applyReasonOrdinalGate` treats `first` vs `second` as a competing ordinal, and forces `contradicted`
on a claim the reason never actually disputed.

**Confirmed NOT a T12 regression.** `isClaimTokenNegated` correctly found no negation on this claim
(there isn't one) and returned `false`, so T12's new guard took no action — control reached the
*unmodified* downstream matching logic that has contained this bug all along. Reproduced directly:
`[...claim.matchAll(SELECTOR_RE_G)]` → `first`; `[...reason.matchAll(SELECTOR_RE_G)]` → `second` (at
the position inside `12-second`). This class of bug (a hyphenated compound reading as a bare
sequence word) could fire identically with or without T12's change, on any reason phrasing that
happens to name a duration as "N-second"/"N-third" etc.

**Scope note.** `reason_ordinal` is the FROZEN gate (D030 §3k). This is a **different, independently
reproduced failure mode** from both the original phrasing-whack-a-mole class the freeze targeted and
from T12's negation-scope class — a tokenization bug, not a comparison-logic bug. Not fixed here;
recorded so it isn't lost and isn't mistaken for a T12 defect if it recurs. Candidate fix (not
implemented): exclude a selector-word match immediately preceded by a hyphen and a digit (the
"N-second"/"N-third" shape specifically), the same narrow, evidence-driven scoping this file's other
positional exceptions use — not a general prose-parsing fix.

## §11. T5/T6/T6b implemented (2026-08-26) — Phase 2, `excluded` verdict

**T5 — `excluded` added to `GrounnelVerdictEnum`.** Resolves spec Open Question 3 in favour of an
enum value, not a separate `status` field: matches the spec's own cited `retry_decision` precedent,
and the frontend (D032 §7 Q3/T2) already only switches on `verdict`, so a new field would be a
bigger frontend lift than one new enum case. Declaration sites: `contracts/grounnel.schemas.ts`,
`db/schema.ts` (`grounnelClaims.verdict`), `db/queries.ts` (`insertGrounnelClaim`),
`persistence/grounnel-history-store.ts`. Deliberately **not** touched: the unrelated audit-pipeline
verdict enum (`claims.verdict`, `verify.service.ts`, `audit-store.ts` — a different feature,
`specs/008-b2b`), and `grounnel_gate_events.verdictBefore/verdictAfter` stays untouched in *runtime
behaviour* (widened only for type-parity, since no gate event can ever fire for an excluded claim —
`writeExcludedClaim` bypasses the gate chain entirely). **No DB migration** — confirmed via
`pnpm db:generate` → "No schema changes, nothing to migrate": `verdict` is a plain Drizzle
`text(..., {enum:[...]})` column, a TypeScript-level convenience with no SQL CHECK constraint.

**T6 — `writeExcludedClaim` persists `excluded`, not `unverifiable`.** Also updated the eval
harness's `ACCEPTABLE` mapping (`grounnel-live-gate.ts`): `kind: "excluded"` now expects verdict
`excluded`, closing the exact ambiguity D030 §3b's FR-008 named. And `grounnel-store.ts`'s score
computation: `excluded` claims deliberately have no bucket and are excluded from `eligible` — a
claim never searched was never eligible for verification. This is a genuine (small) behaviour
change from before T6, when excluded claims were miscounted into `unclear_n`/`eligible`, diluting
`grounded_pct` with claims that were never checked at all.

**T6b — `subject_entity` downgrades get a distinguishing `reason` suffix**, not their own verdict
(minimum viable form, per the task's own acceptance). New `labelSubjectEntityDowngrade` appends a
note when `unverifiable` came from `subject_entity`, distinct from a genuine no-evidence
`unverifiable` (D032 §3f's 24.9% slice).

### Two real bugs, both caught by `/code-review medium` before shipping, both fixed

1. **Composition order produced self-contradictory text.** The first implementation ran the D031
   ungrounded-affirmative rewrite (which replaces an affirmative-sounding reason with "no evidence
   found" when `citationsCount === 0`) unconditionally, then appended T6b's "evidence was found"
   suffix after it — on the *same claim*. The bug: `subject_entity` also nulls `evidence` (hence
   `citations`), so `citationsCount === 0` holds for subject_entity downgrades too — the D031
   rewrite's own precondition does not exempt this case, contrary to what the first draft's comment
   claimed. Any subject_entity downgrade whose original VERIFY reason was affirmative (the normal
   case — it justified the pre-downgrade `supported` verdict) produced a reason claiming both "no
   evidence was found" and "evidence was found" in the same sentence. **Fixed** by extracting the
   combination into `composeUserFacingReason` (`gates-reason-grounded.ts`): subject_entity now takes
   precedence outright — if it fired, the D031 rewrite never runs at all.
2. **Read the wrong gate-events array — stale across a retry.** The write site used `gateEvents`
   (the pass-concatenated trail, `firstPass` + `retryPass` events together), when it needed
   `currentPassGateEvents` (reset per retry) — the same distinction `originatingContradictionGate`
   already exists to enforce, for the identical reason. A claim whose first pass triggered
   subject_entity *and* a retry, whose retry then landed on `unverifiable` for a genuinely different
   (no-evidence) reason, would have wrongly inherited the stale subject_entity label — exactly the
   ambiguity T6b exists to eliminate, reintroduced by pass-staleness. **Fixed**: reads
   `currentPassGateEvents`.

Both were caught by the diff-review pass before any deploy — not found live. 3 new unit tests added
(`composeUserFacingReason`'s own describe block) reproduce the exact precondition that hid bug #1
(`citationsCount: 0` alongside an affirmative reason and a `subject_entity` event).
