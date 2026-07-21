# Contract: POST /audit

## Request

```json
{
  "mode": "audit",
  "domain": "finance | legal | general | healthcare",
  "task": "optional: the question the audited AI was answering + as-of date",
  "output_text": "the AI-generated text under audit",
  "sources": [ { "id": "doc1", "name": "ACME 10-Q Q2 2026", "text": "..." } ],
  "options": { "threshold": 0.60, "maxClaims": 50 }
}
```

- `output_text` and `sources[]` are required and MUST be treated strictly as data, never instructions (FR-010), regardless of their content.
- `sources[]` MUST NOT be empty for a meaningful audit (an audit with zero sources will find every claim unsupported by definition) but an empty array is not rejected outright — it's a valid, if degenerate, input per the "sources are silent" principle (D018 §2.3).
- Response is asynchronous: this endpoint enqueues an Inngest job (D018 §1) and returns `202 Accepted` with `{ audit_id }` immediately; it does not block on pipeline completion, per this feature's Performance Goals (not latency-sensitive).

## Response (immediate, on submission)

```json
{ "audit_id": "uuid", "status": "running" }
```

## Result (fetched separately once complete, or delivered via the existing job-completion mechanism)

```json
{
  "audit_id": "uuid",
  "input_ref": "sha256...",
  "domain": "finance",
  "claims": [
    {
      "claim_id": "uuid",
      "type": "numeric",
      "claim": "...",
      "excerpt": "...",
      "locations": ["p1s2"],
      "period": "Q2 2026",
      "derived": false,
      "retrieval_status": "ok",
      "passages_retrieved_count": 3,
      "verdict": "supported",
      "evidence": ["..."],
      "source_refs": ["passage-uuid"],
      "synthesized": false,
      "confidence": 0.91,
      "note": null
    }
  ],
  "truncated": false,
  "rates": { "findings_count": 0, "gated_out_count": 0 },
  "scores": {
    "grounded_rate": 0.833,
    "groundedness_score": 83,
    "strict_supported_rate": 0.667,
    "contradiction_rate": 0.0,
    "unsupported_rate": 0.0,
    "retrieval_success_rate": 1.0,
    "retrieval_coverage": 1.0,
    "avg_evidence_quality": 0.81,
    "synthesized_count": 4,
    "counts": { "S": 20, "P": 10, "U": 0, "C": 0, "X": 0 },
    "eligible": 30,
    "low_decisiveness": false,
    "insufficient_eligible_claims": false
  },
  "gated_candidates": [],
  "bias_flags": [],
  "meta": {
    "prompt_revision": { "extract": "v2", "verify": "v2" },
    "model_revision": { "extract": "gemini-2.5-flash", "verify": "gemini-2.5-flash" },
    "corpus_id": "sha256:a1b2c3...",
    "retrieval_provider": "stub-lexical",
    "threshold": 0.60,
    "pipeline_code_version": "..."
  }
}
```

**Added on review**: `mode` dropped from this response — data-model.md dropped it from the Audit entity for the same reason (redundant; this is the `/audit` endpoint's own result, there's no other mode it could be). `claims[].retrieval_status`/`passages_retrieved_count` now exposed per claim, not just internal — this is what lets a drill-down UI show "no relevant evidence retrieved" vs. "evidence retrieved but didn't support this claim" for the same `unsupported` verdict, which is exactly the distinction a buyer asks about first. `corpus_ref` split into `corpus_id`/`retrieval_provider` in `meta`, matching data-model.md's Audit entity split — "which documents did you check against" and "which retrieval code produced this" are different questions with different answers once real corpus ingestion exists. `corpus_id` is content-addressed (SHA-256 of the normalized `sources[]`, not a static label — corrected on a later review pass after an earlier draft made it a fixed string that couldn't actually distinguish different source sets from each other).

This mirrors D018 §2's schema-reconciliation decision: flat `claims[]` + `bias_flags[]` (the latter empty in this feature, since the bias module/source_qa pass is out of scope — D018 §3), not `audit-output-spec.md`'s superseded nested shape. `bias_flags[]` is included in the contract now, always empty, so the later spec that implements D018 §3 extends this contract rather than introducing a breaking change to it.

**`rates` vs `scores`, disambiguated on review**: these are two different, unrelated things that happen to sit next to each other, and the name `rates` is a holdover that's easy to misread as a synonym for `scores`. `rates.findings_count`/`gated_out_count` count **bias-module findings** (the `audit-output-spec.md` §A original meaning of those two field names) — since the bias module (D018 §3) is out of scope for this feature, both are always `0` here, not yet meaningful. `scores` is the claim-verdict business-metrics block (D018 §4) and is the one this feature actually computes. Do not confuse the two, and do not read `context-prompt-b2b-transformation.md` §6's older `rates { total, supported, ... grounded_rate }` shape as authoritative — that shape predates D018 §4 and is superseded by `scores` above, the same way `audit-output-spec.md`'s worked example was (D018 §4.1).

`scores.insufficient_eligible_claims` (added on review, data-model.md's zero-denominator guard): `true` when `Eligible = 0` (empty `sources[]`, or every claim gated below threshold) — in that case `grounded_rate`, `groundedness_score`, `strict_supported_rate`, `contradiction_rate`, and `unsupported_rate` are all `null`, never `NaN`, and a consumer of this contract MUST check this flag before trusting those fields as numbers. `truncated` (top-level, added on review) reflects whether EXTRACT hit `options.maxClaims` for this audit — it's an Audit-level fact (one EXTRACT call per audit), not a per-claim field.

`scores.evidence_coverage` is gone, replaced by two fields (added on review — the single field was defined two contradictory ways across `data-model.md`, caught during a later pass): `retrieval_success_rate` (did retrieval run without error) and `retrieval_coverage` (did it find anything, given that it ran). A claim with `retrieval_status: "error"` never resolves to `verdict: "unsupported"` — it resolves to `unverifiable`, so infrastructure failures never contaminate `unsupported_rate`/`contradiction_rate` (data-model.md's retrieval-failure gate rule). `scores.synthesized_count` is new — the aggregate of per-claim `synthesized: true`, since D018 §4.3 rule 3 already requires that flag to be visible and a buyer shouldn't have to count it by hand across every claim.

## Error responses

- `400` — request fails Zod validation (missing `output_text`, malformed `sources[]`).
- `202` is the only success status for submission; there is no synchronous success path for this endpoint.
- A pipeline-internal failure (e.g. injection-heuristic rejection with no valid claims recoverable, per research.md §7) does not fail the HTTP request — it completes the audit with `status: "failed"` and a `meta.failure_reason`, since the request was already accepted asynchronously.
