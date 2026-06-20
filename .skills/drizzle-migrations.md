# Drizzle Migrations Skill

Load this when working with database migrations.

## Rules

- **Always check existing migrations** — Before generating new ones, verify `src/db/migrations/` doesn't already have the table
- **Command**: `pnpm db:generate` then manually verify the generated SQL
- **NOT NULL column on existing table**:
  1. Add column as nullable first
  2. Backfill existing rows with placeholder/mock value
  3. ALTER COLUMN SET NOT NULL
- **After generating**: Verify columns, indexes, and constraints match `schema.ts`
- **Never use CREATE TABLE** if table already exists — use ALTER TABLE

## Example: Adding NOT NULL Column

```sql
-- Step 1: Add nullable
ALTER TABLE "core"."eval_results" ADD COLUMN "eval_run_id" uuid;

-- Step 2: Backfill (if needed)
UPDATE "core"."eval_results" SET "eval_run_id" = 'legacy-value' WHERE "eval_run_id" IS NULL;

-- Step 3: Set NOT NULL
ALTER TABLE "core"."eval_results" ALTER COLUMN "eval_run_id" SET NOT NULL;
```

## Verification Checklist

After generating a migration:
- [ ] Columns match schema.ts
- [ ] Indexes match schema.ts
- [ ] Constraints (NOT NULL, UNIQUE) match schema.ts
- [ ] No accidental table drops
- [ ] Migration is reversible (can rollback if needed)
