# Phase 0 Research: B2B Audit Mode

No `[NEEDS CLARIFICATION]` markers were left in the Technical Context — this repo's stack is already fixed and well-documented (see `docs/eval-runners.md`, `docs/testing-philosophy.md`, existing `reflection/` code). The research below resolves the *design* decisions the spec and D018 leave open at the plan level, not stack unknowns.

## 1. Retrieval stub, kept swappable

**Decision**: `src/rag/corpus-client.ts` exposes one function, `retrievePassages(claim, sources[]) → Passage[]`, matching the *output* shape D018 §2.1 defines for the future engine `POST /retrieve` call (passages with `passage_id`, `doc_id`, `location`, `text`, `retrieval_score`), but taking the request's own `sources[]` directly as input — **not** a `corpus_id` reference into some pre-ingested store, since that store doesn't exist yet (D018 §2.1/§2.2 are out of scope). The stub does naive lexical retrieval (keyword/substring overlap scoring) over whichever `sources[]` the caller actually submitted in the request, chunked by paragraph. This works identically whether the caller passes the golden set's `source-filing.md` excerpts as `sources[]` text (as the integration tests do) or genuinely new source material from a live call — there is no special "fixture reference" field, because there's nothing for one to point at that isn't already in the request.

**Rationale**: `audit.service.ts` and everything downstream of retrieval must not know or care whether passages came from a stub or the real engine — D018 §1's mode-branching invariant (branching confined to orchestration) extends naturally to "retrieval-source branching confined to one client module." Swapping the stub for a real HTTP call (`corpus_id`-keyed, pre-ingested) later is a change to this one module's internals, not to its call signature's *meaning* — though the signature itself does change from `sources[]` to `corpus_id`, since the whole point of D018 §2.1 is that ingestion happens once per engagement, not per request. That signature change is accepted as this feature's one known seam to revisit when the engine work lands, not hidden behind a false abstraction now.

**Alternatives considered**: A `corpusRef`/fixture-lookup design where the stub resolves a reference against a hardcoded file instead of the request's own `sources[]` — **rejected on review**: it has no way to be invoked from a real API request (there is no field in the contract for a caller to supply such a reference, and inventing one just to satisfy a stub would be request-schema scope creep for a feature that's explicitly not building corpus ingestion). Mocking at the test layer only (no `corpus-client.ts` module at all) — rejected, every call site would need its own swap-out later instead of one.

## 2. Identifier strategy (claim_id, passage_id, audit_id)

**Decision**: `claim_id` and `passage_id` are UUIDv4, generated at the point each is first created (EXTRACT for claims, corpus-client retrieval for passages) and carried by reference (never regenerated or re-derived) through every later stage. `audit_id` is also UUIDv4, generated once per pipeline run at `audit.service.ts`'s entry. `input_ref` is a SHA-256 hash of the normalized `{ output_text, sources[], task }` triple, computed once and stored alongside `audit_id` — this is what lets two audits from identical input be recognized as linked (FR-013) without being the same row.

**Rationale**: Matches this repo's existing pattern exactly — `input_ref` mirrors the `sha256-of-input-text` field already named in `audit-output-spec.md`'s worked example, and UUIDv4 is what the existing `runs`/`reasoning_traces` tables already use for row identity (no new ID scheme introduced).

