# Bias taxonomy

**File**: `taxonomy.v1.json` — canonical list (~200 entries target).

**Schema**: `taxonomy.v1.schema.json`

## Importing your ~200 biases

1. Export your list to JSON array under `biases`.
2. Each entry needs: `id`, `name`, `category`, `definition`, `mvpPriority`.
3. Tag **25–40** common biases as `tier-a` (prompt shortlist).
4. Tag specialized/rare biases as `tier-b` (catalog reference, model may cite if confident).
5. Tag edge cases for future RAG as `tier-c`.

Optional fields: `detectionSignals`, `relatedIds`.

## MVP usage

`BiasCatalogService` (implementation Phase 1) reads this file and builds:

- `biasCategories` — one-line summary per category for prompts
- `biasShortlist` — names of all `tier-a` entries

Do **not** inject all 200 definitions into the system prompt in MVP.
