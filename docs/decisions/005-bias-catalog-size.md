# D005 — ~30 Curated Biases, No Expansion Until Justified

**Decision**: MVP uses approximately 30 high-quality curated biases injected into the prompt as names + one-line definitions. Stored in `datasets/biases/taxonomy.v1.json` with stable IDs.

**Why**: All 200 biases in prompt = context noise. 30 curated biases is enough for MVP.

**Do not**: Expand the catalog until evaluations justify it, retrieval exists, and confidence scoring is implemented. Deprecate with `replacedBy`, never rename.

**Source**: specs/001-reflection-core/research.md, specs/001-reflection-core/plan.md
