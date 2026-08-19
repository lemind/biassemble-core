# Feature Specification: Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering

**Feature Branch**: `012-grounnel-ordinal-eligibility-gates`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Grounnel reason-grounded ordinal contradiction gate + claim-verifiability pre-filter. Based on docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md (D030). Two fixes: (1) applyReasonOrdinalGate — a new deterministic gate in gates.ts that detects ordinal/sequence-position contradictions by reading VERIFY's reason text, anchoring the ordinal to the noun it attaches to in the claim, negation-aware, contradicted-only/one-directional, validated offline against a false-positive matrix before being wired into runGateChain. (2) classifyClaimVerifiability — a new LLM pre-filter between EXTRACT and search that classifies each claim as checkable/personal/opinion/prediction, conservatively excluding only on a clear non-checkable call, sitting ahead of the existing isOpinionClaim regex filter which stays unchanged."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Catch sequence-position contradictions before they're reported as confirmed (Priority: P1)

A reader submits an article containing a claim about a specific position in a repeated sequence
of events (e.g., "the first flight covered 852 feet"). The evidence gathered actually supports
those numbers for a *different* position in the same sequence (e.g., the fourth and final flight).
Today this is reported back to the reader as a confirmed, supported fact — the pipeline's own
verification step correctly identifies the mismatch in its explanation, but still reports the claim
as supported anyway.

**Why this priority**: This is a live, reproduced correctness bug that has already shipped a wrong
answer to real users twice in testing — not a cosmetic issue. This pipeline's own stated core
principle is that a false "confirmed" is worse than a false "not found," so a verdict this wrong is
the highest-severity class of defect it can produce.

**Independent Test**: Submit an article containing a claim about a specific position in a sequence
where the gathered evidence attributes the same measurement to a different position. Confirm the
claim is not reported as supported or partially supported.

**Acceptance Scenarios**:

1. **Given** a claim asserting a fact about a specific position in a sequence, **When** the
   verification step's own explanation names a different, explicitly stated position for the same
   underlying fact, **Then** the stored verdict for that claim must not be "supported" or "partially
   supported."
2. **Given** a claim and a verification explanation that agree on the same sequence position,
   **When** the claim is processed, **Then** the existing verdict is left unchanged — agreement
   never manufactures additional confidence.
3. **Given** a verification explanation that uses sequence-position words only to list separate,
   unrelated observations (not to describe the same fact twice), **When** the claim is processed,
   **Then** the verdict is left unchanged and no contradiction is reported.
4. **Given** a verification explanation that negates an incorrect sequence position before stating
   the correct one (e.g., "it was not the first... it was the fourth"), **When** the claim is
   processed, **Then** the contradiction is still correctly detected.

---

### User Story 2 - Distinguish "can never be checked" from "checked and found nothing" (Priority: P2)

