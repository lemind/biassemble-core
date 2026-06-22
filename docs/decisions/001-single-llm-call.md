# D001 — Single LLM Call Per Assessment Run

**Decision**: One provider call returns full reasoning trace + assessment as a single JSON response.

**Why**: Latency. Multi-turn adds 2-3x response time with marginal quality gain at current scale.

**Do not**: Split into separate stage calls (story analysis → interpretation → bias detection) without revisiting this decision.

**Source**: specs/002-reasoning-infrastructure/plan.md