**Alternatives considered**: Deriving `claim_id` from content hash (hash of the claim text) instead of a random UUID — rejected, because two genuinely different claims can have identical text in edge cases (deduped claims, per EXTRACT's own dedup rule), and a content-hash scheme would collide them; a UUID assigned at creation time has no such failure mode.

## 3. Prompt registry integration

**Decision**: EXTRACT and VERIFY prompt templates live under `src/prompts/audit/extract/` and `src/prompts/audit/verify/`, each registered in the existing `src/prompts/registry.ts` the same way `reflection`'s prompts are — by `(mode, stage) → template + version` lookup. No changes to `registry.ts`'s lookup mechanism itself, only new entries.

**Rationale**: D018 §1 explicitly calls for reusing the prompt registry as-is. Confirmed by reading `registry.ts` that its lookup is already keyed generically, not hardcoded to reflection's two stages.

**Alternatives considered**: A separate registry for audit prompts — rejected, duplicates working infrastructure for no benefit and risks the two registries' versioning schemes drifting apart.

## 4. Numeric fact representation

**Decision**: Internally, a "numeric fact" (claim-side or source-side) is represented as `{ value: number, unit: string | null, scale: string | null, period: string | null, scope: string | null, hedge: string | null }` — directly matching the shape already used in `evaluations/golden/audit/numbers-golden-set.json`'s `claim`/`source` fixture objects, so the golden set can be loaded and run against `compare.ts` with no translation layer. `derive.ts` operates on lists of these plus a `derived_op` (`pct_change | sum | share`) per the same fixture shape.

**Rationale**: The golden set already exists and its shape was designed against D018 §2.3's rules; matching it exactly means the 20 cases become the module's test suite verbatim, with zero fixture-format conversion to maintain.

**Alternatives considered**: A richer typed value-object model (e.g. a `Money` class, a `Percentage` class) — rejected as premature structure for a first implementation; the flat shape already validated by the golden set is sufficient and the plan should not invent complexity the golden set doesn't exercise.

## 5. Score computation location

**Decision**: `gate.service.ts` computes the full `scores` block (D018 §4.1–§4.3: `grounded_rate`, `groundedness_score`, `strict_supported_rate`, `contradiction_rate`, `unsupported_rate`, `retrieval_success_rate`, `retrieval_coverage`, `avg_evidence_quality`, `synthesized_count`, `counts`, `eligible`, `low_decisiveness`, `insufficient_eligible_claims` — field list updated on a later review pass, see data-model.md's Score Summary for the current canonical list) as a pure function of the verdict list produced by `verify.service.ts` — no database round-trip needed to compute it, no LLM call in its path.

**Rationale**: D018 §4.3 rule 5 states this must be unit-testable against hand-computed fixtures, which requires it to be a pure function over already-known inputs (verdict counts), not something that queries other state.

**Alternatives considered**: Computing scores lazily at read-time (API-response construction) instead of at GATE — rejected; D018 §2 identity/versioning rules require the audit record to be immutable once complete, and the scores are part of "complete" — computing them once at GATE and persisting them keeps that guarantee intact rather than risking a scores value that could differ between two reads of the same audit if the computation logic changes later.

## 6. VERIFY batching, independence enforcement

**Decision**: Claims are grouped into batches of 5–10 sharing the same or overlapping retrieved passages (grouping heuristic: claims retrieving from the same source document). Each batch is one VERIFY prompt call. `verify.service.ts` never passes one claim's verdict as context into evaluating another claim in a *later call* — that much genuinely is by construction, since separate calls share no state. **Within one batch call, independence is not automatic and this section previously overstated it** (caught on review): the frozen `docs/b2b/context-prompt-b2b-transformation.md` §5 prompt text has a per-claim *output* structure, but nothing instructs the model to evaluate each claim without letting earlier reasoning in the same generation bleed into later claims — an LLM can still let its read of a shared passage while evaluating claim 1 color its evaluation of claim 2. Per-claim JSON output slots constrain the *shape* of the response, not the *independence* of the reasoning that produced it. The actual prompt text written in US1 (T016) MUST add an explicit instruction (e.g. "evaluate each claim in CLAIMS independently; do not let your assessment of one claim influence another, even when they share passages") — this is one of several deltas from the frozen §5 reference text that T016 needs to apply, cross-referenced there rather than duplicated here.

**Rationale**: Directly implements D018's batching-independence invariant (A7). Grouping by shared source document (not by claim order or arbitrary chunking) is what makes "sharing passages per call" (the stated batching rationale) actually reduce token cost instead of batching claims that share nothing.

**Alternatives considered**: Fixed-size batching by claim order regardless of shared passages — rejected, defeats the token-efficiency rationale batching exists for in the first place.

## 7. Injection-guard hard stop, not repair

**Decision**: `extract.service.ts` and `verify.service.ts` both call the existing repair pipeline (D004) on a schema-validation failure — *except* when the raw LLM response matches one of a small, **concrete** set of instruction-injection heuristics:
1. The response's `verdict`/`type` field (or equivalent enum) contains a value outside the defined enum that looks like an instruction or role marker (e.g. contains "system", "ignore", "instruction", a role-prefix pattern like `"user:"`/`"assistant:"`) rather than a plausible typo of a real enum value.
2. Response content includes text resembling a system/tool-instruction block (markers like `"###"`, `"<system>"`, `"you are now"`) inside a field that should contain only a claim/verdict/quote.
3. The response is syntactically valid JSON (parses cleanly) but violates the schema in a way a well-intentioned malformed response wouldn't — e.g. an entirely different key set, not a typo/truncation/missing-field pattern.

**This replaces an earlier, circular version of rule 3** ("doesn't resemble the schema in a way consistent with ordinary malformation") that gave an implementer no way to actually distinguish the two cases — caught on review. The list above is still a first pass, not exhaustive, and needs a fixture set (mirroring `evaluations/golden/audit/`'s own discipline) of known-malformed vs. known-injection-shaped responses before it can be trusted; building that fixture set is follow-up work, not covered by this research decision alone. In any matched case, the response is rejected outright, logged with the flagged content, and surfaced as a gated/failed claim — the repair pipeline is never invoked for it.

**Rationale**: Implements FR-021/D018 A8 directly. The distinction from ordinary malformed JSON (which legitimately goes through repair) matters because repair's job is "fix a well-intentioned but broken response," and an injection-influenced response isn't well-intentioned by assumption — repairing it risks producing a schema-valid response that still encodes the injected instruction's effect.

**Alternatives considered**: Routing all schema failures through repair uniformly, flagging injection only after the fact — rejected, this is exactly the "repairing a response that may have been steered by injected content risks repairing it into compliance with the injection" failure D018 names explicitly.
