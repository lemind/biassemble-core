// A queued Grounnel check: eligibility, then claims in chunks (each its own invocation and 300 s), then done (D034 §3).
import { inngest } from "./client.js";
import { logger } from "../observability/logger.js";
import type { Provider } from "../providers/types.js";
import type { ProviderId } from "../providers/registry.js";
import type { RunKeyVault } from "../lib/run-key-vault.js";
import type { GrounnelExtractService } from "../orchestrators/grounnel/extract.service.js";
import type { GrounnelPipelineService, PipelineClaimInput } from "../orchestrators/grounnel/pipeline.service.js";
import type { GrounnelFailureReason } from "../db/schema.js";

const MODULE = "grounnel-check-job";
export const GROUNNEL_CHECK_EVENT = "grounnel/check.queued";
/** Claims per step: ~6.5 s a claim plus escalation stays well inside one invocation. */
export const CLAIMS_PER_STEP = 8;
/** Checks verified at once. More shares the site's Gemini and Tavily limits too thinly (spec 021 T2131). */
export const CHECKS_AT_ONCE = 3;

export interface GrounnelCheckEvent {
  runId: string;
  text: string;
  pendingClaims: PipelineClaimInput[];
  searchEngine: "defaultFlow" | "tavily";
  /** Undefined: the boot provider (site Gemini). */
  providerId?: ProviderId;
  keySource?: "site" | "own";
}

export interface GrounnelCheckDeps {
  extractService: GrounnelExtractService;
  pipelineService: GrounnelPipelineService;
  vault: RunKeyVault | undefined;
  /** Rebuilds the run's judge inside each step. An own key comes from the vault, never the event. */
  buildProvider: (providerId: ProviderId, keySource: "site" | "own", ownKey: string | undefined) => Provider;
}

class KeyGoneError extends Error {
  constructor() {
    super("The run's own key expired before the check finished");
    this.name = "KeyGoneError";
  }
}

/** Runs fn as one durable step; Inngest's step.run in production, a plain call in tests. */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

function makeHelpers(deps: GrounnelCheckDeps) {
  async function judge(data: GrounnelCheckEvent): Promise<Provider | undefined> {
    if (!data.providerId) return undefined;
    const keySource = data.keySource ?? "site";
    if (keySource !== "own") return deps.buildProvider(data.providerId, keySource, undefined);
    const key = deps.vault ? await deps.vault.get(data.runId) : null;
    if (!key) throw new KeyGoneError();
    return deps.buildProvider(data.providerId, "own", key);
  }

  async function forgetKey(runId: string): Promise<void> {
    if (!deps.vault) return;
    try {
      await deps.vault.delete(runId);
    } catch (err) {
      logger.warn({ module: MODULE, operation: "forgetKey", runId, err }, "Could not delete the run key; it expires on its own");
    }
  }
  return { judge, forgetKey };
}

/** The job body: eligibility, chunks of claims, then done. Each step builds the judge itself, so an own key lives only in that step. */
export async function runQueuedCheck(data: GrounnelCheckEvent, step: StepRunner, deps: GrounnelCheckDeps) {
  const { judge, forgetKey } = makeHelpers(deps);
  const eligible: PipelineClaimInput[] = await step.run("eligibility", async () =>
    deps.extractService.classifyEligibility(data.runId, data.pendingClaims, await judge(data))
  );
  // No eligible claims: classifyEligibility already wrote done.
  if (eligible.length === 0) {
    await step.run("forget-key", () => forgetKey(data.runId));
    return { claims: 0, stoppedBy: null };
  }

  let stoppedBy: GrounnelFailureReason | undefined;
  for (let i = 0; i < eligible.length; i += CLAIMS_PER_STEP) {
    const chunk = eligible.slice(i, i + CLAIMS_PER_STEP);
    if (stoppedBy) {
      // The provider stopped the check: the rest are unchecked, as in a single-invocation run (D034 §8).
      await step.run(`unchecked-${i}`, () => deps.pipelineService.markUnchecked(data.runId, chunk, "The provider stopped this check before this claim was reached."));
      continue;
    }
    const stop = await step.run(`verify-${i}`, async () =>
      (await deps.pipelineService.runChunk(data.runId, chunk, data.searchEngine, data.text, await judge(data))) ?? null
    );
    if (stop) stoppedBy = stop;
  }

  await step.run("finish", async () => {
    await deps.pipelineService.finishRun(data.runId, stoppedBy);
    await forgetKey(data.runId);
  });
  return { claims: eligible.length, stoppedBy: stoppedBy ?? null };
}

/** After Inngest's retries run out: the run fails with a reason, and its key is deleted at once. */
export async function failQueuedCheck(data: GrounnelCheckEvent, error: { name: string; message: string }, deps: GrounnelCheckDeps): Promise<void> {
  const reason: GrounnelFailureReason = error.name === "KeyGoneError" ? "time_limit" : "pipeline";
  logger.error({ module: MODULE, operation: "onFailure", runId: data.runId, reason, err: error.message }, "Queued check failed");
  await deps.pipelineService.failRun(data.runId, reason);
  await makeHelpers(deps).forgetKey(data.runId);
}

export function createGrounnelCheckJob(deps: GrounnelCheckDeps) {
  return inngest.createFunction(
    {
      id: "grounnel-check",
      name: "Grounnel — Run a check",
      concurrency: { limit: CHECKS_AT_ONCE },
      retries: 2,
      onFailure: async ({ event, error }) => failQueuedCheck(event.data.event.data as GrounnelCheckEvent, error, deps),
    },
    { event: GROUNNEL_CHECK_EVENT },
    async ({ event, step }) => runQueuedCheck(event.data as GrounnelCheckEvent, step as unknown as StepRunner, deps)
  );
}
