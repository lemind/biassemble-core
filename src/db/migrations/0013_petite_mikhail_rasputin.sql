CREATE TABLE "grounnel"."grounnel_rerank_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"url" text NOT NULL,
	"lexical_score" double precision NOT NULL,
	"llm_score" double precision NOT NULL,
	"combined_score" double precision NOT NULL,
	"selected" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grounnel"."grounnel_search_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"url" text NOT NULL,
	"excerpt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_llm_calls" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_rerank_decisions" ADD CONSTRAINT "grounnel_rerank_decisions_run_id_grounnel_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "grounnel"."grounnel_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_search_pages" ADD CONSTRAINT "grounnel_search_pages_run_id_grounnel_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "grounnel"."grounnel_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grounnel_rerank_decisions_run_id_idx" ON "grounnel"."grounnel_rerank_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grounnel_rerank_decisions_claim_id_idx" ON "grounnel"."grounnel_rerank_decisions" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "grounnel_search_pages_run_id_idx" ON "grounnel"."grounnel_search_pages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grounnel_search_pages_claim_id_idx" ON "grounnel"."grounnel_search_pages" USING btree ("claim_id");