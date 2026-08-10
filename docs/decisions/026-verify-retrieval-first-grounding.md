# D026 — VERIFY Retrieval-First Reordering (Grounding Recall)

## §1. Trigger

A real live-eval failure (g05-statue-of-liberty, 2026-08-10, run `c858ef85-...`) recurred despite v2.1.0 (2026-08-07) already adding an explicit "verbatim-only, never from memory" instruction to the EVIDENCE section for exactly this failure class. Confirmed via `grounnel_gate_events`/`grounnel_llm_calls` telemetry, not guessed: VERIFY's raw output was `verdict: "contradicted"`, `confidence: 1`, `reason: "The passage states the Statue of Liberty was a gift from France, not Canada."` — factually correct — but `evidence` was Wikipedia's well-known opening sentence about the statue, not text from whichever of the three fetched pages (NPS.gov, Wikipedia, a French-culture blog) the model actually received in that call. Gate #1 (`applyContradictionEvidenceGate`) correctly caught this on both the original pass and D025's reconciliation retry (`gate: contradiction_evidence, reason: evidence_not_grounded`, both passes) and safely degraded to `unsupported` — **zero false accusations**, per the eval's own report. The system worked as designed; the model still occasionally answers famous facts from parametric memory instead of the given passage.

## §2. Why this isn't a regression, isn't a gate problem, and isn't a temperature problem

- Not caused by anything in T036 (Gemini schema enforcement, injection-guard fix, or the unrelated TEMPORAL SCOPE addition in v2.2.0) — confirmed by reading the actual gate events; none of those code paths are on this claim's route.
- Not a gate gap: the deterministic substring-grounding check already exists and already fired correctly, twice. This is a **recall** problem (a true claim occasionally goes unconfirmed), not a **precision** problem (nothing false gets asserted) — the prompt's own `CORE PRINCIPLE` ("false positives are worse than false negatives") means this is the intentional, acceptable failure direction, not proof the system is broken.
- Not fixable by a new gate — this is "did the model actually read the given passage or answer from memory," a judgment call, not a fixed pattern (AGENTS.md #12, already applied twice this session to the injection-guard and D025 gate #5).
- Not a temperature issue — VERIFY already runs at `temperature: 0`. This is a parametric-knowledge bias (well-known facts have a stronger memorized association competing with the in-context instruction, counterintuitively making FAMOUS facts *more* susceptible to this than obscure ones), not a sampling-randomness problem.

## §3. Decision — two small, targeted prompt-only changes (v2.3.0)

**Reorder STEP 1** from "identify the passage fact" to explicitly require locating and confirming the exact quote *before* reasoning about the relationship — retrieval-first, not reason-then-justify. Small edit to the existing STEP 1-3 procedure, not a rewrite; matches this file's own established pattern (v2.0.0's decision-table restructuring measurably helped, v2.1.0's additional declarative "never from memory" line only partially did).

**Add a one-line reminder immediately before `CLAIM_PASSAGE_PAIRS:`** — the existing verbatim-only instruction sits mid-prompt, distant from where the actual passages appear in context. A short reminder right at the point of use is a recency nudge, near-zero cost, plausible upside.

## §4. Explicitly out of scope

- `BEGIN/END PASSAGE` banner delimiters — considered, rejected. That pattern targets a single free-text passage block; this pipeline's payload is already JSON (`"passage": "..."`), a harder machine boundary than ASCII banners would add. Not worth a payload-shape change for likely-lower marginal benefit here.
- A model-side self-check pass ("is my quote really in the passage?") — considered, rejected. Strictly weaker than the existing deterministic substring check + retry (which always fires; a self-check is itself just another model output the model could skip or get wrong).
- Any temperature/generation-parameter change — already at 0; doesn't address a bias.
- A new gate, a second retry layer, or any code change — this stays prompt-only.
- Building dashboards/metrics on first-pass-vs-retry grounding recovery rate now — the query is cheap (`grounnel_gate_events` already has everything needed) but not worth building until this recurs at a rate that actually matters. Noted for later, not now.

## §5. Addendum (2026-08-10) — the temporal-scope lesson didn't reach the deterministic numeric gate

v2.2.0 (this same file's own history) taught VERIFY's own reasoning that a narrower-period snapshot doesn't contradict a broader-period threshold claim. It never touched `applyNumericGate` (gate #2, `gates.ts`) — pure code, no LLM involved, which independently compares a claim's number against whatever number appears in `evidence` and forces `supported`/`contradicted` for threshold language ("surpassed", "exceeded") with zero period awareness.

Real recurrence, g11, confirmed via `grounnel_gate_events`: VERIFY's raw verdict was `partially_supported`; gate #2 saw claim "$3.5T" vs. evidence "$3.2T (July 2025)" and forced `contradicted` via pure numeric comparison, oblivious to the mismatched period. A reconciliation retry fired for an *unrelated* reason (gate #5 flagged the original answer), and the retry's evidence happened to come back `null` — gate #2's own `if (!evidence) return no-op` guard is what actually prevented a false accusation, not anything that understood the period mismatch. Had the retry's evidence been non-null, gate #2 would have forced `contradicted` again, and — capped at one retry — that would have shipped as a real false accusation. This was luck, not a fix.

**Decision:** add one new guard to `applyNumericGate` — before any threshold/equality override (either direction), extract years from `claimText` and `evidence` (reusing the year-regex pattern the B2B audit reconciler's `passagePeriodConflicts` already established for the same concern, adapted to read years from free text since Grounnel's `ClaimSchema` has no structured `period` field to feed a direct reuse). If both sides name at least one year and none overlap, the gate abstains — no override, either direction — and existing behavior (same-period or no-year-mentioned claims) is unchanged. Two prompt-consultation sync passes independently converged on this exact shape (comparability as a precondition for *any* override, not a separate asymmetric-direction rule) and both explicitly rejected a new retry path for this: it's a deterministic-logic bug, not a case for asking the model again.

**Explicitly not doing:** narrowing gate #2 to equality-only claims (would remove real, working capability for the common same-period case); an asymmetric-only-toward-"supported" override rule as a separate mechanism (redundant once the comparability guard exists); any new gate in the chain (gate count stays 5) or new retry layer.

## Consequences

- `verify/system.json` version bumps to 2.3.0 — same "UNVALIDATED against a real model as of this commit" caveat every prior bump carries; a prompt change can't be unit-tested for correctness, only for valid JSON/structure. Real verification is a live-eval re-run.
- No code changes, no schema changes, no new tests beyond confirming the JSON is well-formed and nothing hardcodes the old version string.
- Accepted, explicitly: a residual false-negative rate on this failure class remains, bounded by the existing safety net. Not chasing zero.
- §5 addendum: `applyNumericGate` (`gates.ts`) gains one new comparability guard — real code change, unlike §1-4. New unit tests reproducing the exact g11 case plus confirming existing same-period gate #2 tests are unaffected. No schema/DB/prompt change.
