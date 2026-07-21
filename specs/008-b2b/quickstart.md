# Quickstart: B2B Audit Mode

## Validate against the golden sets (no server needed)

```bash
pnpm vitest run tests/unit/numbers/                # numbers-golden-set.json, 20 cases
pnpm vitest run tests/integration/audit-extract.test.ts    # extract-golden-set.json, 11 cases
pnpm vitest run tests/integration/audit-verify.test.ts     # verify-golden-set.json, 15 cases
```

Pass bars (from `evaluations/golden/audit/README.md`, restated here so this quickstart doesn't drift from it — cites, doesn't restate the definitions):
- EXTRACT: recall ≥ 0.90, precision ≥ 0.85, zero `excluded_content` leaks.
- VERIFY: ≥ 14/15 expected verdicts matched, zero false "contradicted" on period/scale/scope-only mismatches.
- Numbers: zero false "not comparable = contradicted" — every `comparable: false` case in the golden set must never surface as a contradiction downstream.

## Run one audit end to end (once the endpoint is wired)

```bash
curl -X POST http://localhost:PORT/audit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "audit",
    "domain": "finance",
    "task": "Summarize Apple Q2 FY2026 results. As-of: 2026-07-15",
    "output_text": "Apple'\''s total net sales for the quarter reached $111,184 million, up from $95,359 million a year earlier.",
    "sources": [ { "id": "aapl-10q-q2fy26", "name": "Apple 10-Q, period ended 2026-03-28", "text": "Total net sales $111,184 $95,359 17% $254,940 $219,659 16%" } ],
    "options": { "threshold": 0.60, "maxClaims": 50 }
  }'
# → 202 { "audit_id": "..." }
```

`sources[]` here is the actual text to check the claim against — pasted directly from `evaluations/golden/audit/source-filing.md`'s `products-table` excerpt for this example. There is no separate "fixture reference" mechanism: the retrieval stub (research.md §1) does naive lexical retrieval over whatever `sources[]` text a request actually submits, so this same call shape works identically for a golden-set excerpt or genuinely new source material — the only thing that changes when engine-side corpus ingestion (D018 §2.1/§2.2, separate spec) lands is that `sources[]` gets ingested once per engagement instead of resent on every request.

Fetch the result via the existing job-status mechanism keyed by `audit_id` (same pattern as `jobs/eval-run.ts`'s existing consumers use).

## What "done" looks like for this feature

- All three golden sets pass at their stated bars.
- Existing consumer eval suites (`evaluations/golden/reflection/`, `evaluations/no_bias/reflection/`) show no regression — confirms the mode-branching invariant (D018 §1) held and audit mode didn't leak into the story path.
- `docs/decisions/018-audit-mode-flag.md` needs no amendment to describe what got built — if it does, the plan or the ADR was wrong somewhere and should be reconciled before merging.
