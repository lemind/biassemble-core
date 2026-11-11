import { waitUntil } from "@vercel/functions";
import { logger } from "../../observability/logger.js";
import { preflightOwnKey, type PreflightFailure } from "../../providers/preflight.js";
import { RateLimitError, type Provider } from "../../providers/types.js";
import type { GrounnelEntryPoint } from "../../db/schema.js";
import type { GrounnelExtractService } from "./extract.service.js";
import type { GrounnelPipelineService, PipelineClaimInput } from "./pipeline.service.js";

const MODULE = "start-check";

export interface StartCheckInput {
  text: string;
  sessionId: string | null;
  searchEngine: "defaultFlow" | "tavily";
  /** Undefined provider means site Gemini, as chosen by the caller (D033). */
  provider?: Provider;
  keySource?: "site" | "own";
  entryPoint: GrounnelEntryPoint;
  /** Called once the run row is written, before this returns (D034 §5). */
  onRunCreated?: (shareToken: string) => Promise<void>;
}

export type StartCheckResult =
  | { ok: true; id: string; shareToken: string; pendingClaims: PipelineClaimInput[] }
  | { ok: false; kind: "preflight"; failure: PreflightFailure }
  | { ok: false; kind: "rate_limited"; error: RateLimitError }
  | { ok: false; kind: "extraction_failed"; error: unknown };

/** The one start path for /extract and MCP: preflight, extraction, then the rest after the reply via waitUntil (D034 §3). */
export async function startCheck(
  services: { extractService: GrounnelExtractService; pipelineService: GrounnelPipelineService },
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

  // No external queue (D020 §3, D034 §3): waitUntil keeps the invocation alive after the reply; a bare await would be frozen.
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
