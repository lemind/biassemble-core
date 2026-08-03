# Phase 1 Data Model: B2B Audit Mode

Entities below correspond to the spec's Key Entities section, made concrete per the research decisions (§2 identifiers, §4 numeric fact shape, §5 score computation). All new tables live in the `audit` pg schema (D018 §2.4), never `core`.

## Audit

One complete pipeline run over one submitted `{ output_text, sources[], task }` input.

| Field | Type | Notes |
|---|---|---|
| `audit_id` | UUID, PK | Assigned once at pipeline entry (research §2). Never reused. |
| `input_ref` | string (sha256 hex) | Hash of the normalized input triple. Two audits sharing this value are recognized as re-runs of the same input (FR-013) without being merged. |
<!-- `mode` field removed on review: an earlier draft justified it as "schema parity with the existing runs table's mode-adjacent fields" — checked src/db/schema.ts directly, no such field exists anywhere in the current schema. Same false-premise error as the removed T002 (Setup phase). This table already lives in the `audit` pg schema (D018 §2.4); every row is definitionally an audit. -->

| `domain` | enum `general \| finance \| legal \| healthcare` | From request. |
| `status` | enum `running \| complete \| failed` | Set `complete` only after GATE finishes; immutable once `complete` or `failed` (D018 append-only rule — `failed` is a real, permanent terminal state, not a transient error to retry silently). |
| `failed_stage` | enum `extract \| retrieve \| verify \| gate`, nullable | **Added on review** — which pipeline stage failed, null unless `status = "failed"`. If the failure originated in EXTRACT or VERIFY, it's also recorded as a normal row in the existing `llm_calls` observability table (it's an LLM call, D004's existing pattern applies); RETRIEVE and GATE failures are not LLM calls and have no `llm_calls` row — `failed_stage`/`error_summary` here are their only record. |
| `error_summary` | string, nullable | **Added on review** — human-readable failure reason, null unless `status = "failed"`. |
| `created_at` | timestamp | |
| `completed_at` | timestamp, nullable | Null while `running`. |
| `prompt_revision_extract` | string | Stamped at EXTRACT call time. |
| `prompt_revision_verify` | string | Stamped at VERIFY call time. |
| `model_revision_extract` | string | Exact model identifier used for EXTRACT. |
| `model_revision_verify` | string | Exact model identifier used for VERIFY. |
| `corpus_id` | string | **Split from `corpus_ref` on review** — answers the customer-facing question "which documents did you check against?" **Corrected on a later review pass**: an earlier draft set this to the static label `"request-sources"` for every audit, which doesn't actually answer that question — two audits against genuinely different source documents would be indistinguishable. In this feature (no persistent per-engagement corpus yet, D018 §2.1), it's a SHA-256 hash of the normalized `sources[]` content, computed the same way as `input_ref` (T006's hash utility, different input) — content-addressed, so identical source sets produce the same `corpus_id` and different ones don't collide. Once engine-side ingestion lands, this becomes the real per-engagement `corpus_id` issued at ingestion time. |
| `retrieval_provider` | string | Answers the engineering question "which retrieval implementation produced this?" — e.g. `"stub-lexical"` today, the engine's identifier later. Conflating this with `corpus_id` under one field (as an earlier draft's `corpus_ref` did) answers neither question well once real corpus ingestion exists — a customer asking "which documents" doesn't want "which code version" as the answer. |
| `threshold` | number | Confidence gate threshold in effect for this run. |
| `pipeline_code_version` | string | Git SHA or package version at run time. |
| `truncated` | boolean | True if EXTRACT hit `options.maxClaims` for this audit (FR-019). Lives here, not on Claim — EXTRACT runs once per audit and the cap is a property of that one call's output, not of any individual claim (**moved here on review** — an earlier draft placed this on Claim, which had no single claim it could correctly attach to and contradicted T015's own description). |

**Validation**: `completed_at` MUST be null while `status = "running"` and non-null once `status = "complete"`. `input_ref` MUST be computed identically for identical input (deterministic hash, no timestamp/nonce mixed in) — this is what makes re-run linkage (FR-013) work.

## Claim

One atomic, checkable factual statement extracted from `output_text`.

