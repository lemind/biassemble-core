# D015 — Async RAG: Fire at Story Submission, Absorb Latency in Human Think Time

## Status

ACCEPTED · Written 2026-07-09 · Supersedes D014 timeout guidance (500ms RAG_TIMEOUT_MS no longer applies; see Decision 4)

---

## Context

spec-004 wired RAG as a blocking call at the start of `runStoryOnlyAssessment`: the LLM could not generate questions until `POST /retrieve-biases` returned. On the deployed HF Space (cpu-basic, 2 shared vCPUs), DeBERTa processes all 38 NLI pairs sequentially — ~76s per request. This placed a ~76s penalty on the story-only assessment path, making the feature unusable in practice.

The root cause is architectural, not fixable by tuning: the NLI model saturates available CPU; parallelism at the Python level does not help because the GIL serializes compute. A GPU upgrade on the RAG side would solve it, but at material cost and complexity. The cheaper fix is to move RAG off the critical path entirely.

**Measured latency baseline (cpu-basic HF Space, 2026-07-09):** 1 NLI pair warms in ~2s; full 38-pair batch runs sequentially at ~2s/pair → ~76s total. All latency figures in this document are derived from this single measured value.

---

## Decision 1 — Fire RAG at story submission, concurrently with question generation

When a story is submitted, two things happen in parallel:

1. **LLM call (fast, ~2-3s)**: generate clarifying questions + an initial candidate bias list.
2. **RAG call (slow, ~76s)**: fire `POST /retrieve-biases` non-blocking; store the in-flight task; return immediately to the caller.

The LLM call completes in seconds. The RAG result arrives ~76s later. The human then spends 30–120s answering questions. By the time the full assessment starts, RAG is almost always READY — without the user ever waiting for it.

**biassemble-engine is unchanged.** The same `POST /retrieve-biases` endpoint is used; the change is entirely in how biassemble-core manages the lifecycle of that call.

---

## Decision 2 — Session rag_status tracks the RAG lifecycle

Each session carries a `rag_status` field:

```
RUNNING → READY
       → FAILED
       → TIMEOUT
```

- `RUNNING`: HTTP request to biassemble-engine is in flight. Set immediately when the background task starts at submission time.
- `READY`: Engine returned a valid response; `rag_result` is populated in session state.
- `FAILED`: Engine returned a non-retriable error (4xx, 5xx, invalid shape). Equivalent to Case C in D014.
- `TIMEOUT`: No response within `RAG_TIMEOUT_MS`. Equivalent to Case C in D014.

`rag_status` and `rag_result` are stored in session state (the `runs` table via the existing `rag_result` JSONB column is sufficient for the result; status is tracked in-process or as a derived column). FAILED and TIMEOUT are terminal — no retry is attempted (D014 Decision 2 discipline stands).

---

## Decision 3 — Bias workspace unifies LLM candidates and RAG results

At full-assessment time, the prompt does not receive two separate lists ("what LLM found" vs "what RAG found"). It receives a single **bias workspace**: a merged structure of candidate biases annotated with confidence and evidence, regardless of source.

```
candidate_biases:
  - bias_id: overconfidence_bias
    confidence: 0.87        # from RAG retrieval_score, or LLM initial estimate
    evidence: "..."         # definition + indicators from engine, or empty if LLM-only
    source: retrieved | llm | both
```

The assessment LLM is agnostic to source — it evaluates candidates and decides which are present in the story. This removes the need for the LLM to "know about RAG" and keeps the source-routing logic in service code where it belongs.

**Merge rules:**
- If RAG is READY: start from RAG candidates (confidence = `retrieval_score`, evidence from engine); add LLM candidates not in RAG set (confidence = LLM estimate, evidence empty).
- If RAG is not READY (FAILED, TIMEOUT, PENDING): bias workspace contains only LLM initial candidates.
- Duplicate resolution: if the same bias appears in both, merge into one entry with `source: "both"`. Use RAG's `retrieval_score` as the canonical confidence for ranking — it is eval-gated and calibrated. LLM's initial estimate is stored separately for comparison but does not override. LLM confidence and RAG `retrieval_score` are incommensurable scales; taking `max()` across them lets an uncalibrated LLM estimate displace a gated RAG score.

The existing D014 tiered-context builder (`buildBiasContext`) is **replaced** by the bias workspace builder. The rendered template variable changes from `{{biasContext}}` (D014/FR6 format: Tier 1 documents + Tier 2 roster) to `{{candidateBiases}}` (workspace format). Prompt version bumps accordingly.

---

## Decision 4 — Adaptive wait at assessment time; RAG_TIMEOUT_MS is a background safety ceiling

