import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "./config";
import {
  runs,
  reasoningTraces,
  evalResults,
  llmCalls,
  retrievalComparisons,
  audits,
  claims,
  sourcePassages,
  claimPassages,
  grounnelRuns,
  grounnelClaims,
  grounnelLlmCalls,
  grounnelSearchCalls,
  grounnelSearchPages,
  grounnelRerankDecisions,
  grounnelGateEvents,
} from "./schema";
import type { LlmCallStage, LlmCallType, LlmCallStatus, LlmCallFailureType, RagStatus, GateReason } from "../persistence/types";
import type { LlmCall } from "./schema";

function db() {
  return getDb();
}

// ── Runs ──

export async function createRun(
  sessionId: string,
  data: {
    provider: string;
    modelName: string;
    stage: "initial_assessment" | "post_questions_assessment";
    scope: "story_only" | "story_plus_answers";
    promptVersion: string;
    inputHash: string;
  }
) {
  const [row] = await db()
    .insert(runs)
    .values({
      sessionId,
      provider: data.provider,
      modelName: data.modelName,
      stage: data.stage,
      scope: data.scope,
      promptVersion: data.promptVersion,
      inputHash: data.inputHash,
    })
    .returning();
  return row;
}

export async function getRunsBySession(sessionId: string) {
  return await db()
    .select()
    .from(runs)
    .where(eq(runs.sessionId, sessionId))
    .orderBy(runs.createdAt);
}

// ── Reasoning Traces ──

export async function persistTrace(
  runId: string,
  trace: unknown,
) {
  const [row] = await db()
    .insert(reasoningTraces)
    .values({ runId, trace })
    .returning();
  return row;
}

export async function getTrace(runId: string) {
  const result = await db()
    .select()
    .from(reasoningTraces)
    .where(eq(reasoningTraces.runId, runId));
  return result[0] ?? null;
}

// ── Evaluation Results ──

export async function persistEvalResult(
  data: {
    runId?: string;
    provider: string;
    modelName: string;
    promptVersion: string;
    dataset: "golden" | "no_bias" | "all";
    evaluationMetrics: Record<string, unknown>;
    systemMetrics: Record<string, unknown>;
    inputHash: string;
    passed: boolean;
    evalRunId: string | null;
    scenarioId: string;
    rawOutput?: string | null;
  }
) {
  const [row] = await db()
    .insert(evalResults)
    .values(data)
    .returning();
  return row;
}

export async function getEvalResultByHash(
  inputHash: string,
  promptVersion: string
) {
  const result = await db()
    .select()
    .from(evalResults)
    .where(
      and(
        eq(evalResults.inputHash, inputHash),
        eq(evalResults.promptVersion, promptVersion)
      )
    );
  return result[0] ?? null;
}

export async function getLatestEvalResults(
  promptVersion: string,
  limit: number
) {
  return await db()
    .select()
    .from(evalResults)
    .where(eq(evalResults.promptVersion, promptVersion))
    .orderBy(desc(evalResults.runAt))
    .limit(limit);
}

// ── LLM Calls (Stage 003) ──

/**
 * Records an LLM call to the llm_calls table.
 * Note: durationMs is computed by the caller (typically executeAndRecordLlmCall),
 * not by this function.
 */
export async function recordLlmCall(
  data: {
    sessionId: string | null;
    stage: LlmCallStage;
    callType: LlmCallType;
    provider: string;
    model: string;
    promptVersion: string;
    rawResponse: string | null;
    parsedOutput: Record<string, unknown> | null;
    status: LlmCallStatus;
    failureType: LlmCallFailureType | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    errorMessage: string | null;
  }
) {
  const [row] = await db()
    .insert(llmCalls)
    .values({
      ...data,
      startedAt: new Date(data.startedAt),
      endedAt: new Date(data.endedAt),
    })
    .returning();
  return row;
}

/**
 * Updates the parsed_output field for an LLM call record.
 * Called after successful parsing/repair to store the structured output.
 */
export async function updateLlmCallParsedOutput(
  id: string,
  parsedOutput: object
): Promise<void> {
  await db()
    .update(llmCalls)
    .set({ parsedOutput } as Partial<LlmCall>)
    .where(eq(llmCalls.id, id));
}

