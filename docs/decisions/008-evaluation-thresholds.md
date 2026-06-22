# D008 — Evaluation Thresholds and Metric Groups

**Decision**: Two metric groups: evaluation (`evidence_grounded_rate >= 0.9`, `false_positive_rate < 0.10`) and system (`schema_parse_rate >= 0.95`, `repair_rate < 0.05`). One bad metric in either group fails the CI gate.

**Why**: They measure different things — model reasoning quality vs pipeline stability. Both must pass.

**Do not**: Run real eval on every commit. Mock only in CI. Real eval runs manually before deploy or prompt changes.

**Source**: specs/002-reasoning-infrastructure/spec.md, .skills/eval-pipeline.md
