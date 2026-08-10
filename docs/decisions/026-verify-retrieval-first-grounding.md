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

## Consequences

- `verify/system.json` version bumps to 2.3.0 — same "UNVALIDATED against a real model as of this commit" caveat every prior bump carries; a prompt change can't be unit-tested for correctness, only for valid JSON/structure. Real verification is a live-eval re-run.
- No code changes, no schema changes, no new tests beyond confirming the JSON is well-formed and nothing hardcodes the old version string.
- Accepted, explicitly: a residual false-negative rate on this failure class remains, bounded by the existing safety net. Not chasing zero.