/**
 * Updates status and failure_type for an LLM call record.
 * Called when parsing/repair fails after the provider call succeeded.
 */
export async function updateLlmCallFailure(
  id: string,
  failureType: LlmCallFailureType,
  errorMessage: string | null
): Promise<void> {
  await db()
    .update(llmCalls)
    .set({
      status: "error",
      failureType,
      errorMessage
    } as Partial<LlmCall>)
    .where(eq(llmCalls.id, id));
}

export async function getCallsBySession(sessionId: string) {
  return await db()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.sessionId, sessionId))
    .orderBy(llmCalls.createdAt);
}

/**
 * Token/call-count aggregate for one session — a projected select, not
 * `getCallsBySession`'s full rows (found on review: summing 3 integer
 * columns doesn't need `rawResponse`/`parsedOutput`'s full LLM
 * response text/jsonb pulled over the wire for every call).
 */
export async function getCallCostsBySession(
  sessionId: string
): Promise<{ count: number; inputTokens: number; outputTokens: number; totalTokens: number }> {
  const rows = await db()
    .select({ inputTokens: llmCalls.inputTokens, outputTokens: llmCalls.outputTokens, totalTokens: llmCalls.totalTokens })
    .from(llmCalls)
    .where(eq(llmCalls.sessionId, sessionId));
  return rows.reduce<{ count: number; inputTokens: number; outputTokens: number; totalTokens: number }>(
    (acc, r) => ({
      count: acc.count + 1,
      inputTokens: acc.inputTokens + (r.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (r.outputTokens ?? 0),
      totalTokens: acc.totalTokens + (r.totalTokens ?? 0),
    }),
    { count: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

export async function getCallsByStage(stage: LlmCallStage) {
  return await db()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.stage, stage))
    .orderBy(llmCalls.createdAt);
}

export async function getCallsByProvider(provider: string) {
  return await db()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.provider, provider))
    .orderBy(llmCalls.createdAt);
}

export async function getCallsBySessionAndStage(
  sessionId: string,
  stage: LlmCallStage
) {
  return await db()
    .select()
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.sessionId, sessionId),
        eq(llmCalls.stage, stage)
      )
    )
    .orderBy(llmCalls.createdAt);
}

export async function getCallsForMetrics(filter: {
  timeRange?: { start: Date; end: Date };
  provider?: string;
  model?: string;
  stage?: LlmCallStage;
  limit?: number;
} = {}) {
  const conditions = [];

  // Default to last 30 days if no timeRange provided to prevent full table scans
  const timeRange = filter.timeRange ?? {
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    end: new Date()
  };

  conditions.push(
    and(
      gte(llmCalls.createdAt, timeRange.start),
      lte(llmCalls.createdAt, timeRange.end)
    )
  );

  if (filter.provider) {
    conditions.push(eq(llmCalls.provider, filter.provider));
  }

  if (filter.model) {
    conditions.push(eq(llmCalls.model, filter.model));
  }

  if (filter.stage) {
    conditions.push(eq(llmCalls.stage, filter.stage));
  }

  const limit = filter.limit ?? 10000;

  return await db()
    .select()
    .from(llmCalls)
    .where(and(...conditions))
    .limit(limit)
    .orderBy(llmCalls.createdAt);
}

// ── Eval Results Extensions (Stage 003) ──

export async function getEvalResultsByRunId(evalRunId: string) {
  return await db()
    .select()
    .from(evalResults)
    .where(eq(evalResults.evalRunId, evalRunId))
    .orderBy(evalResults.runAt);
}

export async function getEvalRunAggregates() {
  const results = await db()
    .select({
      evalRunId: evalResults.evalRunId,
      totalScenarios: sql<number>`count(*)::int`,
    })
    .from(evalResults)
    .groupBy(evalResults.evalRunId)
    .orderBy(desc(evalResults.runAt));
  return results;
}

// ── RAG Result (Stage 004) ──

export async function updateRunRagResult(runId: string, ragResult: unknown): Promise<void> {
  await db().execute(
    sql`UPDATE "core"."runs" SET "rag_result" = ${ragResult === null ? null : JSON.stringify(ragResult)}::jsonb WHERE "id" = ${runId}::uuid`
  );
}

