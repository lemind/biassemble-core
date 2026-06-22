# Eval Pipeline Skill

Load this when working with evaluation datasets, metrics, or eval jobs.

## Datasets

- **Golden dataset**: `evaluations/golden/reflection/` (5 stories)
- **No-bias dataset**: `evaluations/no_bias/reflection/` (13 stories)

## Commands

```bash
pnpm eval                    # Mock eval (fast, no API cost, tests wiring only)
pnpm eval --provider real    # Real eval (uses Gemini, run before prompt changes)
```

## Thresholds

- `evidence_grounded_rate >= 0.9`
- `false_positive_rate < 0.10`

## False Positive Definition

A bias is a false positive if:
- Returned with `confidence > story.confidenceThreshold`
- But the story's ground truth says the bias should NOT be detected

## CI Policy

- **Do not run real eval on every commit** — mock only in CI
- **Run real eval before prompt changes** — establish baseline
- **Run real eval after prompt changes** — verify no regression

## Metrics Functions

- `computeEvaluationMetrics()` — evidence_grounded_rate, false_positive_rate
- `computeSystemMetrics()` — schema_parse_rate, repair_rate

## Eval Job

Inngest job defined in `src/jobs/eval-assessment.ts`. Currently a stub — not yet running real evaluations.
