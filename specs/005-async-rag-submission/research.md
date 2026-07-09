# Research: Async RAG — Fire at Story Submission

All decisions are pre-resolved in ADR D015 (`docs/decisions/015-async-rag-fire-at-submission.md`). Codebase facts confirmed by reading spec-004 implementation (as-built).

---

## Background task mechanism

**Decision**: Inngest (existing integration).

**Rationale**: biassemble-core runs on Vercel serverless functions. When a handler returns an HTTP response, the Node.js process is killed — background async tasks do not survive. Inngest decouples the work from the HTTP lifecycle: the handler sends an event synchronously (`inngest.send()`), then returns immediately. The Inngest function runs asynchronously in Anthropic's managed infra. This is the same pattern already used for `evalAssessmentJob` / `evalDatasetRunJob`.

**Alternatives rejected**: In-process async task (dies with the serverless request); polling loop (adds latency); webhooks from biassemble-engine (engine has no client-callback capability).

---

## RAG result bridge (story_only → full assessment)

**Decision**: Existing `runs.rag_result` JSONB column (spec-004). No new column for RAG result.

**Rationale**: `runStore.storeRagResult(runId, result)` and `getRagResultForSession(sessionId)` already exist. The Inngest background function writes to this column when done; `runFullAssessment` reads from it. No new schema changes needed for the result itself.

**New column needed**: `rag_started_at TIMESTAMPTZ` — required by the adaptive wait to compute elapsed time. Without it, `runFullAssessment` cannot decide whether RAG is "close to done" vs "just started". Cost: one additional nullable column + one write in `recordRagStarted()`.

---

## Adaptive wait implementation

**Decision**: Poll DB for `rag_result` being non-null, up to 2s (in 200ms intervals), only when `rag_started_at` indicates elapsed ≥ 70s.

**Rationale**: D015 Decision 4. The 70s threshold = 76s median NLI latency minus 6s safety margin. When elapsed < 70s, RAG will not finish within the 2s wait budget; skip immediately. When elapsed ≥ 70s, a brief poll recovers the result in the common "just-finished" case.

**Alternative rejected**: `waitForEvent` Inngest API — would require wiring Inngest into the assessment service, adding DI complexity for a 2s wait window.

---

## Bias workspace builder

**Decision**: New `src/rag/workspace-builder.ts` replaces `buildBiasContext()` in the **full assessment path**. The story_only path switches to roster-only context (no RAG, no workspace) since RAG hasn't finished.

**Workspace structure (rendered to prompt)**:
```
### Candidate Biases

| Bias | Confidence | Evidence |
|------|-----------|---------|
| Overconfidence Bias | 0.87 | [indicators from engine] |
| Confirmation Bias   | 0.42 | [indicators from engine] |
...

### All Biases (roster)
- [38 bias names + one-line definitions]
```

**Merge rules (from D015 Decision 3)**:
- RAG READY: build from RAG candidates (confidence = retrieval_score, evidence = indicators); include roster for all 38.
- RAG not READY: roster-only context (equivalent to current Case C).
- Duplicate handling (RAG + story_only LLM overlap) is deferred to a future iteration — story_only LLM initial candidates are NOT merged in this spec (see MVP scope note below).

**MVP scope note**: D015 Decision 3 describes merging RAG candidates with LLM initial candidates from story_only. Storing and retrieving the story_only LLM bias list requires a new DB column (`initial_bias_result`) and additional service wiring. This is out of scope for spec-005 to keep the change set manageable. The workspace in this spec contains RAG candidates only; the assessment LLM is free to detect additional biases beyond the workspace candidates. The `source: "llm"` enum value is reserved for when the merge is implemented.

---

## context_source enum

**Decision**: Update from `"retrieved" | "roster"` (D014 FR7) to `"retrieved" | "llm" | "both"` (D015 Decision 6).

**Rationale**: `"roster"` is retired — in the workspace model, a bias that came only from the LLM is `"llm"`, not "roster." Two-value distinction was a D014 artefact; three values are needed for the workspace merge. `"roster"` remains in the DB for pre-005 rows — treat as `"llm"` on read (backward compat note in schema migration).

**Affected files**: `src/contracts/reflection.schemas.ts`, `src/orchestrators/reflection/assessment.service.ts` (derivation logic).

---

## Prompt template

**Decision**: Rename `{{biasContext}}` → `{{candidateBiases}}` in `system.md`. Bump prompt version `1.2.0` → `1.3.0`.

**Rationale**: The variable name signals to future readers that the content is a structured candidate list, not a generic context block. The existing Tier 1 + Tier 2 text format (D014) is replaced by the workspace table format in the full assessment path.

---

## Confirmed codebase facts (from reading spec-004 as-built)

- `RagEngineClient.retrieve()` — no changes needed.
- `buildBiasContext()` — retained for story_only roster-only path; replaced by workspace builder in full assessment path.
- `runStore.storeRagResult(runId, result)` and `getRagResultForSession(sessionId)` — already exist, used as-is by the Inngest function and `runFullAssessment`.
- `inngest` client (`src/jobs/client.ts`) — already exported; `inngest.send()` is the fire pattern.
- `inngestFunctions` array (`src/jobs/inngest-functions.ts`) — add new function here.
- `AssessmentService` constructor already accepts optional `ragClient?: RagEngineClient` — add optional `inngestClient?: Inngest` alongside.
- `context_source` field derivation in `callProvider()` — update enum and logic.
- Vercel env `RAG_TIMEOUT_MS` not yet set to 120000 — must update.