export async function getRagResultBySession(sessionId: string): Promise<unknown | null> {
  const result = await db()
    .select({ ragResult: runs.ragResult })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), eq(runs.stage, "initial_assessment")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return result[0]?.ragResult ?? null;
}

// ── RAG Started At (Stage 005) ──

export async function updateRagStartedAt(runId: string, startedAt: Date): Promise<void> {
  await db()
    .update(runs)
    .set({ ragStartedAt: startedAt })
    .where(eq(runs.id, runId));
}

export async function getRagStartedAtBySession(sessionId: string): Promise<Date | null> {
  const result = await db()
    .select({ ragStartedAt: runs.ragStartedAt })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), eq(runs.stage, "initial_assessment")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return result[0]?.ragStartedAt ?? null;
}

// ── RAG Completed At (Stage 005) ──

export async function updateRagCompletedAt(runId: string, completedAt: Date): Promise<void> {
  await db()
    .update(runs)
    .set({ ragCompletedAt: completedAt })
    .where(eq(runs.id, runId));
}

// ── Retrieval Comparisons (Stage 004) ──

export async function insertRetrievalComparison(data: {
  sessionId: string;
  runId: string | null;
  ragList: string[];
  llmList: string[];
  finalList: string[];
  overlap: number;
  ragOnly: number;
  llmOnly: number;
  ragHitFinal: number;
  llmHitFinal: number;
  normalizationAdditions: number;
  ragStatus: RagStatus;
  sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> | null;
  selectionStrategy: string | null;
  llmModel: string | null;
}): Promise<void> {
  await db()
    .insert(retrievalComparisons)
    .values(data);
}

/**
 * Rows for this session still stuck at rag_status="unavailable" with no source_breakdown —
 * candidates for the D017 backfill once a late-arriving RAG result becomes available.
 */
export async function findUnbackfilledRetrievalComparisonsBySession(
  sessionId: string
): Promise<Array<{ id: string; llmList: unknown; finalList: unknown }>> {
  return db()
    .select({
      id: retrievalComparisons.id,
      llmList: retrievalComparisons.llmList,
      finalList: retrievalComparisons.finalList,
    })
    .from(retrievalComparisons)
    .where(
      and(
        eq(retrievalComparisons.sessionId, sessionId),
        eq(retrievalComparisons.ragStatus, "unavailable"),
        isNull(retrievalComparisons.sourceBreakdown),
      )
    );
}

/** Patches a single retrieval_comparisons row's RAG-derived fields once retrieval data lands late. */
export async function backfillRetrievalComparisonSourceData(
  id: string,
  data: {
    ragList: string[];
    ragStatus: RagStatus;
    ragOnly: number;
    llmOnly: number;
    overlap: number;
    ragHitFinal: number;
    normalizationAdditions: number;
    sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> | null;
    selectionStrategy: string | null;
    llmModel: string | null;
  }
): Promise<void> {
  await db()
    .update(retrievalComparisons)
    .set(data)
    .where(eq(retrievalComparisons.id, id));
}

// ── Audits (specs/008-b2b, D018) ──

/**
 * T035: a completed OR failed audit is immutable — enforced here, at the
 * persistence layer, not just by orchestration-layer discipline
 * (AuditService.run() never running twice for the same auditId in the
 * normal case). Guards against a redelivered/replayed pipeline event (e.g.
 * a manual Inngest replay of a failed run) silently mutating or extending
 * an audit a caller has already read as terminal — data-model.md's Audit
 * entity documents both "complete" and "failed" as equally permanent,
 * append-only states, not just "complete" (found on review: the original
 * guard only checked "complete").
 */
export class AuditImmutableError extends Error {
  constructor(auditId: string) {
    super(`Audit ${auditId} is already complete or failed — no further writes are permitted`);
    this.name = "AuditImmutableError";
  }
}

const TERMINAL_AUDIT_STATUSES = new Set(["complete", "failed"]);

async function assertAuditMutable(auditId: string): Promise<void> {
  const audit = await getAudit(auditId);
  if (audit && TERMINAL_AUDIT_STATUSES.has(audit.status)) {
    throw new AuditImmutableError(auditId);
  }
}

/**
 * Resolves a claim's auditId and checks its terminal status in one query
 * (a join, not two sequential SELECTs — found on review: the original form
 * fetched the claim's auditId, then made a second round trip to fetch the
 * full audit row just to read `.status`).
 */
