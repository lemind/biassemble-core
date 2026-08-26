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

### §3b. Confidence carries no information

| Verdict | n | mean confidence | min |
| --- | --- | --- | --- |
| `supported` | 29 | 0.993 | 0.9 |
| `contradicted` | 6 | 1.000 | 1.0 |
| `unverifiable` | 6 | 0.975 | 0.9 |
| `unsupported` | 3 | 0.967 | 0.9 |

Minimum confidence across all 44 claims is **0.9**; `CONFIDENCE_THRESHOLD` is 0.6, so it never
fires. The single false affirmation (§4 case 1) carried high confidence like everything else.

**Consequence: any remedy keyed on confidence is dead on arrival.** This retrospectively explains
D030 §3n's Option A — "skip the downgrade when the verdict is confident and cited" suppressed 124 of
132 historical firings precisely because confidence and citation-presence are near-constant. The
threshold mechanism itself is currently dead weight and should either be removed or re-grounded on
something with variance.

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
below. The failure is superlative-scope reasoning, compounded by a reranker that rewards lexical
density over source authority.

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
| 1 | "First computer mouse was wireless" → `supported` | **VERIFY** | Superlative-scope conflation: *"the first wireless mouse"* read as support for *"the first mouse was wireless."* Refuting sources were retrieved but ranked lower (§3c). Only false affirmation in 44. | No clean candidate. Prompt hardening on superlative scope, or a new gate comparing the claim's superlative anchor against the evidence's. Neither designed. | **Low.** Same shape as `subject_entity`, where 4/4 candidate fixes were refuted. Needs N≥10 repeats to establish it is stable, not a single unlucky draw. |
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

| Item | Why it qualifies |
| --- | --- |
| `excluded` verdict value (#8/#9) | No LLM behaviour; correct pipeline decision is already being made and merely mis-stored. Verify frontend `reason` handling first — may already be solved there. |
| Prediction exclusion (#7) | One line. Gate on measuring `prediction` misclassification rate, since it reverses a documented policy. |
| Remove or re-ground `CONFIDENCE_THRESHOLD` (§3b) | Currently dead code — never fires, and its existence invites confidence-keyed remedies that §3b shows cannot work. |

### Rework candidates (premise is the problem, not the parameters)

**R1 — Symmetric refutation (covers #2, #3, #4).** Not a bug fix: the pipeline has no
disconfirmation path at all. Adding one is a genuine architectural addition, and it must be
designed against the false-accusation asymmetry from the start — a refutation stage that produces
`contradicted` verdicts is the highest-risk component this system would contain. Prerequisite:
decide whether a confidently-false-but-unsupported claim *should* read `contradicted`, or whether
`unsupported` is the honest answer and the real defect is only that users can't tell the two apart.

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

**R4 — Reranking (contributes to #1).** Ranks a listicle above SRI/DARPA on the one claim that
produced a false affirmation, while consuming token budget comparable to VERIFY itself (§3c, §3e).
Whether source authority belongs in ranking is a real design question and is currently unmeasured —
one case is not evidence. Listed as a candidate for *investigation*, not for change.

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
   future measurement.
2. **Should a confidently-false, unsupported claim read `contradicted`, or is `unsupported` correct
   and the real gap a user-facing one?** Determines whether R1 is needed at all.
3. **Does the frontend already distinguish exclusion via `reason`?** Determines whether #8/#9 is a
   real change or a non-issue. Not answerable from this repo.
