import { RedisGrounnelStore, type RedisHashClient } from "../persistence/grounnel-store.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { DrizzleGrounnelLlmCallStore } from "../persistence/grounnel-llm-call-store.js";
import { DrizzleGrounnelGateEventStore } from "../persistence/grounnel-gate-event-store.js";
import { DrizzleGrounnelRerankDecisionStore } from "../persistence/grounnel-rerank-decision-store.js";
import { GrounnelExtractService } from "../orchestrators/grounnel/extract.service.js";
import { GrounnelPipelineService } from "../orchestrators/grounnel/pipeline.service.js";
import { hasPassage } from "../orchestrators/grounnel/pipeline-helpers.js";
import { evaluateGrounnelRun, type ClaimOutcome, type GrounnelRun, type LiveEvalSpec, type Violation } from "./grounnel-live-gate.js";
import type { Provider } from "../providers/types.js";
import type { PromptRegistry } from "../prompts/registry.js";
import type { SearchProvider } from "../providers/search/search-provider.js";

/** In-memory RedisHashClient for a single eval run — no Postgres/Redis (D019 §4); src/ never depends on tests/mocks.
 * Exported (spec 013 T22) so the field-order A/B fixture step can build its own GrounnelStore without duplicating this. */
export class InMemoryRedisHashClient implements RedisHashClient {
  private store = new Map<string, Map<string, string>>();
  async hset(key: string, fields: Record<string, string>): Promise<number> {
    let hash = this.store.get(key);
    if (!hash) {
      hash = new Map();
      this.store.set(key, hash);
    }
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!hash.has(field)) added++;
      hash.set(field, value);
    }
    return added;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.store.get(key)?.get(field) ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string> | null> {
    const hash = this.store.get(key);
    return hash ? Object.fromEntries(hash) : null;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async hsetWithExpire(key: string, fields: Record<string, string>): Promise<void> {
    await this.hset(key, fields);
  }
}

// Same redaction hybrid-provider.ts's sanitizeErrorForLogging applies — a real API key leaked into
// an error message once via a raw fetch URL (D021). Applied here too since this catch is a second
// place a key-bearing message could otherwise reach a log/dashboard unredacted.
function sanitizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/key=[^&\s"]+/gi, "key=[REDACTED]");
}

export interface GoldenCase extends LiveEvalSpec {
  text: string;
  // Per-case override, not a LiveEvalSpec field — this is a run-input concern (how the pipeline
  // resolves evidence), not a scoring concern. Real search results are non-deterministic (which
  // URLs Gemini's grounding returns isn't controllable), so "tavily" lets a case like
  // g11-bloomberg-fallback actually guarantee it exercises that path instead of gambling on it.
  searchEngine?: "defaultFlow" | "tavily";
  /** Per-case override of the provisional detection floor at N>1 (D030 §3k). */
  detectionFloor?: number;
}

export interface GrounnelEvalDeps {
  provider: Provider;
  prompts: PromptRegistry;
  searchProvider: SearchProvider;
}

export interface GrounnelEvalCaseResult {
  id: string;
  ok: boolean;
  /** Repetitions actually scored (a repetition that threw is excluded and counted in `errors`). */
  runs: number;
  safetyOk: boolean;
  correctRate: number;
  detectionRate: number | null;
  correct: number;
  matched: number;
  falseAccusations: number;
  claims: ClaimOutcome[];
  violations: Violation[];
  /** Every scored repetition, not just the first — the raw material for Stage 2 variance attribution. */
  runDetails: GrounnelRun[];
  /** Backward-compatible alias for `runDetails[0]`; null when every repetition failed. */
  run: GrounnelRun | null;
  /** Per-repetition failures (network/quota/etc). Non-empty with runs>0 means a partial case. */
  errors?: string[];
  error?: string;
}

export interface GrounnelEvalSummary {
  cases: GrounnelEvalCaseResult[];
  totalMatched: number;
  totalCorrect: number;
  totalFalseAccusations: number;
  passed: boolean;
}

export const MAX_REPEATS = 20;

