# D015 — Three-Way Bias Provenance Tracking (Engine Vector / Engine LLM / Assessment LLM)

## Decision 1: Consume the engine's `source` field, superseding the `retrieval_score=0.0` inference rule

**Decision**: `biassemble-engine` now ships a `source` field on every `BiasResult` in `POST /retrieve-biases` — an **array** of the methods that surfaced each bias: `["vector"]` | `["llm"]` | `["vector","llm"]`, or `null` for `vector_only`/`nli_union` (populated only under `SELECTION_STRATEGY=llm_union`, per contract v3). It is an array, **not** a collapsed `"both"` string, so each contributing engine signal stays individually visible. This is the "clean long-term fix" D014 flagged and deferred (`docs/decisions/014-tiered-context-retrieval.md`, Decision 1: *"The clean long-term fix is for the engine to add a `source` field to each `BiasResult`... Until that ships, the `retrieval_score=0.0` inference rule is the contract."*) — it has now shipped. Extend `BiasResult`/`EngineResponse` in `src/rag/engine-client.ts` with the additive fields (`source: ("vector"|"llm")[] | null` per bias; top-level `llm_model`, `llm_latency_ms`, `truncated_story`, `llm_scores`, `vector_scores`), and prefer `source` over the `retrieval_score=0.0` heuristic wherever it is present.

**Why**: The inference rule was always a workaround for a missing field, documented as temporary. Reading `source` directly is more precise: it distinguishes "the engine's vector search found this" from "the engine's own local LLM found this" from "both signals found it" (array of length 2) — the score-based heuristic could only ever tell retrieved-something from retrieved-nothing.

**Do not**: Remove the `retrieval_score=0.0` fallback — `vector_only` and `nli_union` responses still carry `source: null` (contract v3 is additive-only), so Case B detection for those strategies is unchanged. Only `llm_union` responses get the richer signal.

**Source**: biassemble-engine `specs/004-add-llm-model/contracts/retrieve-biases-v3.md`, `docs/decisions/014-tiered-context-retrieval.md`.

---

## Decision 2: Replace the binary `context_source` with per-bias engine + assessment provenance

**Decision**: `context_source` (assigned in `assessment.service.ts` around the `normalizeBiasName` step) currently collapses to just `"retrieved" | "roster"` — and "roster" itself conflates two different situations: the engine was unavailable/fell back (`ragCase !== "retrieved"`), and the engine ran fine but *this specific bias* wasn't in what it retrieved (i.e. the assessment LLM named it independently). Replace it with a per-bias provenance that **mirrors the engine's array** rather than a collapsed value.

Each final bias carries `engineSources: ("vector" | "llm")[]` — the engine methods that corroborated it, copied straight from the engine's `source` array:

- `["vector"]` — engine's vector search found it, its local LLM did not
- `["llm"]` — engine's local LLM named it, vector search did not
- `["vector","llm"]` — both engine signals found it (replaces the old collapsed `"both"`)
- `[]` — the assessment LLM named it alone; the engine ran (`ragCase === "retrieved"`) but did not surface this id

The request-level `ragCase` still distinguishes the no-engine-signal case: when `ragCase` is `"roster_fallback"` or `"unavailable"`, `engineSources` is `[]` but means *unknown* (engine never looked), not *assessment-only*. Keep `ragCase` alongside `engineSources` so the two `[]` meanings stay separable.

This is derived, not an extra LLM call — `engineSources` is computed from the engine `source` array (already in hand from `buildBiasContext`) intersected with the assessment LLM's own output. No change to D001 (single LLM call per assessment run stands).

**Why**: This is the actual instrumentation goal — knowing, across many real requests, how often each signal (engine vector search, engine's small local LLM, the assessment LLM acting alone) gets *confirmed* by the final output. That comparison is only possible if the three sources are distinguishable, not collapsed into "retrieved" vs "roster." It also directly informs whether it's worth investing further in the engine's local LLM (currently Gemma-3-4B-it, narrowed-candidate prompting — see biassemble-engine's `specs/004-add-llm-model/research.md`) versus leaning more on vector search or the assessment LLM alone, before any future catalog expansion (38 → 200+ biases, tracked as a separate future initiative, out of scope here).

**Do not**: Treat a `["vector","llm"]` bias as higher-confidence in the *prompt* (this is observability, not a ranking signal fed back into the LLM — do not let this tagging change what context the assessment LLM sees, only what gets logged about the result). Read `engineSources == []` as "assessment LLM found it alone" when `ragCase !== "retrieved"` — that case is genuinely unknown-provenance, not evidence the assessment LLM beat the engine, since the engine never got a chance to look.

**Source**: `src/orchestrators/reflection/assessment.service.ts` (`contextSource` assignment), `src/rag/context-builder.ts` (`RagCase`, `retrievedIds`), this ADR.

---

## Decision 3: Split `retrieval_comparisons.rag_list` into per-source lists

**Decision**: Extend the `retrieval_comparisons` table (`src/db/schema.ts`) so the engine's contribution is stored as separate lists — `ragVectorList`, `ragLlmList` (each derived by filtering the engine response for biases whose `source` array contains `"vector"` / `"llm"` respectively; a `["vector","llm"]` bias appears in **both** lists) — alongside the existing `ragList` (kept for backward read compatibility), `llmList` (assessment LLM's raw output), and `finalList`. Extend `recordComparison()` (`src/observability/comparison-recorder.ts`) to compute confirmation counts per engine source: `ragVectorHitFinal`, `ragLlmHitFinal` (and, since the arrays overlap, `ragBothHitFinal` = biases whose `source` was `["vector","llm"]` that reached the final list), in addition to the existing aggregate `ragHitFinal`.

**Why**: The existing table already proves out the pattern (fire-and-forget, post-hoc overlap counts) — this is the same mechanism, just with the engine's combined `rag_list` split by source before the overlap math runs. Without this, "what % of the engine's local-LLM suggestions get confirmed" is not answerable from stored data even after Decision 1/2 ship, because the raw per-source lists were never persisted separately.

**Do not**: Block the assessment response on this write (D011 — fire-and-forget, try/catch, log-and-continue on failure, same as today). Add a new LLM call to backfill or re-derive this after the fact — the source split must come from the same engine response already fetched for the current run.

**Source**: `src/db/schema.ts` (`retrievalComparisons`), `src/observability/comparison-recorder.ts`, `docs/decisions/011-fire-and-forget-observability.md`.

---

## Non-goals

- No new LLM calls — this is provenance tagging and logging on data already fetched/produced, not a pipeline change. D001 (single LLM call per assessment) is unaffected.
- No change to what context the assessment LLM sees or how it's prompted — Decision 2's tags are computed *after* the LLM call, from its output plus the engine response already in hand.
- Not a precision/accuracy initiative. The engine's local LLM (Gemma-3-4B-it, narrow-then-confirm prompting) is deliberately tuned toward higher recall / more candidates right now, accepting more false positives, because the near-term goal is building a real confirmation-rate dataset per source — not shipping a tuned final answer. Precision tuning is a later decision, informed by this data.
- Catalog expansion (38 → 200+ biases) is a distinct future initiative this ADR does not address, beyond noting it as the reason this data matters now.
