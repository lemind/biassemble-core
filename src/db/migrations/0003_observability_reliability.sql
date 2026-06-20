-- Stage 003: Observability, Reliability & Evaluation Infrastructure
-- Migration: Add LLM call tracking and extend eval_results

-- Create new llm_calls table for observability
CREATE TABLE "core"."llm_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid,
  "stage" text NOT NULL,
  "call_type" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "raw_response" text,
  "parsed_output" jsonb,
  "status" text NOT NULL,
  "failure_type" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "total_tokens" integer,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "duration_ms" integer NOT NULL,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Add indexes for query performance
CREATE INDEX "llm_calls_provider_idx" ON "core"."llm_calls" ("provider");
CREATE INDEX "llm_calls_model_idx" ON "core"."llm_calls" ("model");
CREATE INDEX "llm_calls_stage_idx" ON "core"."llm_calls" ("stage");
CREATE INDEX "llm_calls_created_at_idx" ON "core"."llm_calls" ("created_at");
CREATE INDEX "llm_calls_session_id_idx" ON "core"."llm_calls" ("session_id");

-- Extend existing eval_results table with Stage 003 columns
ALTER TABLE "core"."eval_results" ADD COLUMN "eval_run_id" uuid;
ALTER TABLE "core"."eval_results" ADD COLUMN "scenario_id" text;
ALTER TABLE "core"."eval_results" ADD COLUMN "raw_output" text;

-- Backfill scenario_id for legacy rows (descriptive field, safe to backfill)
UPDATE "core"."eval_results" SET "scenario_id" = 'legacy' WHERE "scenario_id" IS NULL;
ALTER TABLE "core"."eval_results" ALTER COLUMN "scenario_id" SET NOT NULL;

-- Note: eval_run_id is intentionally left nullable.
-- Legacy rows (pre-Stage 003) do not belong to any eval run, so NULL is the correct value.
-- Do NOT backfill with fake UUIDs — that would create phantom runs in analytics.
