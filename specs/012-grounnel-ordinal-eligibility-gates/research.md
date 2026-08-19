# Phase 0 Research: Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering

No `NEEDS CLARIFICATION` markers were left in the Technical Context — this is an existing,
established codebase (not greenfield), and the two open design questions this feature depends on
were already resolved through direct investigation and two rounds of review, captured in
[D030](../../docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md).
This document summarizes that research in the Decision/Rationale/Alternatives format for traceability.

## Decision 1: Detect ordinal contradictions by reading VERIFY's `reason` field, not raw evidence

**Decision**: `applyReasonOrdinalGate` extracts ordinal facts from the model's own natural-language
explanation (`reason`), never from the raw fetched evidence text or the VERIFY prompt.

**Rationale**: Directly reading the live VERIFY prompt (`src/prompts/grounnel/verify/system.json`
v4.4.0) confirmed a plausible prompt-side contributor — the `MULTIPLE SOURCES` section's carve-out
("if sources disagree... evaluate against the strongest, most on-point sentence") gives the model
explicit license to discard a source naming the correct ordinal in favor of one that's merely
silent. But `gates.ts` already has a shipped, live-verified precedent for this exact failure shape:
`applyReasonYearGate` (T069), which fixed an analogous asymmetric-source year bug (Pluto
reclassification) by reading only `reason`, regardless of why the raw verdict was wrong. In every
observed failure case across both bug classes (Wright brothers ordinal, Pluto year, COBOL/Hopper
attribution), the model's own `reason` field independently and correctly named the true fact — the
verdict was wrong, the reasoning wasn't. That makes "read the reason" a bounded string-matching
problem instead of an unbounded evidence-parsing one.

**Alternatives considered**:
- *Fix the `MULTIPLE SOURCES` prompt instruction directly.* Rejected as the primary fix (though not
  ruled out as a future follow-up) — the reason-grounded gate neutralizes the downstream effect on
  the stored verdict regardless of the prompt-side root cause, and a prompt-only fix for the sibling
  `SEQUENCE POSITION` case already failed live 2/2 in an earlier attempt.
- *A new general-purpose `checkClaimReasonConsistency` LLM classifier* covering all contradiction
  types in one call. Rejected for now — the deterministic, per-type gate pattern is zero-LLM-cost
  and has a live track record; revisit only if per-type gates start proliferating faster than new
  failure classes actually recur.

## Decision 2: Ordinal extraction is claim-anchored, not a global role-noun whitelist

**Decision**: The gate derives the noun a claim's ordinal attaches to directly from the claim text
itself (e.g. "flight" out of "the first flight covered 852 ft"), then searches `reason` only for a
competing ordinal attached to that same anchor — rather than matching against a fixed vocabulary of
role-nouns decided in advance.

