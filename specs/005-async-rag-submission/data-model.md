# Data Model: Async RAG — Fire at Story Submission

## Changed: `runs` table

One new nullable column:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `rag_started_at` | TIMESTAMPTZ | YES | Timestamp when the Inngest RAG job was fired. NULL = not started or pre-005 row. Used by `runFullAssessment` to compute elapsed time for the adaptive wait decision. |

`rag_result` (JSONB, nullable) already exists from spec-004. No change to that column.

**Why not `rag_status` column**: Status is derived from two existing signals — `rag_started_at IS NOT NULL` (RUNNING) vs `rag_result IS NOT NULL` (READY) vs errors stored in `rag_result` sentinel. A separate status column would duplicate this state and require an additional write on every status transition. The derived approach is sufficient for the adaptive wait logic.

---

## Changed: `BiasItem` schema (reflection.schemas.ts)

`context_source` enum updated:

| Old value | New value | Meaning |
|-----------|-----------|---------|
| `"retrieved"` | `"retrieved"` | Bias came from RAG with `retrieval_score > 0` (unchanged) |
| `"roster"` | `"llm"` | Bias detected by LLM only; RAG was unavailable or didn't return it |
| *(new)* | `"both"` | Bias appeared in both RAG results and LLM output |

`"roster"` is retired from the enum. Pre-005 DB rows with `context_source = "roster"` are treated as `"llm"` on read (no migration needed — application-level backward compat).

---

## New: bias workspace structure (in-memory only, not persisted)

The workspace is built in service code and rendered to a prompt string. It is not stored in the database.

```typescript
interface BiasCandidate {
  bias_id: string;       // e.g. "overconfidence_bias"
  name: string;          // e.g. "Overconfidence Bias"
  confidence: number;    // RAG retrieval_score (0.0–1.0)
  evidence: string;      // indicators from engine response; empty string if LLM-only
  source: "retrieved" | "llm" | "both";
}

interface BiasWorkspace {
  candidates: BiasCandidate[];
  ragCase: "retrieved" | "unavailable";  // simplified — "roster_fallback" maps to "unavailable"
}
```

`BiasWorkspace` is the output type of `buildBiasWorkspace()` in `src/rag/workspace-builder.ts`. It is converted to the `{{candidateBiases}}` prompt string by the renderer.

---

## Schema migration

New file: `src/db/migrations/0005_async_rag_submission.sql`

```sql
ALTER TABLE runs ADD COLUMN IF NOT EXISTS rag_started_at TIMESTAMPTZ;
```

---

## RunStore port extension

New method on `RunStore` interface (`src/persistence/ports.ts`):

```typescript
/** Record that the RAG Inngest job was fired for this run. */
recordRagStarted(runId: string, startedAt: Date): Promise<void>;

/** Get the rag_started_at timestamp for the most recent story_only run in the session. */
getRagStartedAtForSession(sessionId: string): Promise<Date | null>;
```

Existing methods unchanged: `storeRagResult`, `getRagResultForSession`.