| Field | Type | Notes |
|---|---|---|
| `claim_id` | UUID, PK | Assigned at EXTRACT (research §2). Stable through every later stage. |
| `audit_id` | UUID, FK → Audit | |
| `type` | enum `numeric \| entity \| attribution \| causal \| derived` | Per EXTRACT's type taxonomy. |
| `claim_text` | string | Near-original wording, per EXTRACT rules. |
| `excerpt` | string | Verbatim substring of `output_text`. |
| `locations` | string[] | Sentence-position tags (e.g. `["p1s2"]`), matching the golden set's convention — recorded, not currently scored (per golden-set README §"locations"). |
| `period` | string | Resolved period, or `"unresolved"`. |
| `derived` | boolean | |
| `passages_retrieved_count` | int | Set by RETRIEVE before VERIFY runs — how many passages were found for this claim, independent of what VERIFY concludes from them. This is what makes "no evidence found" (count = 0) distinguishable from "evidence found but didn't address/support the claim" (count > 0, verdict still `unsupported`) — both currently collapse to the same verdict enum value; this field is the only place the distinction survives (FR-009). Aggregated at Score Summary as `retrieval_coverage`. |
| `retrieval_status` | enum `ok \| error` | **Added on review** — `passages_retrieved_count = 0` alone cannot distinguish "retrieval ran and genuinely found nothing" from "retrieval itself failed (timeout, corpus-client threw)." Without this field both collapse to the same signal and the spec's own edge case ("operator must be able to tell nothing relevant exists apart from the lookup didn't happen") is unmet. `error` MUST NOT be silently swallowed into `passages_retrieved_count = 0` — a caught exception in `corpus-client.ts` sets this to `error`, not a quiet empty result. |

**Validation**: `excerpt` MUST be an exact substring of the parent Audit's `output_text` (schema-level check, not just convention) — an EXTRACT response whose excerpt doesn't literally appear in the source text fails validation and is treated as a malformed response (routed to repair per D004, unless it also trips the injection heuristic per research §7).

## Verdict

The outcome of evaluating one Claim against its retrieved Source Passages. Modeled as a 1:1 extension of Claim (not a separate lifecycle entity) — a Claim without a Verdict yet is mid-pipeline, not a different kind of thing.

| Field | Type | Notes |
|---|---|---|
| `claim_id` | UUID, PK, FK → Claim | |
| `verdict` | enum `supported \| partially_supported \| unsupported \| contradicted \| unverifiable` | Canonical five, D018 §2.3. |
| `evidence` | string[], nullable | Verbatim quote(s); null only for `unsupported`/`unverifiable`. |
| `source_refs` | string[] | `passage_id` references, never raw text duplicated here. |
| `synthesized` | boolean | True iff `evidence.length > 1` combining passages (FR-018, D018 §4.3 rule 3). |
| `confidence` | number, 0–1 | From VERIFY only — never derived from or blended with any passage's `retrieval_score` (FR-020). |
| `note` | string, nullable | Rounding/period/derivation explanation. |

**Validation**: `verdict = "contradicted"` MUST have non-null `evidence` and MUST have passed the comparability check in `compare.ts` (research §4) for all of subject/measure/period/scope — enforced in code before persistence, not just prompted for.

## Source Passage

A retrieved excerpt considered as candidate evidence. Deduplicated within an audit — the same span of source text retrieved for two different claims is one `SourcePassage` row, not two.

| Field | Type | Notes |
|---|---|---|
| `passage_id` | UUID, PK | Assigned at retrieval (research §1/§2), stub or real. |
| `audit_id` | UUID, FK → Audit | Passages are scoped to one audit's corpus reference, never shared across audits from different engagements. |
| `doc_id` | string | Which source document. |
| `location` | string | Page/section reference (D018 §2.2 — full ingestion refs are out of scope here; the stub carries the golden set's `location` tags as a stand-in). |
| `text` | string | The passage text. |

## Claim Passage (junction — added on review)

**Why this exists, not just fields on `SourcePassage`**: the Relationships section below has always declared `Verdict *──* SourcePassage` (many-to-many — "a passage may support multiple claims, a claim may cite multiple passages"), but `SourcePassage` alone has nowhere to record *retrieval-time* facts that are properties of one specific claim-passage pairing, not of the passage itself — how it ranked for *this* claim's retrieval, and what its `retrieval_score` was *for this claim* (the same passage can legitimately score differently against two different claims' queries). Putting those fields directly on `SourcePassage` would silently assume one passage is retrieved for exactly one claim, which contradicts the many-to-many relationship already declared. The junction is what makes that relationship actually representable, not just stated.

| Field | Type | Notes |
|---|---|---|
| `claim_id` | UUID, FK → Claim | |
| `passage_id` | UUID, FK → SourcePassage | |
| `retrieval_rank` | int | Position in this claim's retrieval results (1 = most relevant candidate for this claim). |
| `retrieval_score` | number, 0–1 | This passage's relevance score *for this claim's query* — evidence quality, never confidence (research §4, FR-020). Distinct from any other claim that also retrieved this same passage. |
| `selected_for_verification` | boolean | Whether this passage was among those actually passed to VERIFY for this claim (a naive stub might retrieve 10 and pass only the top 3 — this records which). |