**Rationale**: The original `applyOrdinalGate` (built, unit-tested, never wired in, ultimately
deleted — tasks.md Phase 35) used exactly the rejected approach: a hand-maintained
`ROLE_KEYWORDS`-style whitelist of nouns ("flight"/"attempt"/"round"/"edition"/"trial"/"place"/
"position"). The sibling year-gate's own whitelist (`ROLE_KEYWORDS`) independently proved this
structurally capped — a live case used "redesignated"/"downgraded" for an event the whitelist only
recognized as "reclassified," and the gate silently abstained. A whitelist "can only ever cover
phrasings someone has already noticed in a bug report" (tasks.md Phase 35's own conclusion).
External design review additionally flagged that ordinal words are semantically ambiguous in a way
years are not: "first"/"second" are equally likely to be discourse structure ("First, the source
says X. Second, it says Y.") as a factual attribute of an event — so extraction can't just port the
year-gate's token-scanning logic unmodified; it needs to establish a shared anchor before comparing.

**Alternatives considered**:
- *Reuse `applyReasonYearGate`'s extraction logic near-verbatim*, swapping the year regex for an
  ordinal regex. Rejected — years are context-free 4-digit tokens; ordinals are not, and this would
  misfire on discourse enumeration (see the false-positive matrix in D030 §3a and `data-model.md`
  below).
- *A global ordinal role-noun whitelist* (porting `applyOrdinalGate`'s deleted approach to scan
  `reason` instead of evidence). Rejected — same structural ceiling as the two whitelists that
  already failed; claim-anchored attachment avoids needing one at all.

## Decision 3: No generic `applyReasonFactGate<T>` yet

**Decision**: `applyReasonOrdinalGate` is implemented as its own policy function. Only genuinely
common, already-existing mechanics (the negation check, the key-term-overlap helper combination
`applyClaimReasonOverlapGate` already exposes) are shared as small helpers — not a unifying generic
type across year/ordinal/future fact types.

**Rationale**: Two instances (year, ordinal) that turn out not to be structurally identical (§Decision
2) is not enough evidence for a shared abstraction — per this repo's own anti-premature-abstraction
convention (AGENTS.md "Forbidden: Premature abstractions"). A shared interface today would either
leak ordinal-specific claim-anchoring logic through a "generic" API, or force year-extraction into
complexity it doesn't need.

**Alternatives considered**:
- *Design the generic interface now, anticipating a third fact type (currency/percent/entity).*
  Rejected — no third instance exists yet to prove the interface's shape is right; revisit only once
  one does.

## Decision 4: Claim eligibility is an LLM classifier, additive to and running after the existing
regex filter

**Decision**: `classifyClaimVerifiability` is a new LLM call, not an extension of `isOpinionClaim`'s
regex set. It runs *in addition to* the existing filter, and specifically *after* it in the
EXTRACT→search pipeline — the cheap, deterministic, already-validated regex filter gets first look
at every claim; the LLM classifier only ever evaluates claims the regex didn't already catch.

**Rationale**: Per AGENTS.md rule #12 ("prefer LLM judgment over regex for semantic/contextual
checks"), which itself is grounded in two prior incidents in this codebase where a growing regex
list failed to generalize (an injection-guard false positive, and this same VERIFY pipeline's own
year/ordinal gates hitting the same wall from the evidence side). Recognizing "this is a private
statement the system can't reasonably verify externally" is exactly the class of problem regex
structurally can't solve — a naive `\bI\b` regex was considered and rejected during design because
it would false-positive on legitimate checkable claims using first person in an attributed quote.

Running the regex first (rather than the originally-drafted ordering, LLM-first) is a pure cost
optimization with no correctness downside: both mechanisms independently produce the same
`unverifiable` outcome when they fire, so order doesn't change *what* gets excluded, only whether an
LLM call gets spent on a claim ("the movie was terrible") the free regex would have caught anyway.

**Two design points sharpened during review, not present in the initial draft**:
- **`personal` is not synonymous with non-checkable.** "I was born in 1987," "I served as CEO from
  2015 to 2020" are first-person but plainly verifiable if the speaker is a public figure. The
  classifier's actual question is whether a claim is reasonably verifiable through external
  evidence, not whether it uses first-person grammar — see `data-model.md` §2's category semantics.
- **The classifier needs source context, not just claim text**, to make that distinction at all —
  `"I discovered X in 1928"` and `"I discovered X in 1928," said Fleming` are the same claim text
  with opposite answers. `sourceExcerpt` (already produced by EXTRACT, D028) is the input that makes
  the distinction possible; claim text alone cannot.

**Alternatives considered**:
- *Add a fourth regex to `isOpinionClaim`.* Rejected — first-person/personal-circumstance detection
  requires contextual judgment ("I discovered X in 1928" vs. `"I discovered X," said Fleming`), not
  a fixed pattern.
- *Replace `isOpinionClaim` entirely with the LLM classifier.* Rejected — the existing regexes are
  free and already reliable for their narrow categories (value judgments, vague intensifiers, hedged
  predictions); no reason to pay LLM cost for cases already caught cheaply.
- *Classify from claim text alone, no source context.* Rejected during review — a classifier with no
  way to see attribution/quoting context cannot distinguish a private assertion from an attributed
  quote using identical wording; it would either over-exclude (treat all first-person claims as
  private) or under-exclude (never catch anything with any ambiguity), neither acceptable given
  FR-007's asymmetric cost of false exclusion.
- *Raw `0.0–1.0` confidence score driving the exclusion decision via a threshold.* Rejected — an
  uncalibrated LLM probability doesn't have a principled cutoff, and "exclude when unambiguous" was
  left undefined against it. Replaced with an explicit `certainty: "clear" | "uncertain"` field the
  classifier states directly (`data-model.md` §2).