/** Coerces an untrusted `repeats` (CLI parseFloat, Inngest event JSON) to a whole number in [1, MAX].
 * A bare clamp lets NaN through — `Math.max(1, Math.min(20, NaN))` is NaN, and `i < NaN` runs the
 * loop zero times, so a typo'd flag would silently score nothing instead of failing loudly. */
export function normalizeRepeats(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_REPEATS, Math.trunc(n)));
}

/** One real EXTRACT + pipeline execution of a case's text. Exported so the Inngest job can wrap each
 * repetition in its own `step.run` — a repetition that fails then retries alone, not the whole case. */
export async function runGrounnelEvalOnce(deps: GrounnelEvalDeps, goldenCase: GoldenCase): Promise<GrounnelRun> {
  const { provider, prompts, searchProvider } = deps;
  const grounnelStore = new RedisGrounnelStore(new InMemoryRedisHashClient());
  const historyStore = new DrizzleGrounnelHistoryStore();
  const llmCallStore = new DrizzleGrounnelLlmCallStore();
  const gateEventStore = new DrizzleGrounnelGateEventStore();
  const rerankDecisionStore = new DrizzleGrounnelRerankDecisionStore();
  const extractService = new GrounnelExtractService(provider, prompts, grounnelStore, historyStore, llmCallStore);
  const pipelineService = new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore, historyStore, llmCallStore, gateEventStore, rerankDecisionStore);

  const { id, pendingClaims } = await extractService.run(goldenCase.text, "eval");
  const eligibleClaims = await extractService.classifyEligibility(id, pendingClaims);
  if (eligibleClaims.length > 0) {
    await pipelineService.run(id, eligibleClaims, goldenCase.searchEngine ?? "defaultFlow");
  }
  const status = await grounnelStore.getStatus(id);
  return { id, claims: status!.claims.map((c) => ({ text: c.text, verdict: c.verdict, status: c.status, reason: c.reason })) };
}

export interface ResolvedFixtureClaim {
  id: string;
  claimText: string;
  subjectEntity: string;
  passages: Array<{ text: string }>;
}

/** Spec 013 T22 — real EXTRACT + eligibility + search/rerank, stopping before VERIFY. Snapshots the
 * exact {id, claim, subjectEntity, passages} VERIFY would receive, reusable across both schema-order
 * arms of the A/B without re-spending EXTRACT/search calls per arm. Same construction as
 * runGrounnelEvalOnce, just calling pipelineService.resolveEvidenceForClaims instead of .run. */
export async function resolveEvidenceOnce(deps: GrounnelEvalDeps, goldenCase: GoldenCase): Promise<{ runId: string; claims: ResolvedFixtureClaim[] }> {
  const { provider, prompts, searchProvider } = deps;
  const grounnelStore = new RedisGrounnelStore(new InMemoryRedisHashClient());
  const historyStore = new DrizzleGrounnelHistoryStore();
  const llmCallStore = new DrizzleGrounnelLlmCallStore();
  const gateEventStore = new DrizzleGrounnelGateEventStore();
  const rerankDecisionStore = new DrizzleGrounnelRerankDecisionStore();
  const extractService = new GrounnelExtractService(provider, prompts, grounnelStore, historyStore, llmCallStore);
  const pipelineService = new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore, historyStore, llmCallStore, gateEventStore, rerankDecisionStore);

  const { id, pendingClaims } = await extractService.run(goldenCase.text, "eval");
  const eligibleClaims = await extractService.classifyEligibility(id, pendingClaims);
  if (eligibleClaims.length === 0) return { runId: id, claims: [] };
  const resolved = await pipelineService.resolveEvidenceForClaims(id, eligibleClaims, goldenCase.searchEngine ?? "defaultFlow");
  const withPassage = resolved.filter(hasPassage);
  return {
    runId: id,
    claims: withPassage.map((r) => ({
      id: r.claim.id,
      claimText: r.claim.text,
      subjectEntity: r.claim.subjectEntity ?? "",
      passages: r.passages.map((p) => ({ text: p.text! })),
    })),
  };
}

/** Scores N already-executed repetitions of one case. Pure — no network — so the Inngest job can run
 * the repetitions as separate steps and score them here without re-spending API quota on a retry. */
