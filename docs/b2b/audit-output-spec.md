# Biassemble — Company-Style Audit Output Spec (v0.2)
### What to add to core during the RAG-integration stage
### AMENDED: the `rates`/`grounded_rate` worked example below was superseded by `biassemble-core/docs/decisions/018-audit-mode-flag.md` §4.1 (the business metrics layer wasn't designed yet when this doc was written). `grounded_rate` is now `(S + 0.5·P) / Eligible`, not `supported/total` — updated below to match, so this file and D018 cannot diverge again. D018 §4 is canonical; this file is historical context only from here down.

Two output layers: **(A) single-audit JSON** (one input text) and **(B) batch report** (aggregation over N inputs — this is what a company buys). Build A fully; B is mostly computation over A results.

---

## A. Single-audit JSON — extended schema

```json
{
  "audit_id": "uuid",
  "input_ref": "sha256-of-input-text",
  "mode": "story | audit",
  "domain": "general | finance | legal | healthcare",
  "clean": false,

  "findings": [
    {
      "bias": "anchoring",
      "confidence": 0.86,
      "severity": "high | medium | low",
      "evidence": ["verbatim excerpt, character-for-character from input"],
      "reasoning": "why THIS excerpt indicates the bias (not a definition)",
      "counterfactual": "what sound reasoning would have done instead",
      "downstream_risk": "the concrete decision this could distort",
      "verification": {
        "status": "confirmed | weakened | killed",
        "method": "source_qa | human_qa | none",
        "note": "what stage 2 found when checking this candidate"
      }
    }
  ],

  "grounding": {
    "enabled": true,
    "sources_provided": ["source-doc-ref-1"],
    "claims": [
      {
        "claim": "extracted factual claim from the input",
        "verdict": "supported | unsupported | contradicted | partially_supported",
        "source_evidence": "verbatim quote from source doc, or null",
        "source_ref": "which doc / location",
        "confidence": 0.91
      }
    ]
  },

  "rates": {
    "findings_count": 3,
    "gated_out_count": 2
  },

  "scores": {
    "grounded_rate": 0.833,
    "groundedness_score": 83,
    "strict_supported_rate": 0.667,
    "contradiction_rate": 0.0,
    "unsupported_rate": 0.0,
    "evidence_coverage": 1.0,
    "avg_evidence_quality": 0.81,
    "counts": { "S": 20, "P": 10, "U": 0, "C": 0, "X": 0 },
    "eligible": 30,
    "low_decisiveness": false
  },

  "gated_candidates": [
    { "bias": "anchoring", "confidence": 0.55, "evidence": ["..."] }
  ],

  "meta": {
    "model_used": "gemini-2.5-flash",
    "prompt_version": "v1.5",
    "threshold": 0.60,
    "knowledge_pack": "general/v1",
    "kb_entries_retrieved": ["anchoring/v2", "sunk_cost/v1", "confirmation/v3"],
    "phases_run": ["initial", "verification"],
    "duration_ms": 8421
  }
}
```

### Key changes vs. current output, with rationale

1. **`confidence` visible per finding.** Currently hidden. It's a headline product claim; it must appear in output.
2. **`gated_candidates` (logged, not surfaced to end user).** Sub-threshold detections with scores. This is the fix for the anchoring-miss bug class: you cannot debug silent drops you don't record. In audit mode, keep internal; in the report, only the count appears.
3. **`verification` block per finding = repurposed stage 2.** The question generator's questions get answered **from the source/input text itself** (`method: source_qa`), not by a human. Each answer confirms, weakens, or kills the candidate. This turns phase 2 into the false-positive control. Add a mode flag so the human-Q&A path (`human_qa`) still works for the story product.
4. **`grounding` block — the company-audit core.** For audit mode with source docs provided: extract factual claims from the input, bind each to a verbatim source quote or mark unsupported/contradicted. This is claim-level, separate from bias findings. Verdicts: supported / unsupported / contradicted / partially_supported.
5. **`rates` block.** All the numbers the report needs, computed per audit so batch aggregation is trivial.
6. **`kb_entries_retrieved` in meta.** Log which knowledge-base entries RAG injected. Debuggability for cause (c) of the anchoring bug: if anchoring never appears here, retrieval is the problem, not detection.
7. **`mode: audit` strips the reflection prompt** (it addresses a human author who doesn't exist in audit mode) and disables the human-question phase.
8. **Evidence-disjointness rule (post-processing):** two findings may not rest on the same evidence excerpt. On collision, keep the higher-confidence finding or merge (e.g., cherry-picking folds into confirmation bias). Prevents double-billing.

### RAG-connection requirements (since you're wiring it now)

- KB entry format per bias per domain: `indicators` (narrative phrasings, not textbook definitions — "figure survived revisions" must match anchoring), `worked_examples`, `known_false_positives` (what looks like this bias but isn't).
- Retrieval must log what it selected (`kb_entries_retrieved`) and ideally similarity scores.
- Version the knowledge pack; put version in meta. Reports must be reproducible.
- Test case to add immediately: the Marta story must retrieve the anchoring entry. If it doesn't, enrich the entry's indicators before touching detection logic.

---

## B. Batch report (N audited outputs → the sellable document)

Computed from A-results. Structure:

1. **Header:** company, product audited, sample size, date range, method one-liner, knowledge-pack + prompt versions (reproducibility).
2. **Headline (one sentence, their numbers):** "Of 214 claims across 40 outputs: 187 supported (87%), 19 unsupported (9%), 8 contradicted by source (4%)."
3. **Severity table:** contradicted > unsupported > partially supported; counts + which output types they cluster in.
4. **Worked examples (5):** claim → source passage or absence → why it fails → what a user relying on it gets wrong. Auto-select: highest-severity, highest-confidence, distinct output types.
5. **Clean rate, stated prominently:** "% of outputs with zero findings" + gated-candidates count as proof of restraint ("N low-confidence signals were suppressed, not reported").
6. **Bias findings section (if bias mode on):** per-bias counts, confidence distribution, verification outcomes (how many candidates stage 2 killed — this number sells the FP discipline).
7. **Pattern diagnosis:** where failures concentrate (auto-groupable by output type / source type; narrative written by human for v1).
8. **Recommendations + path:** fixes, then the continuous-API upsell paragraph.

Report generation for v1: a script that takes N single-audit JSONs and emits markdown sections 1–6 automatically; 7–8 written by hand per engagement. Do not build a dashboard yet.

---

## Build order for this stage

1. `gated_candidates` logging (one day, unblocks the anchoring bug later)
2. `confidence` + `severity` + `meta` exposure in output
3. RAG wiring with `kb_entries_retrieved` logging + the Marta-retrieves-anchoring test
4. `grounding` block (claims extraction + source binding) — the biggest new piece; it reuses the evidence-binding machinery pointed at source docs instead of the input itself
5. `verification` via source_qa (repurpose question generator)
6. Evidence-disjointness post-processor
7. Batch aggregation script → markdown report

1–3 are small and instrument everything. 4 is the company product. 5–7 can trail.
