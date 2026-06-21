# D002 — Evidence Binding Enforced at Schema Level

**Decision**: Every bias item MUST include a non-empty `evidence` array with `source`, `excerpt` (verbatim), and `relevance`. A bias without evidence is invalid and MUST be dropped or flagged.

**Why**: Without evidence binding, bias assessments are opaque LLM outputs. Evidence traces are the foundation for trust, debugging, and quality improvement.

**Do not**: Return a bias item with empty evidence or paraphrased excerpts. Threshold: `evidence_grounded_rate >= 0.9`.

**Source**: specs/002-reasoning-infrastructure/spec.md (FR-001, FR-002, FR-011)
