# Eval Runners

Two separate LLM-output evaluation systems exist, plus a third, unrelated
convention for code that has no LLM in its loop. Do not conflate any of them.

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

## `numbers/` — plain unit tests, not `runEval`/`runDataset` (D018 §4.3 rule 5)

`src/numbers/` (`normalize.ts`, `compare.ts`, `derive.ts`) and the audit-mode
business metrics it feeds (`orchestrators/audit/scores.ts`) are **deterministic
code with no LLM in the loop** — a fixed formula over already-decided verdict
counts, or arithmetic over numbers already extracted from text. D018 §4.3 rule
5 is explicit about why neither `runEval()` nor `runDataset()` applies here:
those two systems exist to evaluate *LLM output quality* (does the model's
judgment hold up against a golden answer, is it deterministic across reruns
of the same prompt) — there is no model judgment to evaluate in a pure
function. Testing it as an "eval" would imply a category of risk (prompt
drift, non-determinism, model-quality regression) this code doesn't have.

Instead, this code is tested the ordinary way: plain Vitest unit tests
against hand-computed fixtures, run as part of the normal `vitest run` suite
— not a separate `pnpm eval*` script, no `eval_results` row, no
`eval_run_id`. See:

- `tests/unit/numbers/compare.test.ts` / `tests/unit/numbers/derive.test.ts`
  — against `evaluations/golden/audit/numbers-golden-set.json`'s
  comparability and derived-arithmetic cases respectively. ("golden" in that
  fixture's filename is a naming convention carried over from the
  LLM-evaluation golden sets, not a claim that this is a `runEval`/
  `runDataset` golden set — it's a hand-computed arithmetic fixture, checked
  the same way any other unit-test fixture is.)
- `tests/unit/orchestrators/audit/gate-scores.test.ts` — against D018 §4.1's
  own worked example (20 supported / 10 partially-supported / 0 unsupported
  / 0 contradicted → groundedness 83, strict 67%) plus the zero-denominator
  edge case.

When to run: same as any other unit test — on every change to `numbers/` or
`scores.ts`, as part of `npx vitest run`. There is no separate cadence to
remember, unlike `eval:trigger:*`'s "before prompt file changes merge"
schedule — this code doesn't drift the way a prompt does.

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
