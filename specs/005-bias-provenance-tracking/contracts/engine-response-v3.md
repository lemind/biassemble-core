# Contract: Engine response consumed by core (v3 provenance additions)

**Producer**: `biassemble-engine` `POST /retrieve-biases` under `SELECTION_STRATEGY=llm_union`.
**Consumer**: `biassemble-core` `src/rag/engine-client.ts`.
**Compatibility**: additive-only. Core must parse v1/v2 responses (no `source`, no `llm_*`) unchanged.

## Per-bias `source`

```jsonc
{
  "id": "overconfidence_bias",
  "name": "Overconfidence Bias",
  "retrieval_score": 0.83,
  "definition": "...", "examples": "...", "indicators": "...",
  "false_positives": "...", "related_biases": "...",
  "source": ["vector", "llm"]        // NEW — array of contributing engine signals
}
```

- **Canonical (per ADR D015)**: `source` is an array — `["vector"]` | `["llm"]` | `["vector","llm"]`,
  or `null`/absent under `vector_only`/`nli_union`.
- **Legacy tolerance**: if the engine sends a scalar `"vector"` / `"llm"` / `"both"` (the shape the
  engine's own v3 contract text still documents), core normalizes it: `"both"`→`["vector","llm"]`,
  `"vector"`→`["vector"]`, `"llm"`→`["llm"]`. See research R1.
- Unknown values are dropped; an all-unknown/empty result normalizes to `null`.

## Top-level metadata (present on `llm_union`)

```jsonc
{
  "biases": [ /* each with "source" */ ],
  "retrieved_chunks": 12,
  "taxonomy_version": "2026-07-06.1",
  "embedding_model": "all-MiniLM-L6-v2",
  "request_id": "b3d2a1c0-...",

  "selection_strategy": "llm_union",           // NEW
  "llm_model": "Qwen2.5-1.5B-Instruct",        // NEW
  "llm_latency_ms": 18234.1,                    // NEW
  "truncated_story": false,                     // NEW
  "llm_scores":    { "overconfidence_bias": 0.88 },  // NEW — id → local-LLM score
  "vector_scores": { "overconfidence_bias": 0.20 }   // NEW — id → vector score
}
```

All top-level additions are optional; absent under `vector_only`/`nli_union`.

## Parse acceptance criteria (core contract test)

| Input | Expected |
|-------|----------|
| v2 response (no `source`, no `llm_*`) | parses; `source` per bias = `null`; provenance falls back to `retrieval_score` rule |
| `source: ["vector","llm"]` | parsed as `["vector","llm"]` |
| `source: "both"` (legacy scalar) | normalized to `["vector","llm"]` |
| `source: null` with `retrieval_score > 0` | provenance inferred as `["vector"]` |
| `source: ["bogus"]` | normalized to `null` (unknown dropped) |
| top-level `llm_*`/`*_scores` present | captured on `EngineResponse`, optional |

## Source-of-truth note

The engine's `specs/004-add-llm-model/contracts/retrieve-biases-v3.md` currently documents `source`
as a **scalar** string. This core contract follows ADR D015's **array** decision and tolerates the
scalar for deploy-ordering safety. An engine-side contract update to the array shape is a follow-up
tracked outside this feature.
