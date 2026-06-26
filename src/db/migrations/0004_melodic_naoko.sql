CREATE SCHEMA IF NOT EXISTS "core";
--> statement-breakpoint
ALTER TABLE "core"."reasoning_traces" DROP CONSTRAINT IF EXISTS "reasoning_traces_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."eval_results" DROP CONSTRAINT IF EXISTS "eval_results_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."eval_results" ALTER COLUMN "eval_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."reasoning_traces" ADD CONSTRAINT "reasoning_traces_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."eval_results" ADD CONSTRAINT "eval_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_provider_idx" ON "core"."llm_calls" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_model_idx" ON "core"."llm_calls" USING btree ("model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_stage_idx" ON "core"."llm_calls" USING btree ("stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_created_at_idx" ON "core"."llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_session_id_idx" ON "core"."llm_calls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_metrics_idx" ON "core"."llm_calls" USING btree ("created_at","provider","model","stage");