# Bias taxonomy

**File**: `taxonomy.v1.json` — curated list (~30 Tier-A entries for MVP).

**Schema**: `taxonomy.v1.schema.json`

## MVP scope

30 high-quality bias entries with: `id`, `name`, `category`, `definition`, `detectionSignals`.

**No tier-b/c entries.** Do not expand until evaluations justify it, retrieval exists, and confidence scoring is implemented.

## Usage

`BiasCatalogService` (implementation Phase 1) reads this file and builds:

- `biasCategories` — one-line summary per category for prompts
- `biasShortlist` — all 30 bias names injected into assessment prompt