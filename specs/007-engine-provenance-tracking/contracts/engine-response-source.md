# Contract: Engine response consumed by core (per-bias `source`)

**Consumer**: `biassemble-core` `src/rag/engine-client.ts`.
**Compatibility**: additive-only. Core must parse responses without `source`/`llm_*` unchanged.

## Per-bias `source`

```jsonc
{
  "id": "overconfidence_bias",
  "name": "Overconfidence Bias",
  "retrieval_score": 0.83,
  "definition": "...", "examples": "...", "indicators": "...",
  "false_positives": "...", "related_biases": "...",
  "source": ["vector", "llm"]        // array of contributing engine signals
}
```

- **Canonical**: `source` is an array — `["vector"]` | `["llm"]` | `["vector","llm"]`, or
  `null`/absent when not produced.
- **Legacy tolerance**: a scalar `"vector"` / `"llm"` / `"both"` is normalized on parse:
  `"both"`→`["vector","llm"]`, `"vector"`→`["vector"]`, `"llm"`→`["llm"]`.
- Unknown values are dropped; an all-unknown/empty result normalizes to `null`.
- **`"both"` is never the normalized output form** — only ever an input spelling that gets expanded.
  Nothing downstream of `normalizeSource()` ever sees or stores the string `"both"`.

## Top-level metadata (additive, optional)

`llm_model` is whatever the engine's `_llm_model_display_name()` reports (repo id's last path
segment, `-GGUF` suffix stripped) — treat the example below as illustrative, not a pinned value; it
will change whenever the engine's configured model changes, independent of this contract.

```jsonc
{
  "biases": [ /* ...each with "source" */ ],
  "retrieved_chunks": 12,
  "taxonomy_version": "2026-07-06.1",
  "embedding_model": "all-MiniLM-L6-v2",
  "request_id": "b3d2a1c0-...",

  "selection_strategy": "llm_union",
  "llm_model": "google_gemma-3-4b-it",
  "llm_latency_ms": 18234.1,
  "truncated_story": false,
  "llm_scores":    { "overconfidence_bias": 0.88 },
  "vector_scores": { "overconfidence_bias": 0.20 }
}
```

## Parse acceptance criteria

| Input | Expected |
|-------|----------|
| response with no `source`, no `llm_*` | parses; `source` per bias = `null`; provenance falls back to `retrieval_score` rule |
| `source: ["vector","llm"]` | parsed as `["vector","llm"]` |
| `source: "both"` (legacy scalar) | normalized to `["vector","llm"]` |
| `source: null` with `retrieval_score > 0` | provenance inferred as `["vector"]` in `workspace-builder.ts` |
| `source: ["bogus"]` | normalized to `null` (unknown dropped) |
| top-level `llm_*`/`*_scores` present | captured on `EngineResponse`, optional |

## What core does NOT do with this data

- Does not feed `source`/`engineSources` back into the assessment prompt or use it to rank/filter
  what the assessment LLM sees (D017 non-goal, FR-011).
- Does not store `"both"` as a value anywhere — the array length says it, both in the per-bias
  representation and in the persisted per-run breakdown (contracts/engine-response-source.md +
  data-model.md §3 agree on this).
