-- Spec 019 T002. Hand-written, not drizzle-kit's output: `ADD COLUMN ... NOT NULL` with no default
-- fails outright on a non-empty table, and grounnel_runs already holds ~3.5k rows.
-- Three steps: nullable column, backfill, then the constraint and index.
ALTER TABLE "grounnel"."grounnel_runs" ADD COLUMN "share_token" text;--> statement-breakpoint

-- Backfilled rows are marked `legacy_` so a token minted at creation is distinguishable from one
-- invented afterwards. gen_random_uuid() is v4 (~122 bits) and needs no extension; that is the same
-- unguessability bar T003 cites, and nobody holds a link to these rows anyway.
UPDATE "grounnel"."grounnel_runs"
SET "share_token" = 'legacy_' || replace(gen_random_uuid()::text, '-', '')
WHERE "share_token" IS NULL;--> statement-breakpoint

ALTER TABLE "grounnel"."grounnel_runs" ALTER COLUMN "share_token" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "grounnel_runs_share_token_idx" ON "grounnel"."grounnel_runs" USING btree ("share_token");
