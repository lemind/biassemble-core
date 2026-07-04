-- Stage 004: RAG Integration
-- Migration: Add rag_result column to runs; add retrieval_comparisons table

ALTER TABLE "core"."runs" ADD COLUMN "rag_result" jsonb;

CREATE TABLE "core"."retrieval_comparisons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "run_id" uuid REFERENCES "core"."runs"("id"),
  "rag_list" jsonb NOT NULL,
  "llm_list" jsonb NOT NULL,
  "final_list" jsonb NOT NULL,
  "overlap" integer NOT NULL,
  "rag_only" integer NOT NULL,
  "llm_only" integer NOT NULL,
  "rag_hit_final" integer NOT NULL,
  "llm_hit_final" integer NOT NULL,
  "normalization_additions" integer NOT NULL,
  "rag_status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "retrieval_comparisons_session_id_idx" ON "core"."retrieval_comparisons" ("session_id");
