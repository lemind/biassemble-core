# D018 — B2B Audit Mode: Service Boundary, Flow, and Verification

One ADR, three parts: where audit mode lives (§1), what it does end to end (§2), how bias findings get false-positive-checked (§3). Kept together because they're one coherent decision — how the audit product is built inside this repo — not three independently revisable choices.

---

## §1. Mode flag, not a separate service

**Decision**: The B2B audit product (ADR-000, top-level docs/) is built as `mode: "story" | "audit"` inside this repo — one deploy, one Postgres instance, new `audit` pg schema alongside the existing `core` schema. Not a new repo, not a fork.

Router picks prompt file + orchestrator by `mode`, same pattern as the existing question/assessment split in `orchestrators/`. EXTRACT and VERIFY (§2) are two new prompt files registered through the existing prompt registry — reusing the repair pipeline (D004), evidence-binding discipline (D002), and eval harness (`runEval`/`runDataset`, D008) as-is, applied to claims instead of biases. `/audit` runs go through Inngest (new *usage* of the job infra already proven by `src/jobs/eval-run.ts`, not new infra) since audits are batch, not sync — the latency-sensitivity work behind the sync reflection endpoints doesn't apply here.

**Why**: Audit mode needs almost everything this repo already has — prompt registry, Zod contracts, repair pipeline, `llm_calls` observability, CI eval gate, Bearer auth, esbuild→Vercel deploy. It differs only in persona (neutral verification vs. reflective), input shape (claim triple vs. story), and sync-vs-batch — none of which require a second deploy target. A separate service would duplicate all of the above for a solo dev who can't carry two deploy targets in parallel (ADR-000 §4: "parallel tracks ship nothing"). A permanent fork risks the consumer flow drifting out from under the eval discipline that's the actual product moat (ADR-000 §1).

**Do not**: Stand up a second repo/service for audit mode. Let the consumer flow (story/questions/assessment) change to accommodate audit mode — b2b-change-plan.md §0 requires it untouched. Put customer corpus data in the `core` schema — it goes in the separate `audit` schema (§2.4) so it can be dropped post-engagement without touching consumer tables.

**Consequences**: every existing investment pays off immediately for EXTRACT/VERIFY with no reimplementation; `mode` becomes a load-bearing conditional through routes → orchestrators → prompts (acceptable at current scope — revisit only if a second person/team takes ownership of one product, or audit-mode load genuinely conflicts with consumer-mode resources on the same deploy; neither holds today); corpus retrieval stays in biassemble-engine, extending its existing boundary (`POST /corpus`, per-claim `/retrieve`) rather than a third service — this section governs core-side placement only, not the core/engine split, which ADR-000 already implies.

---

## §2. The audit flow: pipeline, corpus, documents, verdicts, data lifecycle

**Decision (pipeline)**: unit of work is the **claim**, not the story:

```
EXTRACT (1 call: output_text → atomic checkable claims)
  → RETRIEVE (per claim: candidate passages from THIS ENGAGEMENT's corpus — taxonomy retrieval untouched)
  → VERIFY (claim + passages → verdict + verbatim quote, batched 5–10 claims/call sharing passages)
  → GATE (confidence threshold; aggregate rates; clean flag; sub-threshold logged not surfaced)
  → BIAS MODULE (optional, off by default, secondary layer, source_qa-verified per §3)
```

`POST /audit` accepts `{ mode: "audit", domain, task, output_text, sources[], options }`, returns the single-audit JSON (`audit_id`, `claims[]`, `rates`, `gated_candidates[]`, `bias_flags[]`, `meta`).

**§2.1 Corpus + embedding (product ADR-002)**: engine gains `POST /corpus { corpus_id, documents[] }` and `POST /retrieve { corpus_id, query, top_k }`. `corpus_id` scopes every row; one corpus per engagement, never shared across customers. MiniLM's 256-token limit is inadequate for 10-K-length passages — swap via the existing `EmbeddingProvider` interface (no new abstraction), exact model choice is an implementation task, not decided here; the contract is that it must be swappable the same way MiniLM was. **No migration exists because nothing existing changes**: corpus tables are new tables (`bias_embeddings`'s pattern is `embedding vector(384) NOT NULL` — dimension fixed by the column type, per the existing schema, not a per-row field), created at the new model's dimension; the taxonomy path stays on MiniLM/384 untouched; `embedding_model` is already recorded per row today (`db/queries.py`'s insert includes it) and the same column carries over to corpus tables. `corpus_version` stamped in every audit response, same discipline as `taxonomy_version`. Retrieval-score logged per claim, unconditionally — this is what lets "unsupported" mean "sources are silent" instead of "retrieval failed," same lesson as `kb_entries_retrieved`.

**§2.2 Document ingestion, v1 scope**: sources are PDFs and EDGAR HTML/XBRL, not clean text (silently assumed away in earlier drafts). V1 scopes to **EDGAR HTML only** — what the Fintool run (ADR-000 §4 step 6) needs, and it's structured markup, not scanned-PDF OCR. Output: clean text + page/section references, since `source_refs` quality in VERIFY output depends on it. PDF parsing deferred until a target past Fintool requires it — do not build it speculatively.

