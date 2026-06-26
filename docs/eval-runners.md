# Eval Runners

Two separate evaluation systems exist. Do not conflate them.

## Comparison

| | `runEval()` — CI gate | `runDataset()` — Observability |
|---|---|---|
| pnpm script | `eval:trigger:golden`, `eval:trigger:no-bias` | `eval:dataset:golden`, `eval:dataset:no-bias` |
| Inngest event | `eval/golden-story`, `eval/no-bias-story` | `eval/dataset-run` |
| Inngest job | `evalGoldenStoryJob`, `evalNoBiasStoryJob` | `evalDatasetRunJob` |
| Pipeline | Full Q&A (question gen + assessment) | Assessment only |
| Determinism check | Yes — reruns same input, compares output | No |
| Pass/fail | Yes — sets `passed` on `eval_results` | No — `passed` is always `false` |
| Per-scenario rows | No | Yes — one row per story |
| `eval_run_id` | `null` | UUID shared across the run |
| `scenario_id` | `"aggregate"` | Story ID (e.g. `"golden-001"`) |
| `raw_output` | `null` | Raw LLM JSON string |
| Purpose | CI quality gate, regression detection | Raw output capture for debugging and drift analysis |

## When to use which

**Use `runEval()` / CI gate** when you need to know if the model's quality has regressed. It runs the full pipeline, checks determinism, and sets pass/fail. Triggered automatically in CI or manually via `eval:trigger:golden`.

**Use `runDataset()` / observability** when you want to inspect raw model outputs across all scenarios, compare prompt versions, or build dashboards. Triggered manually via `eval:dataset:golden` after deploying a new prompt or model.
