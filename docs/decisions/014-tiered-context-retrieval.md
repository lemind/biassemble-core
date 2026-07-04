# D014 — Tiered Context + RAG Fallback Degradation

## Decision 1: Tiered context replaces full taxonomy injection

**Decision**: The assessment prompt uses a two-tier bias context. Tier 1 (retrieved biases) gets full documents (definition, examples, indicators, false_positives, related_biases). Tier 2 (full roster) provides name + one-line definition for all 38 biases. If retrieval returns real candidates, both tiers are present. If retrieval returns a roster fallback or is unavailable, only the roster is present.

**Three cases the client must handle**:

- **Case A — real retrieved biases**: Engine returned biases above the similarity threshold. Client uses two-tier context: Tier 1 full documents + Tier 2 roster + higher-confidence instruction.
- **Case B — roster fallback (HTTP 200, no real candidates)**: As of biassemble-engine T008, the engine never returns an empty `biases` array. When threshold filtering eliminates all candidates, it returns all 38 taxonomy entries as `BiasResult` with `retrieval_score=0.0` and empty `examples`/`indicators`/`false_positives`. Client uses roster-only context.
- **Case C — engine unavailable**: Timeout, network error, 4xx, 5xx, or invalid response shape. Client uses roster-only context.

**Detecting Case B**: The engine response does not currently include an explicit `source: "retrieved" | "roster"` field. The client detects Case B by checking whether all returned biases have `retrieval_score=0.0`. If every entry in the response has `retrieval_score=0.0`, treat as roster fallback (Case B). Even a single entry with `retrieval_score > 0.0` means Case A applies for that subset.

The clean long-term fix is for the engine to add a `source` field to each `BiasResult`. Until that ships, the `retrieval_score=0.0` inference rule is the contract. This inference rule must be documented in the client code with a reference to this ADR.

**Why not padding (the rejected alternative)**: Padding with arbitrary full-document entries when retrieval returns few results conflates correct-empty with wrong-empty and re-arms the false-positive problem — full documents give the model material to fabricate matches. Even 1 retrieved bias with full documents beats roster-only for that bias; the error is padding with random extras, not having a small retrieved set.

**Why not full taxonomy every time (the second rejected alternative)**: Full taxonomy injection (all 38 biases × full documents) costs significantly more tokens per call and scales poorly as domain expansion adds more entries. It also eliminates the structural false-positive guard that threshold filtering provides — bypassing it forces the model to do more rejection work on its own, increasing false-positive risk.

**Do not**: Pad retrieval results with full taxonomy entries. Drop to roster-only solely because fewer than 3 biases were retrieved. Treat Case B and Case C as identical in logging — log them with distinct `rag_context` values (`"roster_fallback"` vs `"unavailable"`).

**Source**: specs/004-rag-integration/spec.md (Part 1.3)

---

## Decision 2: RAG failure degrades to roster, never fails the assessment

**Decision**: If `biassemble-engine` is unavailable (timeout, network error, 5xx, or invalid response shape), the assessment continues with roster-only context (Case C). The RAG client returns `{ status: "unavailable" }`. The user never sees an error caused by retrieval failure.

**Error categorization**: Not all errors are equivalent. Log them with distinct categories:
- 401 / 403 → `rag_auth_error` (misconfiguration — key rotation or deployment issue, not transient)
- 5xx / network / timeout → `rag_fallback` (transient)
- Invalid response shape → `rag_invalid_response`

A 401 silently degrading to roster with only `rag_fallback: true` in the log would mask auth misconfiguration indefinitely. Log `rag_auth_error` at `warn` level so it is distinguishable from ordinary transient failures.

**Why not failing the assessment on retrieval failure**: Retrieval is a token-saving optimization, not a correctness dependency. The roster provides sufficient context for bias detection — that is exactly what Stage 001 shipped with, and it worked. Failing a session because a retrieval sidecar is temporarily down is user-visible, disproportionate, and unjustified given the roster fallback is functionally valid.

**Timeout choice (500ms)**: Configurable via `RAG_TIMEOUT_MS`. The assessment pipeline has a 10s timeout (`AI_TIMEOUT_MS`). Retrieval must complete well before the LLM call begins — 500ms is conservative for a network call within the same deployment region and leaves buffer for cold starts.

**Known gap — circuit breaker**: At current request volume, a 500ms penalty per-call when the engine is consistently down is acceptable. If volume increases, an in-memory circuit breaker (stop attempting after N consecutive failures, reset after M seconds) would eliminate the latency penalty. Not implemented now; revisit when p95 latency is monitored.

**Do not**: Surface RAG errors to the user. Throw from the RAG client into the assessment flow. Retry the RAG call on timeout. Log 401/403 as generic `rag_fallback`.

**Source**: specs/004-rag-integration/spec.md (Part 1.1), docs/decisions/D011
