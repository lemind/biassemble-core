CREATE SCHEMA "grounnel";
--> statement-breakpoint
CREATE TABLE "grounnel"."grounnel_claims" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_text" text NOT NULL,
	"verdict" text,
	"evidence" text,
	"confidence" double precision,
	"reason" text,
	"sources" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grounnel"."grounnel_gate_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"gate" text NOT NULL,
	"verdict_before" text,
	"verdict_after" text,
	"overridden" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grounnel"."grounnel_llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"call_type" text DEFAULT 'primary' NOT NULL,
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
--> statement-breakpoint
CREATE TABLE "grounnel"."grounnel_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"text" text NOT NULL,
	"source" text DEFAULT 'production' NOT NULL,
	"status" text DEFAULT 'extracting' NOT NULL,
	"max_claims" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"prompt_version_extract" text,
	"prompt_version_verify" text,
	"score" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "grounnel"."grounnel_search_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"query" text NOT NULL,
	"call_type" text NOT NULL,
	"url" text,
	"result_count" integer NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_claims" ADD CONSTRAINT "grounnel_claims_run_id_grounnel_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "grounnel"."grounnel_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_gate_events" ADD CONSTRAINT "grounnel_gate_events_run_id_grounnel_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "grounnel"."grounnel_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_gate_events" ADD CONSTRAINT "grounnel_gate_events_claim_id_grounnel_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "grounnel"."grounnel_claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_llm_calls" ADD CONSTRAINT "grounnel_llm_calls_run_id_grounnel_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "grounnel"."grounnel_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_search_calls" ADD CONSTRAINT "grounnel_search_calls_run_id_grounnel_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "grounnel"."grounnel_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grounnel_claims_run_id_idx" ON "grounnel"."grounnel_claims" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grounnel_claims_verdict_idx" ON "grounnel"."grounnel_claims" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "grounnel_claims_status_idx" ON "grounnel"."grounnel_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "grounnel_gate_events_run_id_idx" ON "grounnel"."grounnel_gate_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grounnel_gate_events_gate_idx" ON "grounnel"."grounnel_gate_events" USING btree ("gate");--> statement-breakpoint
CREATE INDEX "grounnel_gate_events_overridden_idx" ON "grounnel"."grounnel_gate_events" USING btree ("overridden");--> statement-breakpoint
CREATE INDEX "grounnel_llm_calls_run_id_idx" ON "grounnel"."grounnel_llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grounnel_llm_calls_stage_idx" ON "grounnel"."grounnel_llm_calls" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "grounnel_llm_calls_created_at_idx" ON "grounnel"."grounnel_llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "grounnel_llm_calls_metrics_idx" ON "grounnel"."grounnel_llm_calls" USING btree ("created_at","stage","status");--> statement-breakpoint
CREATE INDEX "grounnel_runs_session_id_idx" ON "grounnel"."grounnel_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "grounnel_runs_status_idx" ON "grounnel"."grounnel_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "grounnel_runs_created_at_idx" ON "grounnel"."grounnel_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "grounnel_runs_session_created_idx" ON "grounnel"."grounnel_runs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "grounnel_search_calls_run_id_idx" ON "grounnel"."grounnel_search_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grounnel_search_calls_call_type_idx" ON "grounnel"."grounnel_search_calls" USING btree ("call_type");