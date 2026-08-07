# D024 — Grounnel Search Escalation and Multi-Source Evidence

## §1. Trigger

Two real findings from this session's live-eval investigation (g11-bloomberg-fallback, both the original and the `searchEngine: "tavily"`-forced variant):

1. **Search depth is capped low and never escalates.** DIY fetch tries exactly 3 Gemini-suggested candidate URLs (`MAX_CANDIDATES = 3` in `hybrid-provider.ts`), hard-sliced from whatever `groundingChunks` Gemini's grounding search returned — even if Gemini returned more than 3 candidates, only the first 3 are ever looked at. If all 3 fail, the *only* fallback is a single Tavily call for 3 more results (`MAX_RESULTS = 3` in `tavily-provider.ts`). If those 3 also don't contain what's needed, there is no further escalation — the pipeline just proceeds with whatever it has (possibly nothing usable). Confirmed by reading both files directly; no retry-with-more-candidates logic exists anywhere today.

2. **Tavily is requested at its cheap/shallow tier.** `tavily-provider.ts` never sets `search_depth`, so the Tavily API defaults to `"basic"` — a fast, shallow tier, versus `"advanced"` (deeper content extraction, better relevance for a specific buried fact, more expensive per call). This is a real, verified reason the forced-Tavily golden case (g11) returned real-but-outdated content instead of the specific fact needed.

3. **Only one source per claim ever reaches VERIFY.** `resolveEvidence` in `pipeline.service.ts` picks the *first* `"ok"` source and stops (`sources.find(s => s.status === "ok" && s.text)`) — even when a second, third, or later candidate in the same batch also succeeded. VERIFY only ever sees one passage per claim, so there is no cross-validation and no resilience against a single bad/incomplete source.

## §2. Decision (planned — not yet implemented, see tasks.md T029+)

**Escalating DIY search, in waves, stopping as soon as a wave succeeds:**
- Wave 1: first 3 candidates (unchanged from today).
- Wave 2 (only if wave 1 yields zero `"ok"` sources): next 5 candidates (cumulative 8 attempted).
- Wave 3 (only if wave 2 also yields zero `"ok"` sources): next 8 candidates (cumulative 16 attempted).
- If Gemini's own `groundingChunks` doesn't have enough candidates to fill a wave, fetch however many exist — never treat a short list as a failure to retry.
- Only after all three waves are exhausted with zero `"ok"` sources does Tavily fallback fire (unchanged trigger condition, just a later one).

**Tavily gets `search_depth: "advanced"`** — directly addresses finding #2. Cheap, one-line, no escalation logic needed for Tavily itself at this stage (revisit only if `"advanced"` alone doesn't close the gap).

**Multi-source evidence — "2 proofs better than one":** when a wave succeeds, don't stop at exactly one `"ok"` source if more than one is available in that same wave — collect up to 2. VERIFY's payload shape changes from one passage per claim to up to 2 passages per claim; VERIFY's prompt and output schema need to account for evaluating a claim against more than one passage (e.g., "supported" if either passage supports it, "contradicted" if either conflicts, with the reason naming which passage). This is the part of this decision most likely to need its own sub-round of prompt iteration once built — flagged here, not resolved here.

**Provenance storage** — `grounnel_search_calls` already logs one row per attempted source (D023 §6), which already gives an array. Add two columns: `wave` (integer — which escalation wave this attempt belonged to) and `usedAsEvidence` (boolean — whether this specific source became one of the (up to 2) passages actually sent to VERIFY, vs. attempted-but-unused). This answers "how often do we need wave 2/3" and "how often did 2 sources actually get used" as a SQL query, not a guess.

## §3. Why this is its own ADR, not folded into an existing one

This is a materially larger change than D021 (DIY-fetch-with-fallback) amends cleanly:
- `resolveEvidence`'s return shape changes from `passage: SearchPassage | null` to a small array, a breaking change to every downstream consumer (`hasPassage`, `runBatch`, all four gates that currently take a single `passageText`).
- VERIFY's prompt and output schema both need to represent "evaluated against up to 2 passages," not one — a real prompt-design problem, not just a code change (prompt version bump, likely needs its own validation pass against a real model, matching this repo's own "UNVALIDATED as of this commit" convention for prompt changes).
- Gate #1 (`applyContradictionEvidenceGate`) currently checks evidence against exactly one `passageText`; with multiple passages, it needs to check against whichever passage actually contains the grounding text, not just concatenate them (concatenation would break the ellipsis-fragment logic just added in the same session's earlier fix).

## §4. Explicitly out of scope for the first implementation

- No escalation on Tavily's own result count beyond `search_depth: "advanced"` — a second Tavily call (different query phrasing, or raising `max_results`) is a possible future escalation, not built now.
- No change to `MAX_CANDIDATES`/wave sizes being user-configurable — the 3/5/8 ladder is a fixed constant, matching this codebase's existing convention for `BATCH_MAX`/`SEARCH_CONCURRENCY`/etc.
- No retry escalation on VERIFY itself (this decision is entirely about search/evidence-gathering, not the VERIFY LLM call's own retry behavior, which `callLlmForJson`'s `attempts` already covers separately).

## Consequences

- Real cost/latency increase on claims that don't succeed in wave 1 — up to 16 DIY fetch attempts instead of 3, before ever reaching Tavily. Acceptable trade-off for a fact-checking tool where accuracy matters more than raw speed, but worth watching once real volume exists (a metric worth adding: "% of claims needing wave 2/3" — the `wave` column above gives this directly).
- `resolveEvidence`/`ResolvedEvidence`/`hasPassage`/gate signatures all change — every call site and every existing gate unit test touching `passageText` needs updating, not just new tests added.
- VERIFY prompt version bumps again (already at 2.1.0 as of this session) — needs the same "UNVALIDATED against a real model" caveat and staged rollout this repo already applies to prompt changes.
