import { boolean, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const core = pgSchema("core");

// ── Runs ──
// Each run represents one assessment pass (initial or post-questions).
// sessionId is a plain UUID with no FK — sessions are managed by the backend,
// not by core. Core never owns sessions. See backend/src/services/session.service.ts.
export const runs = core.table("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull(),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  stage: text("stage", { enum: ["initial_assessment", "post_questions_assessment"] }).notNull(),
  scope: text("scope", { enum: ["story_only", "story_plus_answers"] }).notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputHash: text("input_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Reasoning Traces ──
// Immutable reasoning artifacts produced by each run.
// Scope (story_only vs story_plus_answers) is on the run record — not duplicated here.
export const reasoningTraces = core.table("reasoning_traces", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  trace: jsonb("trace").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Evaluation Results ──
// Results from running golden/no_bias datasets against a prompt version.
export const evalResults = core.table("eval_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").references(() => runs.id),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  promptVersion: text("prompt_version").notNull(),
  dataset: text("dataset", { enum: ["golden", "no_bias", "all"] }).notNull(),
  evaluationMetrics: jsonb("evaluation_metrics").notNull(),
  systemMetrics: jsonb("system_metrics").notNull(),
  inputHash: text("input_hash").notNull(),
  passed: boolean("passed").notNull(),
  runAt: timestamp("run_at").defaultNow().notNull(),
});

// ── Type exports ──
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

export type ReasoningTrace = typeof reasoningTraces.$inferSelect;
export type NewReasoningTrace = typeof reasoningTraces.$inferInsert;

export type EvalResult = typeof evalResults.$inferSelect;
export type NewEvalResult = typeof evalResults.$inferInsert;