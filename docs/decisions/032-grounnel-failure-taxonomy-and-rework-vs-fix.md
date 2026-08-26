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

**Proposed ratification wording** (all three reviews converged on A; this phrasing is the strongest
of the three, and deliberately broader than "what the text asserts as true" so it covers quotation
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

### §3e. Cost distribution (context for any proposal that adds calls)

128 LLM calls, ~435K tokens, for 44 claims. Reranking alone is 68 calls / 171K tokens — comparable
to VERIFY primary (10 batched calls / 176K tokens). Any new stage competes with reranking for
budget, and §3c suggests reranking is currently mis-scoring the thing it costs the most to do.

## §4. Case-by-case: guilty layer, fix, and confidence in that fix

Ten symptoms; **seven distinct causes** (cases 2/3, 5/6, and 8/9 are each one cause).

| # | Case | Guilty | What happened | Fix | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | "First computer mouse was wireless" → `supported` | **VERIFY** | Qualifier-narrowing conflation: *"the first **wireless** mouse"* read as support for *"the first mouse was wireless."* The modifier changes the referent. Refuting sources were retrieved but ranked lower (§3c). Only false affirmation in 44. | **Extend the VERIFY prompt's existing `QUALIFIED RANK VS ABSOLUTE SUPERLATIVE` section** (see correction below) to cover modifier-narrowed superlatives, not just lesser ranks. Prompt change in an established pattern, not a new gate. | **Medium** (revised up from Low). The prompt already encodes this reasoning class with two worked examples; this is an extension, not a new mechanism. Still needs N≥10 to confirm the failure is stable, and prompt edits are behaviour changes requiring live re-verification. |
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
   future measurement. *Status: all three external reviews independently recommended A. Wording
   proposed in §2. Awaiting the product call — this ADR does not self-ratify.*
2. **Should a confidently-false, unsupported claim read `contradicted`, or is `unsupported` correct
   and the real gap a user-facing one?** *Status: answered — `unsupported` is correct. Two reviews
   converged on the principle that a claim becomes `contradicted` only on affirmative
   counter-evidence, which the Cardinal Rule already implies. R1 is therefore **not built**; the
   remedy is the enriched-`reason` reporting fix in §5, and #4 splits out as its own bounded item.*
3. **Does the frontend already distinguish exclusion via `reason`?** Determines the sequencing (not
   the merit) of #8/#9. Not answerable from this repo.

## §8. Review round (2026-08-26) — what changed and why

Three independent external reviews of the first draft. Corrections applied:

| # | Correction | Verified how | Severity |
| --- | --- | --- | --- |
| 1 | `CONFIDENCE_THRESHOLD` is **not** dead code — it is interpolated into the VERIFY prompt and the model self-applies it, which is *why* min confidence is 0.9. Removal would change behaviour. | Read `src/prompts/grounnel/verify/system.json` + the 4 `grep` call sites. | **High — reversed a "fix now" item.** |
| 2 | The VERIFY prompt **already has** a `QUALIFIED RANK VS ABSOLUTE SUPERLATIVE` section. Case 1 is an *extension* of it (modifier-narrowing), not a new detector. Fix confidence Low → Medium. | Read the prompt. | **High — changed the remedy class.** |
| 3 | Case #4 (negative claims) does **not** belong in R1. Query reframing stays support-seeking and adds no `contradicted` surface. | Reasoning, unanimous across two reviews. | Medium — moves an item from rework to fix. |
| 4 | R1 should **not** be built. `unsupported` is the correct verdict; the gap is reporting. | Cardinal Rule + two reviews. | Medium — closes §7 Q2. |
| 5 | R4 must be investigated **before** R3 — reranker bias bounds how much of case 1 is VERIFY's fault at all. | Ordering argument; rerank scores already persisted. | Medium — reordered the research track. |
| 6 | §3a's zero-firing result must not be read as "gates are useless" or as a licence to optimise hit rate. | Own `contradiction_evidence` counter-example. | Medium — prevents a foreseeable misreading. |
| 7 | Prediction exclusion (#7) is more dangerous than the draft implied; blocked on a held-out misclassification measurement. | Two reviews flagged independently. | Low — tightened an existing caveat. |

Points where the reviews were **not** followed: one review proposed a manual labelling study of
~50 historical `unsupported` claims to decide R1's value. Correction #4 makes R1 moot on principle
rather than on prevalence, so the study would measure something we have already decided not to act
on. A reranker-authority study (R4) is the better use of the same effort.
