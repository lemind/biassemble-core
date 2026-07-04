# Data Model — Stage 004: RAG Integration

**Delta from**: Stage 003 schema (`src/db/migrations/0003_observability_reliability.sql`)

## Extended Table: `runs`

Add one nullable column to the existing `core.runs` table:

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `rag_result` | JSONB | YES | Raw `RetrieveResponse` from `POST /retrieve-biases`. Null when RAG was unavailable, returned auth_error, or the run predates Stage 004. |

**Why JSONB on `runs`**: The RAG result must travel from `runStoryOnlyAssessment` (one HTTP request) to `runFullAssessment` (a second HTTP request). The `runs` table is the only existing shared persistent state between both calls. One nullable JSONB column is the minimal bridge.

**Stored shape** (when present):

```json
{
  "biases": [
    {
      "id": "string",
      "name": "string",
      "retrieval_score": 0.87,
      "definition": "string",
      "examples": "string",
      "indicators": "string",
      "false_positives": "string",
      "related_biases": "string"
    }
  ],
  "retrieved_chunks": 5,
  "taxonomy_version": "v1",
  "embedding_model": "all-MiniLM-L6-v2",
  "request_id": "string"
}
```

## New Table: `retrieval_comparisons`

One row per completed assessment session (written fire-and-forget after `runFullAssessment`).

```sql
CREATE TABLE core.retrieval_comparisons (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              UUID NOT NULL,
  run_id                  UUID REFERENCES core.runs(id),
  rag_list                JSONB NOT NULL,   -- string[]
  llm_list                JSONB NOT NULL,   -- string[]
  final_list              JSONB NOT NULL,   -- string[]
  overlap                 INTEGER NOT NULL,
  rag_only                INTEGER NOT NULL,
  llm_only                INTEGER NOT NULL,
  rag_hit_final           INTEGER NOT NULL,
  llm_hit_final           INTEGER NOT NULL,
  normalization_additions INTEGER NOT NULL,
  rag_status              TEXT NOT NULL,    -- "retrieved" | "roster_fallback" | "unavailable"
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX retrieval_comparisons_session_id_idx ON core.retrieval_comparisons (session_id);
```

**Column notes**:

| Column | Description |
|--------|-------------|
| `session_id` | No FK — sessions are owned by the public backend, not core. |
| `run_id` | FK to `runs.id` — the `post_questions_assessment` run that triggered this row. |
| `rag_list` | Bias names from engine response (`string[]`). `[]` if RAG was unavailable. |
| `llm_list` | Bias names from LLM output before name normalization (`string[]`). |
| `final_list` | Bias names in returned `AssessmentOutput.biases` after normalization (`string[]`). |
| `overlap` | `\|rag_list ∩ llm_list\|` |
| `rag_only` | `\|rag_list - llm_list\|` |
| `llm_only` | `\|llm_list - rag_list\|` |
| `rag_hit_final` | Biases in `rag_list` that appear in `final_list`. |
| `llm_hit_final` | Biases in `llm_list` that appear in `final_list`. |
| `normalization_additions` | Biases in `final_list` not in either `rag_list` or `llm_list` — injected by name normalization or ValidationGate. |
| `rag_status` | Case indicator: `"retrieved"` (A), `"roster_fallback"` (B), `"unavailable"` (C). |

## TypeScript Types

### New: `EngineResponse` (`src/rag/engine-client.ts`)

```typescript
interface BiasResult {
  id: string;
  name: string;
  retrieval_score: number;
  definition: string;
  examples: string;
  indicators: string;
  false_positives: string;
  related_biases: string;
}

interface EngineResponse {
  biases: BiasResult[];
  retrieved_chunks: number;
  taxonomy_version: string;
  embedding_model: string;
  request_id: string;
}

type RagClientResult =
  | { status: "ok"; data: EngineResponse }
  | { status: "unavailable" }
  | { status: "auth_error" };
```

### New: `RagCase` and `BiasContextResult` (`src/rag/context-builder.ts`)

```typescript
type RagCase = "retrieved" | "roster_fallback" | "unavailable";

interface BiasContextResult {
  biasContext: string;
  ragCase: RagCase;
  retrievedIds: Set<string>; // bias IDs with retrieval_score > 0
}
```

### New: `RetrievalComparisonRecord` (`src/persistence/types.ts`)

```typescript
interface RetrievalComparisonRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  ragList: string[];
  llmList: string[];
  finalList: string[];
  overlap: number;
  ragOnly: number;
  llmOnly: number;
  ragHitFinal: number;
  llmHitFinal: number;
  normalizationAdditions: number;
  ragStatus: "retrieved" | "roster_fallback" | "unavailable";
  createdAt: Date;
}
```

### Modified: `BiasItem` (`src/contracts/reflection.schemas.ts`)

Add optional field (additive, backward-compatible):

```typescript
context_source: z.enum(["retrieved", "roster"]).optional()
```

Set by service code (not LLM) after output is parsed. On Cases B/C all biases get `"roster"`. On Case A, derived by `retrievedIds.has(bias.biasCatalogId ?? "")`.