**§2.3 Verdict taxonomy — canonical, defined once, here**:
- `supported` — a passage states this; quote verbatim; 2+ passages combined sets `synthesized: true`.
- `partially_supported` — passage covers part of the claim, or is more general than the claim (source more specific and fully covering = `supported`).
- `unsupported` — no provided passage addresses the claim. Asserts absence from retrieved passages only, never "this is false."
- `contradicted` — a passage directly opposes the claim for the **same subject, measure, period, and scope (segment/geo/consolidated)** — strict comparability required. A different number possibly referring to a different period/measure/scope is `unsupported` with a note, never `contradicted`.
- `unverifiable` — confidence below `{{threshold}}`; verdict goes to trace only, never guessed into the report.

**Arithmetic happens in code, never in the LLM.** A deterministic normalization step runs between EXTRACT and VERIFY: units, scale, currency, and periods get parsed to canonical form, and derived values (growth rates, ratios, sums, pp-vs-% conversions) get computed in code from quoted source values. VERIFY's job is to *compare* already-canonical numbers, never to compute them — an implementer putting derivation arithmetic inside the VERIFY prompt is the exact failure this normalization step exists to prevent. Numeric rules VERIFY still applies post-normalization: unit/scale must match (€m vs €k mismatch = `contradicted` only if same measure/period/scope); rounding tolerance ("about 10%" vs 10.4% source = `supported` with note; "10.4%" vs 10.9% = `contradicted`). Every prompt and eval golden-set case cites this section, never restates its own definitions.

**§2.4 Customer data isolation & lifecycle**: corpus and audit data live in the `audit` pg schema (§1), never `core`. Binding before the first NDA: corpus documents deleted post-engagement; only anonymized override labels retained indefinitely as the moat dataset (ADR-000 §2) — overrides come from two places on the internal review page: the claims table's per-claim approve/override, and the bias-module findings' verification pass (§3); both feed the same label dataset. No customer corpus text persists past engagement close.

**Why**: All of §2 was already decided in `context-prompt-b2b-transformation.md` (§2–§6, §9 ADR seeds 2/4/5) and `audit-output-spec.md` — this section is the first time it's written down in the repo instead of scattered across a context-prompt file that lives in ~/Downloads, not here.

**Do not**: build PDF parsing before a target requires it; let corpus documents leak into the `core` schema or persist past engagement close; let any prompt or eval set restate the verdict taxonomy instead of citing §2.3; skip retrieval-score logging; let a prompt rewrite drop the data-not-instructions injection guard from EXTRACT/VERIFY (ADR-000 §6 names prompt injection via audited content as an actively-managed risk — the guard is a one-line clause per prompt today; keep it there through every future rewrite, don't rely on remembering why it's there).

**Consequences**: one section to check when a new prompt, eval case, or schema field touches claims, corpus, or verdicts. EDGAR-HTML-only v1 scope means a second document-source target (GC AI, Hudson Labs, etc.) may need PDF parsing sooner than "past Fintool" implies — revisit the moment target #2 is selected. Inngest batch execution for `/audit` is unproven at customer-corpus scale until the Fintool run. Cost telemetry (token/call counts per audit) ships as part of `/audit`, not retrofitted after — without it the $3k fee is a guess against actual cost (change-plan gap #4).

---

## §3. Source-answered verification (source_qa)

**Decision**: the bias-module's existing stage-2 question generator is repurposed for audit mode: its generated verification questions get answered from the source/input text itself (`method: "source_qa"`), not by a human. Per `audit-output-spec.md`, each bias-module finding carries:

```json
"verification": { "status": "confirmed | weakened | killed", "method": "source_qa | human_qa | none", "note": "..." }
```

`human_qa` stays wired for the consumer story product only; audit mode can only reach `source_qa`. This attaches to **bias-module findings**, not grounding claims — claim verdicts (§2.3) are already source-answered by construction (VERIFY only ever looks at retrieved passages, never model knowledge). An additional source_qa confirmation pass on low-confidence claims near the threshold boundary is allowed but not committed here — scope that at `/audit` build time if needed, not now.

**Why**: original design, not new scope — `audit-output-spec.md`'s "Key changes" item 3 states it directly: "verification block per finding = repurposed stage 2 ... turns phase 2 into the false-positive control." Reuses the existing question generator as-is — only the answer source changes. Skipping this would leave the bias module's FP control *weaker* than the consumer product's, against ADR-000 §2's headline goal.

**Do not**: make `human_qa` reachable from audit mode (§1 already forbids a human mid-run; `source_qa` is machine-only, no contradiction). Attach a `verification` block to grounding claims by default — VERIFY already is that check for claims. Surface a finding whose `verification.status` is `"killed"` — killed candidates are `gated_candidates`, logged, never shown.

**Consequences**: bias-module findings get the same silent-sub-threshold FP discipline the consumer product has, answered from documents instead of a person, no new prompt shape. Grounding claims stay single-pass unless the optional confirmation pass is explicitly scoped later. `findings[].verification.{status,method,note}` joins the schema surface; prompt registry needs an audit-mode-only route to the question generator's source_qa variant.

---

**Source**: ADR-000-b2b-audit-path.md (top-level docs/, §4 step 2/4, §6, §7); b2b-change-plan.md §0, §2, §6 (gaps #1, #3, #4); `context-prompt-b2b-transformation.md` (top-level docs/, moved in from ~/Downloads) §2, §3.1, §5, §8 step 6, §9 ADR seeds 1/2/4/5; `audit-output-spec.md` (top-level docs/, moved in from ~/Downloads) — `findings[].verification` schema, `kb_entries_retrieved` precedent, single-audit/batch schema; `context-prompt-biassemble-overview.md` (~/Downloads, not yet moved in) §5 step 3 confirms numeric normalization is code-not-LLM.
