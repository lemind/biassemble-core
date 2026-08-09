import { boolean, doublePrecision, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const core = pgSchema("core");

// D018 §2.4: audit-mode data lives in its own pg schema, sibling to `core`,
// never nested inside it — so customer corpus data can be dropped
// post-engagement without touching consumer tables.
export const auditSchema = pgSchema("audit");

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
  ragResult: jsonb("rag_result"),
  ragStartedAt: timestamp("rag_started_at", { withTimezone: true }),
  ragCompletedAt: timestamp("rag_completed_at", { withTimezone: true }),
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
}, (table) => [
  index("eval_results_eval_run_id_idx").on(table.evalRunId),
]);

// ── LLM Calls (Stage 003) ──
// Observability layer: stores raw LLM outputs for debugging and replay.
// One row per actual provider call (including retries and fallback calls).
export const llmCalls = core.table("llm_calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id"),
  // "extract"/"verify" added for specs/008-b2b (persistence/types.ts LlmCallStage) —
  // plain text column, no DB CHECK constraint, same D017 precedent as RagStatus.
  stage: text("stage", { enum: ["assessment", "question", "extract", "verify"] }).notNull(),
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
  index("llm_calls_metrics_idx").on(table.createdAt, table.provider, table.model, table.stage),
  index("llm_calls_session_stage_idx").on(table.sessionId, table.stage),
]);

// ── Retrieval Comparisons (Stage 004) ──
// One row per completed assessment session. Written fire-and-forget after runFullAssessment.
// Tracks retrieval-vs-LLM alignment for observability. No FK on session_id — sessions are owned
// by the public backend. run_id is the post_questions_assessment run that triggered this row.
export const retrievalComparisons = core.table("retrieval_comparisons", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull(),
  runId: uuid("run_id").references(() => runs.id),
  ragList: jsonb("rag_list").notNull(),
  llmList: jsonb("llm_list").notNull(),
  finalList: jsonb("final_list").notNull(),
  overlap: integer("overlap").notNull(),
  ragOnly: integer("rag_only").notNull(),
  llmOnly: integer("llm_only").notNull(),
  ragHitFinal: integer("rag_hit_final").notNull(),
  llmHitFinal: integer("llm_hit_final").notNull(),
  normalizationAdditions: integer("normalization_additions").notNull(),
  // "retrieved" = RAG was available live, in time to inform the assessment output.
  // "backfilled" = RAG arrived late; only the analytics fields below were patched in
  // afterward — the output itself was already decided without RAG. See RagStatus in
  // persistence/types.ts. Plain text column, no DB-level CHECK constraint, so adding
  // "backfilled" needed no migration.
  ragStatus: text("rag_status", { enum: ["retrieved", "roster_fallback", "unavailable", "backfilled"] }).notNull(),
  // D017: generic per-source breakdown (no fixed-arity "both" columns — see ADR).
  sourceBreakdown: jsonb("source_breakdown"),
  selectionStrategy: text("selection_strategy"),
  llmModel: text("llm_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("retrieval_comparisons_session_id_idx").on(table.sessionId),
]);