A reader submits an article containing a first-person statement about the author's own private
circumstances or opinions (e.g., "I was in need of a new laptop that should hopefully last me for a
while"). This isn't something the system could reasonably verify through external evidence. Today it's reported the same way as a
claim that genuinely was searched for and came up empty, which reads to the user as "we looked and
found nothing" when in fact this was never something that could be looked up at all.

**Why this priority**: Real, user-reported confusion, but not a wrong-answer bug — the current label
isn't factually incorrect, only misleading. Lower severity than a false "confirmed" verdict.

**Independent Test**: Submit an article containing a first-person statement about the author's
private circumstances or personal opinion. Confirm it is labeled as inherently non-checkable rather
than "no evidence found."

**Acceptance Scenarios**:

1. **Given** a claim describing the author's own private circumstances that the system has no
   reasonable way to externally verify, **When** the claim is processed, **Then** it is labeled as
   non-checkable rather than reported as "unsupported."
2. **Given** a claim that uses first-person phrasing but is a checkable, attributed statement (e.g.
   a quoted historical claim: `"I discovered the vaccine in 1928," said Fleming`, or a first-person
   claim about a public figure the article is about, e.g. "I was born in 1987"), **When** the claim
   is processed, **Then** it still goes through normal fact-checking, not exclusion — being
   first-person is not itself a reason to exclude a claim.
3. **Given** a claim the classification step is uncertain about, **When** the claim is processed,
   **Then** it defaults to normal fact-checking rather than being silently excluded.
4. **Given** a claim already caught by the existing opinion/prediction detection, **When** the claim
   is processed, **Then** it is excluded via that existing mechanism unchanged — the new check does
   not need to also catch it, and does not replace it.

---

### Edge Cases

- What happens when a claim references more than one sequence position (e.g., "the second of the
  first three attempts")? Ambiguous cases must not force a contradiction without a single, clear
  anchor to the claim's own asserted fact.
- How does the system handle a verification explanation with no usable prose (a parsing or provider
  failure)? Both new checks must abstain rather than guess; existing failure handling is unaffected.
- What happens when a claim is both an opinion and separately contains a sequence-position
  reference? Eligibility filtering runs first — such a claim is excluded before it would ever reach
  search or the contradiction check.
- How does the system handle a personal-sounding claim that is actually independently checkable
  through public record (e.g. a public figure's well-documented personal history)? It must default
  to checkable; exclusion is reserved for circumstances the system has no reasonable way to verify —
  first-person phrasing alone is never sufficient grounds to exclude a claim.
- How does the classifier distinguish a private first-person assertion from an attributed quote using
  the same words (e.g. "I discovered X" vs. `"I discovered X," said Fleming`)? It needs the claim's
  surrounding source context, not claim text in isolation — see FR-006.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST compare a claim's asserted sequence position against any different
  sequence position stated in the verification step's own explanation for the same underlying fact,
  and prevent a "supported" or "partially supported" verdict from being stored when a genuine
  contradiction is found.
- **FR-002**: The contradiction check MUST NOT be usable to move a verdict toward "supported," and
  MUST NOT alter a verdict that is already "contradicted" or "not checkable." Applied to any other
  verdict, including "unsupported," it MAY force the verdict to "contradicted" when a genuine
  contradiction is found — this is a one-directional override, not necessarily a "downgrade" in the
  everyday sense (moving from "unsupported" to "contradicted" adds information, it doesn't weaken
  it).
- **FR-003**: The contradiction check MUST NOT fire when multiple sequence-position words in the
  explanation describe separate, unrelated observations rather than the same fact twice.
- **FR-004**: The contradiction check MUST correctly handle negated statements ("it was not X, it
  was Y") without misreading the negated value as the stated fact.
- **FR-005**: The contradiction check MUST be validated against a documented set of test cases —
  including cases that must trigger it and cases that must not — before it is enabled in the live
  verification flow.
- **FR-006**: The system MUST classify each extracted claim's checkability — checkable vs. not
  reasonably verifiable through external evidence available to the system (private personal
  circumstance, opinion, or vague prediction) — before spending search or verification effort on it.
  This classification MUST use the claim's available source context (not claim text alone), since
  distinguishing a private personal statement from a publicly attributable one is a context-dependent
  judgment — the same wording ("I was born in 1987") can be either, depending on who is speaking and
  how the source frames it.
- **FR-007**: The eligibility check MUST only exclude a claim from search/verification when the
  classification is clearly non-checkable; any ambiguous or uncertain case MUST proceed to normal
  fact-checking. A first-person claim MUST NOT be treated as inherently non-checkable — whether it's
  excluded depends on verifiability, not on grammatical person.
- **FR-008**: A claim excluded for being inherently non-checkable MUST be labeled distinctly from a
  claim that was checked but had no evidence found, so a reader of the report can tell the
  difference.
- **FR-009**: The existing, narrower opinion/prediction detection MUST continue to operate unchanged
  and MUST NOT be replaced by the new eligibility check.
- **FR-010**: Both new checks MUST be measured against a golden test set — including hard-negative
  cases designed to catch over-exclusion or false contradiction — before being relied on for live
  reporting.

### Key Entities

- **Claim**: an individual factual assertion extracted from a submitted article; carries claim text,
  an eligibility classification, and (once checked) a verdict.
- **Verification Explanation**: the natural-language rationale produced alongside a verdict during
  fact-checking; used as an input signal for the contradiction check, but never treated as
  automatically true on its own — only an explicit, localized contradiction with the claim carries
  weight.
- **Verdict**: the stored per-claim outcome (e.g., supported, partially supported, unsupported,
  contradicted, non-checkable).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The specific real-world case that originally exposed the sequence-position bug no
  longer produces a "supported" verdict when re-run.
- **SC-002**: Zero false downgrades occur across the built-in validation set's true-positive
  (correctly-supported) cases, and 100% of the built-in "must trigger" contradiction cases are
  caught, before the check is enabled live. In addition, on a held-out set of correctly-supported
  claims not used to build the fixture set, the false-downgrade rate is zero (hard requirement) and
  the contradiction-detection recall rate is reported (measured, not required to reach 100% —
  100% on a fixture set the implementer built is not evidence of generalization by itself).
- **SC-003**: A private/personal statement the system has no reasonable way to externally verify is
  labeled distinctly from "no evidence found" in the resulting report, confirmed against the real
  user-reported example that surfaced the gap.
- **SC-004**: On a held-out set of checkable claims that happen to use first-person phrasing
  (including claims about public figures and attributed quotes), the false-exclusion rate is zero —
  this is the primary safety metric for this check, since wrongly excluding a checkable claim is the
  more dangerous failure direction than searching one that turns out unverifiable anyway.
- **SC-005**: Both checks pass 100% of their respective built-in validation test sets ("must
  trigger" and "must not trigger" cases) before being enabled in the live flow — a release gate, not
  a claim of generalization; SC-002 and SC-004's held-out measurements are what establish that.

## Assumptions

- The verification step's natural-language explanation is not treated as automatically true — only
  an explicit, localized contradiction between it and the claim carries weight. What's assumed is
  narrower: in every real failure case observed so far, when the explanation and the verdict
  disagreed, the explanation was the one that had it right. That's an observed property, not a
  guarantee; revisit if a counterexample is found where the explanation itself is wrong.
- The existing opinion/prediction detection stays in place unchanged; the new eligibility check is
  additive, not a replacement.
- No new evidence sources or search behavior are introduced by this feature — both fixes work
  entirely within the pipeline's existing evidence-gathering and verification steps.
- "Personal circumstance" claims are a distinct category from the "opinion" and "prediction"
  categories already handled — this feature closes that specific gap, not a general rewrite of
  eligibility logic.
- Out of scope: changing the verification step's own instructions/prompting (a related but
  deliberately separate, deferred decision — see D030 §4), and building a general-purpose
  contradiction detector covering fact types beyond sequence position (e.g. numeric, entity, or
  scope mismatches).
