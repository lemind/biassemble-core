import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
// Extended in Stage 003 with eval_run_id, scenario_id, and raw_output for run-level grouping and debugging.
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
  // Stage 003 extensions
  evalRunId: uuid("eval_run_id"),
  scenarioId: text("scenario_id").notNull(),
  rawOutput: text("raw_output"),
});

// ── LLM Calls (Stage 003) ──
// Observability layer: stores raw LLM outputs for debugging and replay.
// One row per actual provider call (including retries and fallback calls).
export const llmCalls = core.table("llm_calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id"),
  stage: text("stage", { enum: ["assessment", "question"] }).notNull(),
  callType: text("call_type", { enum: ["primary", "fallback"] }).notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  rawResponse: text("raw_response"),
  parsedOutput: jsonb("parsed_output"),
  status: text("status", { enum: ["success", "timeout", "error"] }).notNull(),
  failureType: text("failure_type", { enum: ["schema_validation", "parse_error", "provider_error", "timeout", "other"] }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("llm_calls_provider_idx").on(table.provider),
  index("llm_calls_model_idx").on(table.model),
  index("llm_calls_stage_idx").on(table.stage),
  index("llm_calls_created_at_idx").on(table.createdAt),
  index("llm_calls_session_id_idx").on(table.sessionId),
]);

// ── Type exports ──
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

export type ReasoningTrace = typeof reasoningTraces.$inferSelect;
export type NewReasoningTrace = typeof reasoningTraces.$inferInsert;

export type EvalResult = typeof evalResults.$inferSelect;
export type NewEvalResult = typeof evalResults.$inferInsert;

export type LlmCall = typeof llmCalls.$inferSelect;
export type NewLlmCall = typeof llmCalls.$inferInsert;