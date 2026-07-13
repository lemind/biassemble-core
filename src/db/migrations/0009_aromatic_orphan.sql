-- D017 (spec-007): generic per-source breakdown + per-run engine metadata on
-- retrieval_comparisons. Additive & idempotent. NOTE: drizzle-kit generate emitted a
-- phantom CREATE TABLE for retrieval_comparisons plus phantom ADD COLUMN for
-- runs.rag_result/rag_started_at/rag_completed_at because meta/ is missing snapshots
-- for migrations 0006-0008 (pre-existing drift, unrelated to this feature — see
-- plan.md Decision 7 / research.md R6). Those objects already exist live from
-- 0006_rag_integration / 0007_async_rag_submission / 0008_rag_completed_at, so this
-- migration was hand-corrected to ONLY add the 3 new columns. The ragStatus Drizzle
-- `{enum}` addition in schema.ts is TypeScript-only and correctly produced no SQL here.
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "source_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "selection_strategy" text;--> statement-breakpoint
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "llm_model" text;
