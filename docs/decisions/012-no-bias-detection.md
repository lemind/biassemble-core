# D012 — No-Bias Detection and Dataset

**Decision**: 13 manually curated neutral stories in `no_bias` dataset for adversarial testing. When `parsed.biases.length === 0`, service sets `noBiasDetected: true`. Simple boolean flag (not discriminated union).

**Why**: The pipeline must know when to say "no bias found." Without adversarial testing, the pipeline may over-detect biases in neutral stories, eroding user trust.

**Do not**: Generate no_bias stories automatically (yet). Use discriminated unions for the no-bias signal. Return biases for neutral stories just to avoid empty results.

**Source**: specs/002-reasoning-infrastructure/plan.md, specs/002-reasoning-infrastructure/tasks.md (T200)