// ── Audits (specs/008-b2b, D018) ──
// One row per pipeline run over one submitted { output_text, sources[], task }
// input. auditId is application-generated (not defaultRandom) — it's returned
// to the caller in the 202 response before this row exists, per T021/T021a.
// Verdict fields (`verdict` onward) live on Claim, not a separate table —
// data-model.md models Verdict as a 1:1 extension of Claim, and this repo's
// task list (T003) names exactly 5 tables, not 6.
export const audits = auditSchema.table("audits", {
  auditId: uuid("audit_id").primaryKey(),
  inputRef: text("input_ref").notNull(),
  domain: text("domain", { enum: ["general", "finance", "legal", "healthcare"] }).notNull(),
  // Ordering note for Phase 3 (T020/T021): this row must be INSERTed with
  // status="running" synchronously, before POST /audit returns 202 — not
  // inside the Inngest job. Otherwise GET /audit/:audit_id polled in the gap
  // between "202 returned" and "job actually started" would 404 (no row
  // exists yet) instead of correctly returning 202/running.
  status: text("status", { enum: ["running", "complete", "failed"] }).notNull().default("running"),
  // Null unless status = "failed" (data-model.md's Audit entity).
  failedStage: text("failed_stage", { enum: ["extract", "retrieve", "verify", "gate"] }),
  errorSummary: text("error_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Versioning surface (FR-014) — stamped progressively as each stage runs,
  // so nullable here; all non-null once status = "complete" (T034).
  promptRevisionExtract: text("prompt_revision_extract"),
  promptRevisionVerify: text("prompt_revision_verify"),
  modelRevisionExtract: text("model_revision_extract"),
  modelRevisionVerify: text("model_revision_verify"),
  corpusId: text("corpus_id"),
  retrievalProvider: text("retrieval_provider"),
  threshold: doublePrecision("threshold"),
  pipelineCodeVersion: text("pipeline_code_version"),
  truncated: boolean("truncated").notNull().default(false),
}, (table) => [
  index("audits_status_idx").on(table.status),
  index("audits_input_ref_idx").on(table.inputRef),
]);

// ── Claims (specs/008-b2b) ──
// claimId is application-generated at EXTRACT time (research.md §2), not
// defaultRandom — a content-hash ID was rejected because two genuinely
// different claims can share identical text after EXTRACT's dedup rule.
export const claims = auditSchema.table("claims", {
  claimId: uuid("claim_id").primaryKey(),
  auditId: uuid("audit_id").notNull().references(() => audits.auditId, { onDelete: "cascade" }),
  type: text("type", { enum: ["numeric", "entity", "attribution", "causal", "derived"] }).notNull(),
  claimText: text("claim_text").notNull(),
  excerpt: text("excerpt").notNull(),
  locations: jsonb("locations").notNull(),
  period: text("period"),
  derived: boolean("derived").notNull().default(false),
  // Set by RETRIEVE before VERIFY runs. Distinguishes "no evidence found"
  // (count = 0) from "evidence found but didn't support" (count > 0,
  // verdict still unsupported) — both would otherwise collapse to the same
  // verdict enum value (FR-009).
  passagesRetrievedCount: integer("passages_retrieved_count").notNull().default(0),
  // Null until RETRIEVE runs. "error" must never be silently swallowed into
  // passagesRetrievedCount = 0 (data-model.md's retrieval-failure gate rule).
  retrievalStatus: text("retrieval_status", { enum: ["ok", "error"] }),
  // Verdict fields — 1:1 extension of this row, not a separate table.
  // Null until VERIFY runs; a claim without these yet is mid-pipeline.
  verdict: text("verdict", { enum: ["supported", "partially_supported", "unsupported", "contradicted", "unverifiable"] }),
  evidence: jsonb("evidence"),
  // Nullable here (pre-verify state), but never null in a completed audit's
  // API response (AuditCompleteResponseSchema requires an array, defaulting
  // to []) — the two schemas track different invariants on purpose: this
  // column distinguishes "not yet verified" from "verified, cited nothing";
  // the API only ever serves completed audits, where that distinction has
  // already collapsed to "at least an empty array."
  sourceRefs: jsonb("source_refs"),
  synthesized: boolean("synthesized"),
  confidence: doublePrecision("confidence"),
  note: text("note"),
}, (table) => [
  index("claims_audit_id_idx").on(table.auditId),
]);

// ── Source Passages (specs/008-b2b) ──
// Deduplicated within an audit — the same span of source text retrieved for
// two different claims is one row here, not two (per-claim retrieval facts
// live on ClaimPassage instead).
export const sourcePassages = auditSchema.table("source_passages", {
  passageId: uuid("passage_id").primaryKey(),
  auditId: uuid("audit_id").notNull().references(() => audits.auditId, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  location: text("location"),
  text: text("text").notNull(),
}, (table) => [
  index("source_passages_audit_id_idx").on(table.auditId),
]);

// ── Claim Passages (junction, added on review — data-model.md "Claim Passage") ──
// Exists because SourcePassage alone has nowhere to record retrieval-time
// facts specific to one claim-passage pairing (rank, score for *this*
// claim's query) without contradicting the many-to-many relationship
// (a passage may support multiple claims, each with its own rank/score).
export const claimPassages = auditSchema.table("claim_passages", {
  id: uuid("id").defaultRandom().primaryKey(),
  claimId: uuid("claim_id").notNull().references(() => claims.claimId, { onDelete: "cascade" }),
  passageId: uuid("passage_id").notNull().references(() => sourcePassages.passageId, { onDelete: "cascade" }),
  retrievalRank: integer("retrieval_rank").notNull(),
  retrievalScore: doublePrecision("retrieval_score").notNull(),
  selectedForVerification: boolean("selected_for_verification").notNull().default(false),
}, (table) => [
  index("claim_passages_claim_id_idx").on(table.claimId),
  uniqueIndex("claim_passages_claim_passage_unique").on(table.claimId, table.passageId),
]);

// ── Score Summaries (specs/008-b2b, D018 §4) ──
// Computed once at GATE, persisted, immutable thereafter (research.md §5) —
// never recomputed at read time, so a value can't drift from what a caller
// already saw across two reads of the same completed audit.
export const scoreSummaries = auditSchema.table("score_summaries", {
  auditId: uuid("audit_id").primaryKey().references(() => audits.auditId, { onDelete: "cascade" }),
  countsSupported: integer("counts_supported").notNull(),
  countsPartiallySupported: integer("counts_partially_supported").notNull(),
  countsUnsupported: integer("counts_unsupported").notNull(),
  countsContradicted: integer("counts_contradicted").notNull(),
  countsUnverifiable: integer("counts_unverifiable").notNull(),
  eligible: integer("eligible").notNull(),
  // Nullable — data-model.md's zero-denominator guard: Eligible = 0 persists
  // these as null, never NaN or a divide-by-zero exception.
  groundedRate: doublePrecision("grounded_rate"),
  groundednessScore: integer("groundedness_score"),
  strictSupportedRate: doublePrecision("strict_supported_rate"),
  contradictionRate: doublePrecision("contradiction_rate"),
  unsupportedRate: doublePrecision("unsupported_rate"),
  retrievalSuccessRate: doublePrecision("retrieval_success_rate").notNull(),
  retrievalCoverage: doublePrecision("retrieval_coverage").notNull(),
  // Nullable — null when zero claims have retrieval_coverage (mean of an
  // empty set), distinct from retrievalCoverage = 0 which is a real number.
  avgEvidenceQuality: doublePrecision("avg_evidence_quality"),
  synthesizedCount: integer("synthesized_count").notNull(),
  lowDecisiveness: boolean("low_decisiveness").notNull(),
  insufficientEligibleClaims: boolean("insufficient_eligible_claims").notNull(),
});

// ── Type exports ──
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

export type ReasoningTrace = typeof reasoningTraces.$inferSelect;
export type NewReasoningTrace = typeof reasoningTraces.$inferInsert;

export type EvalResult = typeof evalResults.$inferSelect;
export type NewEvalResult = typeof evalResults.$inferInsert;

export type LlmCall = typeof llmCalls.$inferSelect;
export type NewLlmCall = typeof llmCalls.$inferInsert;

export type RetrievalComparison = typeof retrievalComparisons.$inferSelect;
export type NewRetrievalComparison = typeof retrievalComparisons.$inferInsert;

export type Audit = typeof audits.$inferSelect;
export type NewAudit = typeof audits.$inferInsert;

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;

export type SourcePassage = typeof sourcePassages.$inferSelect;
export type NewSourcePassage = typeof sourcePassages.$inferInsert;

export type ClaimPassage = typeof claimPassages.$inferSelect;
export type NewClaimPassage = typeof claimPassages.$inferInsert;

export type ScoreSummary = typeof scoreSummaries.$inferSelect;
export type NewScoreSummary = typeof scoreSummaries.$inferInsert;

// ── Grounnel (specs/009-grounnel, D023) ──
// Own pg schema, sibling to `core`/`audit` — D018 §2.4's per-product-schema precedent.
// Table names are prefixed with grounnel_ (unlike core.table("runs")/auditSchema.table("audits"),
// which don't repeat the schema name) deliberately: grounnelClaims and auditSchema's existing
// `claims` export would otherwise collide as TS identifiers, since Drizzle export names are flat
// across this whole module regardless of pg schema.
export const grounnel = pgSchema("grounnel");

// One row per POST /extract call. runId is application-generated — the SAME id
// already used as the Redis hash key `audit:{id}` (D023 §3), not a second identity.
export const grounnelRuns = grounnel.table("grounnel_runs", {
  runId: uuid("run_id").primaryKey(),
  // Nullable, not notNull — no code path supplies a sessionId until tasks.md T028
  // (biassemble/backend session reuse) ships. A notNull column would either block T024
  // entirely or force a fabricated placeholder UUID. Tighten once T028 ships and every
  // caller genuinely has one. No FK regardless — backend-owned (D023 §2).
  sessionId: uuid("session_id"),
  text: text("text").notNull(),
  // production vs eval distinguishes real user runs from golden-set runs (scripts/eval-grounnel.ts,
  // src/jobs/eval-grounnel-run.ts — both construct a real GrounnelPipelineService/GrounnelExtractService,
  // so without this column golden-set noise would silently corrupt "verdict distribution over time"
  // analytics, D023 §1's own stated reopening trigger). Deliberately minimal (not
  // benchmark/manual/cli/etc.) — a text-enum column is a one-line migration to extend later.
  source: text("source", { enum: ["production", "eval"] }).notNull().default("production"),
  status: text("status", { enum: ["extracting", "verifying", "done", "failed"] }).notNull().default("extracting"),
  maxClaims: integer("max_claims").notNull(),
  truncated: boolean("truncated").notNull().default(false),
  promptVersionExtract: text("prompt_version_extract"),
  promptVersionVerify: text("prompt_version_verify"),
  score: jsonb("score"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("grounnel_runs_session_id_idx").on(table.sessionId),
  index("grounnel_runs_status_idx").on(table.status),
  index("grounnel_runs_created_at_idx").on(table.createdAt),
  // Composite, not just the two singles above — the named "show me my past checks" query
  // (D023 §1) is `WHERE session_id = ? ORDER BY created_at DESC`, which a single-column
  // index on either field alone still forces a separate sort step for.
  index("grounnel_runs_session_created_idx").on(table.sessionId, table.createdAt),
]);

// One row per claim, durable copy of what Redis holds transiently (D023 §7 — additive, not a
// replacement). Deliberately narrower status enum than the live ClaimStatusEnum (no "pending") —
// this table is written once a claim reaches its FINAL state only, matching D023 §7's "written
// after Redis, once already correct" rule; Redis is where in-progress state lives.
export const grounnelClaims = grounnel.table("grounnel_claims", {
  claimId: uuid("claim_id").primaryKey(), // same id as the API/Redis contract
  runId: uuid("run_id").notNull().references(() => grounnelRuns.runId, { onDelete: "cascade" }),
  claimText: text("claim_text").notNull(),
  verdict: text("verdict", { enum: ["supported", "partially_supported", "unsupported", "contradicted", "unverifiable"] }),
  evidence: text("evidence"),
  confidence: doublePrecision("confidence"),
  reason: text("reason"),
  sources: jsonb("sources").notNull(), // ClaimSource[]
  status: text("status", { enum: ["done", "failed"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("grounnel_claims_run_id_idx").on(table.runId),
  index("grounnel_claims_verdict_idx").on(table.verdict),
  index("grounnel_claims_status_idx").on(table.status),
]);

// Gemini EXTRACT/VERIFY calls — mirrors core.llm_calls' shape (D023 §3), own table, not shared.
// callType defaults to "primary". "fallback" matches core.llm_calls' meaning (parse-failure retry,
// D018 §5.15). "consistency_retry" (T034) is deliberately a separate value, not reused "fallback" —
// a different trigger (gate-caught self-inconsistency, not a parse failure) a shared metric shouldn't conflate.
// "consistency_check" (D025/T035) is the batched classifier call ("does reason support verdict?")
// that decides whether a "consistency_retry" fires — a distinct call, not the retry itself.
export const grounnelLlmCalls = grounnel.table("grounnel_llm_calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => grounnelRuns.runId, { onDelete: "cascade" }),
  stage: text("stage", { enum: ["extract", "verify"] }).notNull(),
  callType: text("call_type", { enum: ["primary", "fallback", "consistency_retry", "consistency_check"] }).notNull().default("primary"),
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
  index("grounnel_llm_calls_run_id_idx").on(table.runId),
  index("grounnel_llm_calls_stage_idx").on(table.stage),
  index("grounnel_llm_calls_created_at_idx").on(table.createdAt),
  // Composite, mirroring core.llm_calls' own llm_calls_metrics_idx — same "success/failure rate
  // by stage over time" query shape this table claims to mirror; a real mirror needs this too.
  index("grounnel_llm_calls_metrics_idx").on(table.createdAt, table.stage, table.status),
]);

// SearchProvider calls — DIY-fetch vs Tavily-fallback (D021/D023 §6). New concept, no biassemble
// precedent. claimId has no FK: unlike grounnel_gate_events below, search runs in an entirely
// earlier, separate phase (resolveAllEvidence, waves of up to SEARCH_CONCURRENCY claims at once)
// well before any claim's final write — buffering every in-flight search call across a whole run
// until each claim's eventual write would be a much bigger restructuring than gate_events'
// buffer-then-flush, so no-FK is the pragmatic choice here specifically, not a blanket rule.
// Granularity: one row per attempted DIY candidate (real per-URL status/timing) plus one row for
// the Tavily fallback call as a whole when it fires — matches search-provider.ts's own doc comment
// ("returns every attempted source, not just the successful one"). url is null on a tavily_fallback
// row since that call returns multiple results per HTTP call, not one URL's attempt.
export const grounnelSearchCalls = grounnel.table("grounnel_search_calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => grounnelRuns.runId, { onDelete: "cascade" }),
  claimId: uuid("claim_id").notNull(),
  query: text("query").notNull(),
  callType: text("call_type", { enum: ["diy_fetch", "tavily_fallback"] }).notNull(),
  url: text("url"),
  resultCount: integer("result_count").notNull(),
  status: text("status", { enum: ["ok", "paywalled", "unreachable", "blocked", "rate_limited"] }).notNull(), // matches SourceStatusEnum
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("grounnel_search_calls_run_id_idx").on(table.runId),
  index("grounnel_search_calls_call_type_idx").on(table.callType),
]);

// Every gate evaluation (D022 §4/§2, D023 §5) — fired or not; overridden:false is itself the
// data that answers "how often does this gate even get a chance to fire." claimId gets a real FK:
// gates run inline in pipeline.service.ts's runBatch loop directly before that same iteration's
// writeClaimResult call (not in an earlier separate phase the way search is), so the write path
// buffers the gate decisions in memory while the chain runs, then flushes them AFTER the
// corresponding grounnel_claims insert succeeds — the FK always references a real, already-written
// row, never written eagerly per-gate.
export const grounnelGateEvents = grounnel.table("grounnel_gate_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => grounnelRuns.runId, { onDelete: "cascade" }),
  claimId: uuid("claim_id").notNull().references(() => grounnelClaims.claimId, { onDelete: "cascade" }),
  gate: text("gate", { enum: ["reason_consistency", "implicit_negation", "counterfact_ignored", "contradiction_evidence", "numeric"] }).notNull(),
  verdictBefore: text("verdict_before", { enum: ["supported", "partially_supported", "unsupported", "contradicted", "unverifiable"] }),
  verdictAfter: text("verdict_after", { enum: ["supported", "partially_supported", "unsupported", "contradicted", "unverifiable"] }),
  overridden: boolean("overridden").notNull(),
  // Machine-readable code for why the gate acted — null when overridden is false (D023 §5).
  reason: text("reason", {
    enum: [
      "contradiction_language_in_model_reason",
      "bare_negation_matched",
      "evidence_null",
      "evidence_not_grounded",
      "threshold_comparison",
      "equality_comparison",
      "counterfact_ignored",
    ],
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("grounnel_gate_events_run_id_idx").on(table.runId),
  index("grounnel_gate_events_gate_idx").on(table.gate),
  index("grounnel_gate_events_overridden_idx").on(table.overridden),
]);

export type GrounnelRun = typeof grounnelRuns.$inferSelect;
export type NewGrounnelRun = typeof grounnelRuns.$inferInsert;

export type GrounnelClaim = typeof grounnelClaims.$inferSelect;
export type NewGrounnelClaim = typeof grounnelClaims.$inferInsert;

export type GrounnelLlmCall = typeof grounnelLlmCalls.$inferSelect;
export type NewGrounnelLlmCall = typeof grounnelLlmCalls.$inferInsert;

export type GrounnelSearchCall = typeof grounnelSearchCalls.$inferSelect;
export type NewGrounnelSearchCall = typeof grounnelSearchCalls.$inferInsert;

export type GrounnelGateEvent = typeof grounnelGateEvents.$inferSelect;
export type NewGrounnelGateEvent = typeof grounnelGateEvents.$inferInsert;