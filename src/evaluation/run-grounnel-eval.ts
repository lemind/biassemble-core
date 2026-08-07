import { RedisGrounnelStore, type RedisHashClient } from "../persistence/grounnel-store.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { GrounnelExtractService } from "../orchestrators/grounnel/extract.service.js";
import { GrounnelPipelineService } from "../orchestrators/grounnel/pipeline.service.js";
import { evaluateGrounnelRun, type GrounnelRun, type LiveEvalSpec, type Violation } from "./grounnel-live-gate.js";
import type { Provider } from "../providers/types.js";
import type { PromptRegistry } from "../prompts/registry.js";
import type { SearchProvider } from "../providers/search/search-provider.js";

/** In-memory RedisHashClient for a single eval run — no Postgres/Redis (D019 §4); src/ never depends on tests/mocks. */
class InMemoryRedisHashClient implements RedisHashClient {
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
}

export interface GrounnelEvalDeps {
  provider: Provider;
  prompts: PromptRegistry;
  searchProvider: SearchProvider;
}

export interface GrounnelEvalCaseResult {
  id: string;
  ok: boolean;
  correctRate: number;
  correct: number;
  matched: number;
  falseAccusations: number;
  violations: Violation[];
  run: GrounnelRun | null;
  error?: string;
}

export interface GrounnelEvalSummary {
  cases: GrounnelEvalCaseResult[];
  totalMatched: number;
  totalCorrect: number;
  totalFalseAccusations: number;
  passed: boolean;
}

/** One golden case, one real EXTRACT + pipeline run, scored. Exported so callers that need their own checkpointing (the Inngest job, one step per case) don't have to run the whole golden set as a single unit. */
export async function runGrounnelEvalCase(
  deps: GrounnelEvalDeps,
  goldenCase: GoldenCase,
  minCorrectRateOverride?: number
): Promise<GrounnelEvalCaseResult> {
  const { provider, prompts, searchProvider } = deps;
  const grounnelStore = new RedisGrounnelStore(new InMemoryRedisHashClient());
  // Real DrizzleGrounnelHistoryStore, not a no-op — golden-set runs are exactly what source: "eval"
  // exists to tag (D023 §3), so this real-call eval harness should exercise the real write path too.
  const historyStore = new DrizzleGrounnelHistoryStore();
  const extractService = new GrounnelExtractService(provider, prompts, grounnelStore, historyStore);
  const pipelineService = new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore, historyStore);

  try {
    const { id, pendingClaims } = await extractService.run(goldenCase.text, "eval");
    if (pendingClaims.length > 0) {
      await pipelineService.run(id, pendingClaims);
    }
    const status = await grounnelStore.getStatus(id);
    const run: GrounnelRun = { id, claims: status!.claims.map((c) => ({ text: c.text, verdict: c.verdict, status: c.status, reason: c.reason })) };

    const spec: LiveEvalSpec = { id: goldenCase.id, claims: goldenCase.claims, minCorrectRate: minCorrectRateOverride ?? goldenCase.minCorrectRate };
    const result = evaluateGrounnelRun([run], spec);
    const falseAccusations = result.violations.filter((v) => v.rule === "no_false_accusation").length;

    return { id: goldenCase.id, ok: result.ok, correctRate: result.correctRate, correct: result.correct, matched: result.matched, falseAccusations, violations: result.violations, run };
  } catch (err) {
    return { id: goldenCase.id, ok: false, correctRate: 0, correct: 0, matched: 0, falseAccusations: 0, violations: [], run: null, error: sanitizeErrorMessage(err) };
  }
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
  minCorrectRateOverride?: number
): Promise<GrounnelEvalSummary> {
  const cases: GrounnelEvalCaseResult[] = [];
  for (const goldenCase of golden.cases) {
    cases.push(await runGrounnelEvalCase(deps, goldenCase, minCorrectRateOverride));
  }
  return summarize(cases);
}

export { summarize as summarizeGrounnelEvalCases };