When `runFullAssessment` begins, check `rag_status`:

- **READY**: use the result immediately; no wait.
- **RUNNING**: wait up to min(2s, remaining_budget). If still not READY, proceed without it.
- **FAILED / TIMEOUT**: proceed without it.

Do **not** use a fixed 2s pause regardless of status. The adaptive check costs zero latency when RAG is already READY (the common case after human think time) and adds at most 2s in the rare near-complete edge case.

**RAG_TIMEOUT_MS = 120,000ms is the HTTP client ceiling for the background task, not a user-visible wait.** It exists solely to prevent a hung biassemble-engine call from leaking a connection indefinitely. The user never waits for it — the assessment adaptive wait (≤2s above) is what the user's request actually blocks on. Do not confuse the two: 120s is the backstop on the background coroutine, not a latency budget. This env var is already updated in both the local `.env` and on the HF Space (set 2026-07-09). The Vercel deployment env must also be updated.

---

## Decision 5 — Race outcome recorded per run (telemetry)

Every call to `runFullAssessment` logs two fields at info level:

- `rag_available: true | false` — whether RAG was READY when the assessment began (after any adaptive wait).
- `rag_wait_ms: number` — milliseconds spent in the adaptive wait (0 if READY on arrival, 0 if skipped).

Without this telemetry, all latency figures in this ADR remain estimates. `rag_available` over real sessions is the only way to validate (or update) the ~20% miss-rate estimate and to confirm whether the 76s median holds or is a cold-start artifact. This data also drives any future decision to optimize the engine (ONNX export, two-phase NLI) or to raise/lower the adaptive wait ceiling.

**Do not** log the full RAG result at info level (too large). Log `rag_status` (existing) plus the two fields above.

---

## Decision 6 — assessment_source recorded per bias

The existing `context_source` field on `BiasItem` (D014 FR7: `"retrieved" | "roster"`) is replaced by a three-value enum. `"roster"` is retired — in the workspace model, a bias that came only from the LLM (whether RAG was absent or simply didn't return that bias) is `"llm"`, not "roster." Keeping "roster" as a distinct value would require callers to treat two synonymous states (`"roster"` and `"llm"`) as one concept.

```
context_source: "retrieved" | "llm" | "both"
```

- `"retrieved"`: appeared in RAG results with `retrieval_score > 0.0`, not in LLM initial list.
- `"llm"`: in LLM initial list only. RAG was FAILED/TIMEOUT, or returned this bias at `retrieval_score=0.0` (Case B), or did not return it at all.
- `"both"`: appeared in both. RAG's `retrieval_score` is the canonical confidence (Decision 3 merge rule).

This is derived in service code after the assessment LLM returns, not prompted. Existing rows (pre-Stage-015) have `context_source = "roster"` — treat as `"llm"` on read if backward-compat is needed.

---

## Why

**76s on the critical path is a hard blocker.** A user who submits a story and waits 76s before seeing questions will not continue. The human think time window (30–120s) is dead time that already exists — it is free latency budget that RAG can consume without any user-visible cost.

The bias workspace abstraction removes source-routing logic from the LLM prompt — the model never needs to know where candidates came from, only whether they are present. An external architecture review (2026-07-09) validated this pattern as a multi-agent pipeline that emerged naturally from the latency constraint rather than being designed top-down. Key suggestions adopted: bias workspace, adaptive wait, telemetry-before-optimization ordering.

---

## What does not change

- **biassemble-engine API**: `POST /retrieve-biases` is called with the same payload. No engine changes.
- **D014 Decision 2 degradation rules**: FAILED, TIMEOUT, and auth_error still degrade to LLM-only silently. Only the 500ms timeout budget changes.
- **D011 fire-and-forget discipline**: comparison recording remains non-blocking and non-fatal.
- **D014 Case B/C detection**: roster fallback inference (`retrieval_score=0.0`) is unchanged for Cases B and C.

---

## Consequences

- Story-only assessment response time drops from ~76s (blocked on NLI) to ~3s (LLM question generation only).
- Full assessment gains a bias workspace with richer evidence when RAG completes in time (~76s), which fits within the typical 30–120s human think window.
- When users answer faster than RAG completes, assessment falls back to LLM-only — same quality as the pre-Stage-004 baseline. The exact miss rate is an estimate until Decision 5 telemetry (`rag_available`) is collected over real sessions.
- `runStoryOnlyAssessment` now fires a background task. Its implementation requires async task management (e.g., background tasks via the existing Inngest infrastructure or a simple in-process async task).

**Source**: architecture review 2026-07-09; external AI review 2026-07-09 (bias workspace, adaptive wait, telemetry-first ordering adopted).
