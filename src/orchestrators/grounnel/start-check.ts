import { waitUntil } from "@vercel/functions";
import { logger } from "../../observability/logger.js";
import { preflightOwnKey, type PreflightFailure } from "../../providers/preflight.js";
import { RateLimitError, type Provider } from "../../providers/types.js";
import type { GrounnelEntryPoint } from "../../db/schema.js";
import type { GrounnelExtractService } from "./extract.service.js";
import type { GrounnelPipelineService, PipelineClaimInput } from "./pipeline.service.js";
import type { RunKeyVault } from "../../lib/run-key-vault.js";
import type { GrounnelCheckEvent } from "../../jobs/grounnel-check.js";
import type { ProviderId } from "../../providers/registry.js";

const MODULE = "start-check";

export interface StartCheckInput {
  text: string;
  sessionId: string | null;
  searchEngine: "defaultFlow" | "tavily";
  /** Undefined provider means site Gemini, as chosen by the caller (D033). */
  provider?: Provider;
  keySource?: "site" | "own";
  entryPoint: GrounnelEntryPoint;
  /** The raw own key, sealed in the run-key vault when the check is queued. Never logged or sent (D034 §3). */
  ownKey?: string;
  /** Called once the run row is written, before this returns (D034 §5). */
  onRunCreated?: (shareToken: string) => Promise<void>;
}

export type StartCheckResult =
  | { ok: true; id: string; shareToken: string; pendingClaims: PipelineClaimInput[] }
  | { ok: false; kind: "preflight"; failure: PreflightFailure }
  | { ok: false; kind: "rate_limited"; error: RateLimitError }
  | { ok: false; kind: "extraction_failed"; error: unknown };

/** Where a check goes after extraction: the vault for an own key, and the job's event (D034 §3). */
export interface CheckQueue {
  vault: RunKeyVault | undefined;
  send(data: GrounnelCheckEvent): Promise<void>;
}

const PROVIDER_IDS: readonly string[] = ["gemini", "deepseek", "qwen"];

/** Hands the rest of the check to the queued job. False means the caller runs it in-process instead. */
async function enqueue(queue: CheckQueue, input: StartCheckInput, id: string, pendingClaims: PipelineClaimInput[]): Promise<boolean> {
  const mode = input.provider?.mode;
  const providerId = mode && PROVIDER_IDS.includes(mode) ? (mode as ProviderId) : undefined;
  const own = input.keySource === "own";
  if (own && (!queue.vault || !input.ownKey || !providerId)) return false;
  try {
    if (own) await queue.vault!.put(id, input.ownKey!);
    await queue.send({ runId: id, text: input.text, pendingClaims, searchEngine: input.searchEngine, ...(providerId ? { providerId } : {}), ...(input.keySource ? { keySource: input.keySource } : {}) });
    return true;
  } catch (err) {
    logger.warn({ module: MODULE, operation: "enqueue", auditId: id, err }, "Could not queue the check — running it in this invocation");
    if (own) await queue.vault!.delete(id).catch(() => undefined);
    return false;
  }
}

/** The one start path for /extract and MCP: preflight, extraction, then the rest queued, or after the reply via waitUntil without a queue (D034 §3). */
export async function startCheck(
  services: { extractService: GrounnelExtractService; pipelineService: GrounnelPipelineService; queue?: CheckQueue },
  input: StartCheckInput,
): Promise<StartCheckResult> {
  // Own key only. Site Gemini is not probed, and a pass does not change later claim handling (D033 §3).
  if (input.keySource === "own" && input.provider) {
    const failure = await preflightOwnKey(input.provider);
    if (failure) return { ok: false, kind: "preflight", failure };
  }

  let extracted;
  try {
    extracted = await services.extractService.run(
      input.text,
      "production",
      input.sessionId,
      input.provider,
      input.keySource,
      input.entryPoint,
      input.onRunCreated,
    );
  } catch (error) {
    if (error instanceof RateLimitError) return { ok: false, kind: "rate_limited", error };
    return { ok: false, kind: "extraction_failed", error };
  }

  // Queued: each chunk of claims gets its own invocation and time limit (D034 §3).
  if (extracted.pendingClaims.length > 0 && services.queue && (await enqueue(services.queue, input, extracted.id, extracted.pendingClaims))) {
    return { ok: true, id: extracted.id, shareToken: extracted.shareToken, pendingClaims: extracted.pendingClaims };
  }

  // Fallback without a queue: waitUntil keeps the invocation alive after the reply; a bare await would be frozen.
  if (extracted.pendingClaims.length > 0) {
    waitUntil(
      (async () => {
        try {
          const eligible = await services.extractService.classifyEligibility(extracted.id, extracted.pendingClaims, input.provider);
          // eligible.length === 0 is already status=done inside classifyEligibility. Running the pipeline here would write done twice.
          if (eligible.length > 0) {
            await services.pipelineService.run(extracted.id, eligible, input.searchEngine, input.text, input.provider);
          }
        } catch (err) {
          logger.error(
            { module: MODULE, operation: "startCheck (background pipeline)", auditId: extracted.id, entryPoint: input.entryPoint, err },
            "Eligibility classification or pipeline run failed after the start reply was already sent"
          );
        }
      })()
    );
  }

  return { ok: true, id: extracted.id, shareToken: extracted.shareToken, pendingClaims: extracted.pendingClaims };
}