This gives full retrieval provenance per claim: "these were the top-5 candidates retrieved for claim X, in this order, with these scores; VERIFY was shown the top 3; it cited passages 1 and 3 in its verdict" — all reconstructable, not just the final cited subset.

## Score Summary

The business-facing metrics for one completed Audit. Computed once at GATE (research §5), persisted, immutable thereafter.

| Field | Type | Notes |
|---|---|---|
| `audit_id` | UUID, PK, FK → Audit | 1:1 with Audit. |
| `counts_supported` (S) | int | |
| `counts_partially_supported` (P) | int | |
| `counts_unsupported` (U) | int | |
| `counts_contradicted` (C) | int | |
| `counts_unverifiable` (X) | int | |
| `eligible` | int | `S+P+U+C`. |
| `grounded_rate` | number | `(S + 0.5·P) / Eligible`. |
| `groundedness_score` | int | `round(100 · grounded_rate)`. |
| `strict_supported_rate` | number | `S / Eligible`, no partial credit. |
| `contradiction_rate` | number | `C / Eligible`. |
| `unsupported_rate` | number | `U / Eligible`. |
| `retrieval_success_rate` | number | **Replaces the old single `evidence_coverage` field, which was defined two different ways in two places on the same page (caught on review) — split into the two distinct questions it was conflating.** Share of claims where `retrieval_status = "ok"` (did the retrieval mechanism itself work) / total claims. |
| `retrieval_coverage` | number | Share of claims with `retrieval_status = "ok"` AND `passages_retrieved_count > 0` / total claims (did retrieval find any usable candidate, given that it ran). This is the old Claim-entity note's definition ("share of claims with `passages_retrieved_count > 0`"); the old Score-Summary-entity definition ("≥1 passage above the retrieval-score floor") was a third, still-different threshold that matched neither and is dropped rather than kept as a fourth option. |
| `avg_evidence_quality` | number | Mean `retrieval_score` (from `ClaimPassage`) over claims with `retrieval_coverage`. Deliberately **not** renamed to "avg retrieval score" despite that being raised on this review — D018 §2.3/§4.1 locks this exact name specifically to keep it visibly distinct from "confidence," and that's an ADR decision, not a naming accident; revisit only via a D018 amendment with real evidence it's caused confusion, not a pre-launch style preference. |
| `synthesized_count` | int | **Added on review** — count of `supported`/`partially_supported` claims where `Verdict.synthesized = true`. D018 §4.3 rule 3 already requires `synthesized` to be visible per claim as "the known hallucination-adjacent zone"; without an aggregate, a buyer has to manually count it across every claim to ask "how many of your supported claims required combining passages?" instead of reading it off the summary. |
| `low_decisiveness` | boolean | `X / (S+P+U+C+X) > 0.20`. |

**Validation**: `S+P+U+C = Eligible` and `Eligible + X = ` total claim count for the audit, always — a mismatch here is a bug in GATE, not a data-entry possibility, so this is enforced as an invariant check at persistence time, not just documentation.

**Zero-denominator guard (added on review)**: `Eligible = 0` is reachable — an empty `sources[]` (explicitly permitted, FR-002's Assumptions) or a threshold gating every claim to `unverifiable` both produce it. When `Eligible = 0`: `grounded_rate`, `groundedness_score`, `strict_supported_rate`, `contradiction_rate`, and `unsupported_rate` are all persisted as `null`, never `NaN` or a divide-by-zero exception — the audit's `rates`/`scores` response carries an explicit `"insufficient_eligible_claims": true` flag instead of a fabricated number. Same rule for `avg_evidence_quality` when zero claims have `retrieval_coverage` (mean of an empty set) — `null`, with `retrieval_success_rate`/`retrieval_coverage` still correctly reported as `0`, not `null` (coverage of zero is a real, well-defined number; the two must not be conflated).

**Retrieval-failure gate rule (added on review)**: a claim with `retrieval_status = "error"` MUST NOT resolve to `verdict = "unsupported"` — that would silently present an infrastructure failure as if the sources had been checked and found silent. It resolves to `unverifiable` instead (never guessed, per D018 §2.3), keeping infrastructure failures out of `unsupported_rate`/`contradiction_rate` entirely rather than contaminating them.

## Relationships

```
Audit 1──* Claim 1──1 Verdict
Audit 1──* SourcePassage
Claim *──* SourcePassage   via ClaimPassage (retrieval_rank, retrieval_score, selected_for_verification — per-pairing facts)
Verdict.source_refs ⊆ ClaimPassage.selected_for_verification=true passages for that claim   (evidence actually cited is a subset of everything retrieved)
Audit 1──1 ScoreSummary
```
