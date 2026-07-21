CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "audit"."audits" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"input_ref" text NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"failed_stage" text,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"prompt_revision_extract" text,
	"prompt_revision_verify" text,
	"model_revision_extract" text,
	"model_revision_verify" text,
	"corpus_id" text,
	"retrieval_provider" text,
	"threshold" double precision,
	"pipeline_code_version" text,
	"truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."claim_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"passage_id" uuid NOT NULL,
	"retrieval_rank" integer NOT NULL,
	"retrieval_score" double precision NOT NULL,
	"selected_for_verification" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."claims" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"audit_id" uuid NOT NULL,
	"type" text NOT NULL,
	"claim_text" text NOT NULL,
	"excerpt" text NOT NULL,
	"locations" jsonb NOT NULL,
	"period" text,
	"derived" boolean DEFAULT false NOT NULL,
	"passages_retrieved_count" integer DEFAULT 0 NOT NULL,
	"retrieval_status" text,
	"verdict" text,
	"evidence" jsonb,
	"source_refs" jsonb,
	"synthesized" boolean,
	"confidence" double precision,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "audit"."score_summaries" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"counts_supported" integer NOT NULL,
	"counts_partially_supported" integer NOT NULL,
	"counts_unsupported" integer NOT NULL,
	"counts_contradicted" integer NOT NULL,
	"counts_unverifiable" integer NOT NULL,
	"eligible" integer NOT NULL,
	"grounded_rate" double precision,
	"groundedness_score" integer,
	"strict_supported_rate" double precision,
	"contradiction_rate" double precision,
	"unsupported_rate" double precision,
	"retrieval_success_rate" double precision NOT NULL,
	"retrieval_coverage" double precision NOT NULL,
	"avg_evidence_quality" double precision,
	"synthesized_count" integer NOT NULL,
	"low_decisiveness" boolean NOT NULL,
	"insufficient_eligible_claims" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."source_passages" (
	"passage_id" uuid PRIMARY KEY NOT NULL,
	"audit_id" uuid NOT NULL,
	"doc_id" text NOT NULL,
	"location" text,
	"text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit"."claim_passages" ADD CONSTRAINT "claim_passages_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "audit"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."claim_passages" ADD CONSTRAINT "claim_passages_passage_id_source_passages_passage_id_fk" FOREIGN KEY ("passage_id") REFERENCES "audit"."source_passages"("passage_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."claims" ADD CONSTRAINT "claims_audit_id_audits_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audit"."audits"("audit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."score_summaries" ADD CONSTRAINT "score_summaries_audit_id_audits_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audit"."audits"("audit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."source_passages" ADD CONSTRAINT "source_passages_audit_id_audits_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audit"."audits"("audit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audits_status_idx" ON "audit"."audits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audits_input_ref_idx" ON "audit"."audits" USING btree ("input_ref");--> statement-breakpoint
CREATE INDEX "claim_passages_claim_id_idx" ON "audit"."claim_passages" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_passages_claim_passage_unique" ON "audit"."claim_passages" USING btree ("claim_id","passage_id");--> statement-breakpoint
CREATE INDEX "claims_audit_id_idx" ON "audit"."claims" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "source_passages_audit_id_idx" ON "audit"."source_passages" USING btree ("audit_id");