export function scoreGrounnelEvalCase(
  goldenCase: GoldenCase,
  runs: GrounnelRun[],
  errors: string[],
  minCorrectRateOverride?: number,
  expectedRuns?: number
): GrounnelEvalCaseResult {
  if (runs.length === 0) {
    // safetyOk is FALSE, not true: zero observations means the safety property was never checked,
    // and "not checked" must never aggregate into "safe" (review finding — the job's own
    // `cases.every(c => c.safetyOk)` would otherwise log safetyOk:true for a case that never ran).
    return {
      id: goldenCase.id, ok: false, runs: 0, safetyOk: false, correctRate: 0, detectionRate: null, correct: 0, matched: 0,
      falseAccusations: 0, claims: [], violations: [], runDetails: [], run: null,
      errors, error: errors[0] ?? "no repetitions were executed",
    };
  }
  const spec: LiveEvalSpec = {
    id: goldenCase.id,
    claims: goldenCase.claims,
    minCorrectRate: minCorrectRateOverride ?? goldenCase.minCorrectRate,
    detectionFloor: goldenCase.detectionFloor,
  };
  const result = evaluateGrounnelRun(runs, spec);

  // A partially-completed case must not report a pass (review finding). Scoring 2 of a requested 5
  // repetitions and calling it green is the same underpowered-measurement error this whole protocol
  // exists to eliminate — the rate is computed over fewer observations than the run asked for.
  const violations = [...result.violations];
  if (expectedRuns !== undefined && runs.length < expectedRuns) {
    violations.push({
      rule: "incomplete_repetitions",
      detail: `only ${runs.length}/${expectedRuns} repetitions completed (${errors.length} failed) — rates are computed over fewer observations than requested`,
    });
  }

  return {
    id: goldenCase.id,
    ok: violations.length === 0,
    runs: result.runs,
    safetyOk: result.safetyOk,
    correctRate: result.correctRate,
    detectionRate: result.detectionRate,
    correct: result.correct,
    matched: result.matched,
    falseAccusations: violations.filter((v) => v.rule === "no_false_accusation").length,
    claims: result.claims,
    violations,
    runDetails: runs,
    run: runs[0] ?? null,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** One golden case, `repeats` real EXTRACT + pipeline runs, scored together. Exported so callers that need their own checkpointing (the Inngest job, one step per case) don't have to run the whole golden set as a single unit. */
export async function runGrounnelEvalCase(
  deps: GrounnelEvalDeps,
  goldenCase: GoldenCase,
  minCorrectRateOverride?: number,
  repeats = 1
): Promise<GrounnelEvalCaseResult> {
  const n = normalizeRepeats(repeats);
  const runs: GrounnelRun[] = [];
  const errors: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      runs.push(await runGrounnelEvalOnce(deps, goldenCase));
    } catch (err) {
      errors.push(sanitizeErrorMessage(err));
    }
  }
  return scoreGrounnelEvalCase(goldenCase, runs, errors, minCorrectRateOverride, n);
}

function summarize(cases: GrounnelEvalCaseResult[]): GrounnelEvalSummary {
  let totalMatched = 0;
  let totalCorrect = 0;
  let totalFalseAccusations = 0;
  for (const c of cases) {
    totalMatched += c.matched;
    totalCorrect += c.correct;
    totalFalseAccusations += c.falseAccusations;
  }
  const passed = cases.every((c) => c.ok) && totalFalseAccusations === 0;
  return { cases, totalMatched, totalCorrect, totalFalseAccusations, passed };
}

/** Shared by the CLI script and the Inngest job (both manual, real-call) — one implementation, not two. No Postgres (D019 §4); state lives only for this run. */
export async function runGrounnelEval(
  deps: GrounnelEvalDeps,
  golden: { cases: GoldenCase[] },
  minCorrectRateOverride?: number,
  repeats = 1
): Promise<GrounnelEvalSummary> {
  const cases: GrounnelEvalCaseResult[] = [];
  for (const goldenCase of golden.cases) {
    cases.push(await runGrounnelEvalCase(deps, goldenCase, minCorrectRateOverride, repeats));
  }
  return summarize(cases);
}

export { summarize as summarizeGrounnelEvalCases };
