ALTER TABLE "grounnel"."grounnel_runs" ADD COLUMN "provider" text DEFAULT 'gemini' NOT NULL;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "grounnel"."grounnel_runs" ADD COLUMN "key_source" text DEFAULT 'site' NOT NULL;