import { RedisGrounnelStore, type RedisHashClient } from "../persistence/grounnel-store.js";
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

/** Shared by the CLI script and the Inngest job (both manual, real-call) — one implementation, not two. No Postgres (D019 §4); state lives only for this run. */
export async function runGrounnelEval(
  deps: GrounnelEvalDeps,
  golden: { cases: GoldenCase[] },
  minCorrectRateOverride?: number
): Promise<GrounnelEvalSummary> {
  const { provider, prompts, searchProvider } = deps;
  const cases: GrounnelEvalCaseResult[] = [];
  let totalMatched = 0;
  let totalCorrect = 0;
  let totalFalseAccusations = 0;

  for (const goldenCase of golden.cases) {
    const grounnelStore = new RedisGrounnelStore(new InMemoryRedisHashClient());
    const extractService = new GrounnelExtractService(provider, prompts, grounnelStore);
    const pipelineService = new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore);

    try {
      const { id, pendingClaims } = await extractService.run(goldenCase.text);
      if (pendingClaims.length > 0) {
        await pipelineService.run(id, pendingClaims);
      }
      const status = await grounnelStore.getStatus(id);
      const run: GrounnelRun = { id, claims: status!.claims.map((c) => ({ text: c.text, verdict: c.verdict })) };

      const spec: LiveEvalSpec = { id: goldenCase.id, claims: goldenCase.claims, minCorrectRate: minCorrectRateOverride ?? goldenCase.minCorrectRate };
      const result = evaluateGrounnelRun([run], spec);
      const falseAccusations = result.violations.filter((v) => v.rule === "no_false_accusation").length;

      totalMatched += result.matched;
      totalCorrect += Math.round(result.correctRate * result.matched);
      totalFalseAccusations += falseAccusations;

      cases.push({ id: goldenCase.id, ok: result.ok, correctRate: result.correctRate, matched: result.matched, falseAccusations, violations: result.violations, run });
    } catch (err) {
      cases.push({
        id: goldenCase.id,
        ok: false,
        correctRate: 0,
        matched: 0,
        falseAccusations: 0,
        violations: [],
        run: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = cases.every((c) => c.ok) && totalFalseAccusations === 0;
  return { cases, totalMatched, totalCorrect, totalFalseAccusations, passed };
}