async function assertClaimsAuditMutable(claimId: string): Promise<void> {
  const [row] = await db()
    .select({ auditId: claims.auditId, status: audits.status })
    .from(claims)
    .innerJoin(audits, eq(claims.auditId, audits.auditId))
    .where(eq(claims.claimId, claimId));
  if (row && TERMINAL_AUDIT_STATUSES.has(row.status)) {
    throw new AuditImmutableError(row.auditId);
  }
}

export async function insertAudit(data: {
  auditId: string;
  inputRef: string;
  domain: "general" | "finance" | "legal" | "healthcare";
  threshold: number;
}) {
  const [row] = await db()
    .insert(audits)
    .values({ ...data, status: "running" })
    .returning();
  return row;
}

export async function updateAudit(
  auditId: string,
  data: Partial<{
    status: "running" | "complete" | "failed";
    failedStage: "extract" | "retrieve" | "verify" | "gate";
    errorSummary: string;
    completedAt: Date;
    promptRevisionExtract: string;
    promptRevisionVerify: string;
    modelRevisionExtract: string;
    modelRevisionVerify: string;
    corpusId: string;
    retrievalProvider: string;
    pipelineCodeVersion: string;
    truncated: boolean;
  }>
): Promise<void> {
  await assertAuditMutable(auditId);
  await db().update(audits).set(data).where(eq(audits.auditId, auditId));
}

export async function getAudit(auditId: string) {
  const [row] = await db().select().from(audits).where(eq(audits.auditId, auditId));
  return row ?? null;
}

export async function insertClaims(
  rows: Array<{
    claimId: string;
    auditId: string;
    type: "numeric" | "entity" | "attribution" | "causal" | "derived";
    claimText: string;
    excerpt: string;
    locations: string[];
    period: string | null;
    derived: boolean;
  }>
) {
  if (rows.length === 0) return [];
  await assertAuditMutable(rows[0]!.auditId);
  return await db().insert(claims).values(rows).returning();
}

export async function updateClaimRetrieval(
  claimId: string,
  data: { passagesRetrievedCount: number; retrievalStatus: "ok" | "error" }
): Promise<void> {
  await assertClaimsAuditMutable(claimId);
  await db().update(claims).set(data).where(eq(claims.claimId, claimId));
}

export async function updateClaimVerdict(
  claimId: string,
  data: {
    verdict: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable";
    evidence: string[] | null;
    sourceRefs: string[];
    synthesized: boolean;
    confidence: number;
    note: string | null;
  }
): Promise<void> {
  await assertClaimsAuditMutable(claimId);
  await db().update(claims).set(data).where(eq(claims.claimId, claimId));
}

export async function getClaimsByAudit(auditId: string) {
  return await db().select().from(claims).where(eq(claims.auditId, auditId));
}

export async function insertSourcePassages(
  rows: Array<{ passageId: string; auditId: string; docId: string; location: string | null; text: string }>
) {
  if (rows.length === 0) return [];
  await assertAuditMutable(rows[0]!.auditId);
  return await db().insert(sourcePassages).values(rows).returning();
}

export async function insertClaimPassages(
  rows: Array<{
    claimId: string;
    passageId: string;
    retrievalRank: number;
    retrievalScore: number;
    selectedForVerification: boolean;
  }>
): Promise<void> {
  if (rows.length === 0) return;
  await assertClaimsAuditMutable(rows[0]!.claimId);
  await db().insert(claimPassages).values(rows);
}

export async function getClaimPassagesByAudit(auditId: string) {
  return await db()
    .select({
      claimId: claimPassages.claimId,
      passageId: claimPassages.passageId,
      retrievalScore: claimPassages.retrievalScore,
      selectedForVerification: claimPassages.selectedForVerification,
    })
    .from(claimPassages)
    .innerJoin(claims, eq(claimPassages.claimId, claims.claimId))
    .where(eq(claims.auditId, auditId));
}

// ── Grounnel (specs/009-grounnel, D023 §7) ──
// Best-effort history/analytics only — Redis remains the source of truth (D023 §7). No
// AuditImmutableError-style guard here: unlike audit's Postgres rows, these are never read back
// by any production code path, so there's nothing for a stale write to corrupt.

