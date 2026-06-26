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

---

## Operational reference

### `eval:dataset:golden` — golden dataset run

| | |
|---|---|
| **When to run** | After deploying a new prompt version or switching models |
| **Dataset** | 5 stories that contain real biases — model should detect them |
| **What good looks like** | `evidenceGroundedRate = 1` for all scenarios, `errorCount = 0`, `raw_output` populated |
| **What bad looks like** | `evidenceGroundedRate` drops below 1 (model stopped citing evidence), missing rows (errors), `raw_output` shows malformed JSON |
| **Limitation** | No baseline comparison yet — you must manually diff `raw_output` across `eval_run_id`s |

### `eval:dataset:no-bias` — no-bias dataset run

| | |
|---|---|
| **When to run** | After deploying a new prompt version or switching models |
| **Dataset** | 10 stories with no bias — model should detect nothing |
| **What good looks like** | `evidenceGroundedRate = null` for all scenarios (null = no biases found, correct), `errorCount = 0` |
| **What bad looks like** | `evidenceGroundedRate` is non-null (model found biases where none exist — false positives), missing rows |
| **Limitation** | `falsePositiveRate` is `null` because we run story-only (no Q&A answers) — cannot compute intent-based false positive rate |

### `eval:trigger:golden` / `eval:trigger:no-bias` — CI gate

| | |
|---|---|
| **When to run** | Automatically in CI on every PR, or manually to check regression |
| **What good looks like** | `passed = true` in `eval_results`, determinism check passes |
| **What bad looks like** | `passed = false`, non-deterministic outputs between runs |
| **Limitation** | Does not store per-scenario data — aggregate only |

---

## Reading results from DB

```sql
-- All eval runs
SELECT eval_run_id, dataset, COUNT(*) as scenarios, MIN(run_at) as started
FROM core.eval_results
WHERE eval_run_id IS NOT NULL
GROUP BY eval_run_id, dataset
ORDER BY started DESC;

-- Per-scenario metrics for a run
SELECT scenario_id, evaluation_metrics, LENGTH(raw_output) as raw_len
FROM core.eval_results
WHERE eval_run_id = '<your-eval-run-id>'
ORDER BY scenario_id;
```
