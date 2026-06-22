# D006 — Interpretation Layer Precedes Bias Hypotheses

**Decision**: Before proposing bias candidates, the pipeline generates ranked interpretations of what happened in the story. Bias labels are applied to the most plausible interpretations, not directly to raw story text.

**Why**: Prevents the common failure mode where the system labels a bias before considering alternative explanations.

**Do not**: Skip the interpretation step and go directly from story analysis to bias hypothesis. `InterpretationSchema` sits between `StoryAnalysis` and `BiasHypothesis`.

**Source**: specs/002-reasoning-infrastructure/plan.md