export async function insertGrounnelRun(data: {
  runId: string;
  sessionId: string | null;
  text: string;
  source: "production" | "eval";
  maxClaims: number;
  truncated: boolean;
}) {
  const [row] = await db().insert(grounnelRuns).values(data).returning();
  return row;
}

export async function updateGrounnelRun(
  runId: string,
  data: Partial<{
    status: "extracting" | "verifying" | "done" | "failed";
    truncated: boolean;
    promptVersionExtract: string;
    promptVersionVerify: string;
    score: unknown;
    completedAt: Date;
  }>
): Promise<void> {
  await db().update(grounnelRuns).set(data).where(eq(grounnelRuns.runId, runId));
}

export async function insertGrounnelClaim(data: {
  claimId: string;
  runId: string;
  claimText: string;
  verdict: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable" | null;
  evidence: string | null;
  confidence: number | null;
  reason: string | null;
  sources: unknown;
  status: "done" | "failed";
}) {
  // D026 §13 — escalation re-processes an already-written claim (upsert, not a fresh row): a plain
  // INSERT would hit claimId's PK conflict and, since callers swallow the error (D023 §7, Redis
  // stays authoritative), silently leave this analytics row stuck at the pre-escalation verdict.
  const [row] = await db()
    .insert(grounnelClaims)
    .values(data)
    .onConflictDoUpdate({
      target: grounnelClaims.claimId,
      set: { verdict: data.verdict, evidence: data.evidence, confidence: data.confidence, reason: data.reason, sources: data.sources, status: data.status },
    })
    .returning();
  return row;
}

export async function insertGrounnelLlmCall(data: {
  runId: string;
  claimId?: string | null;
  stage: "extract" | "verify";
  callType: "primary" | "fallback" | "consistency_retry" | "consistency_check" | "fill_in" | "passage_rerank" | "eligibility_check";
  provider: string;
  model: string;
  promptVersion: string;
  rawResponse: string | null;
  parsedOutput: unknown;
  status: "success" | "timeout" | "error";
  failureType: "schema_validation" | "parse_error" | "provider_error" | "timeout" | "other" | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  errorMessage: string | null;
}) {
  const [row] = await db().insert(grounnelLlmCalls).values(data).returning();
  return row;
}

export async function insertGrounnelSearchCall(data: {
  runId: string;
  claimId: string;
  query: string;
  callType: "diy_fetch" | "tavily_fallback";
  url: string | null;
  resultCount: number;
  status: "ok" | "paywalled" | "unreachable" | "blocked" | "rate_limited" | "not_attempted";
  durationMs: number;
}) {
  const [row] = await db().insert(grounnelSearchCalls).values(data).returning();
  return row;
}

// D026 §19 — the cleaned excerpt a successful DIY fetch produced; see schema.ts's table comment
// for why this is a separate table, not a column on grounnel_search_calls.
export async function insertGrounnelSearchPage(data: { runId: string; claimId: string; url: string; excerpt: string }) {
  const [row] = await db().insert(grounnelSearchPages).values(data).returning();
  return row;
}

// D026 §19 — batch, not one insert per candidate, same convention as insertGrounnelGateEvents:
// every candidate a rerankPassages call scored is written together, right after scoring finishes.
export async function insertGrounnelRerankDecisions(
  rows: Array<{ runId: string; claimId: string; url: string; lexicalScore: number; llmScore: number; combinedScore: number; selected: boolean }>
) {
  if (rows.length === 0) return [];
  return await db().insert(grounnelRerankDecisions).values(rows).returning();
}

// Batch, not one insert per gate — the 4 (or however many) gate decisions for one claim are
// always written together, right after that claim's grounnel_claims row lands (T027, D023 §5).
export async function insertGrounnelGateEvents(
  rows: Array<{
    runId: string;
    claimId: string;
    gate: "reason_consistency" | "implicit_negation" | "reason_year" | "reason_ordinal" | "subject_entity" | "counterfact_ignored" | "contradiction_evidence" | "claim_reason_overlap" | "numeric" | "year" | "retry_reconciliation" | "escalation_replacement";
    verdictBefore: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable" | null;
    verdictAfter: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable" | null;
    overridden: boolean;
    reason: GateReason | null;
  }>
) {
  if (rows.length === 0) return [];
  return await db().insert(grounnelGateEvents).values(rows).returning();
}