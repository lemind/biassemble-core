-- D015 (spec-005): per-source split & confirmation counts on retrieval_comparisons.
-- Additive & idempotent. NOTE: drizzle-kit generate emitted a full CREATE TABLE for
-- retrieval_comparisons + runs.rag_result because meta/0006_snapshot.json is missing
-- (pre-existing migration-history drift). Those objects already exist in the live DB from
-- 0006_rag_integration, so this migration was hand-corrected to ONLY add the 5 new columns.
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "rag_vector_list" jsonb;--> statement-breakpoint
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "rag_llm_list" jsonb;--> statement-breakpoint
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "rag_vector_hit_final" integer;--> statement-breakpoint
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "rag_llm_hit_final" integer;--> statement-breakpoint
ALTER TABLE "core"."retrieval_comparisons" ADD COLUMN IF NOT EXISTS "rag_both_hit_final" integer;
