import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { waitUntil } from "@vercel/functions";
import { ExtractRequestSchema } from "../contracts/grounnel.schemas.js";
import { authHook } from "../lib/auth.js";
import { isShareTokenShape } from "../lib/share-token.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";
import { RateLimitError } from "../providers/gemini.js";
import { buildGeminiRateLimitMessage, type GrounnelPipelineService } from "../orchestrators/grounnel/pipeline.service.js";
import type { GrounnelExtractService } from "../orchestrators/grounnel/extract.service.js";
import type { GrounnelStore } from "../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import type { RateLimiter } from "../lib/rate-limit.js";

const MODULE = "routes-grounnel";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** D020 §4 fix — x-grounnel-client-ip is only honored from the trusted biassemble/backend proxy,
 * proven by a secret AI_CORE_API_KEY doesn't grant (any other holder of that key could otherwise
 * forge someone else's IP and dodge their own bucket). Fails closed: no secret configured, no
 * header, or a mismatch all fall back to request.ip the same way — never trust an unverified header. */
function resolveClientIp(request: { headers: Record<string, unknown>; ip: string }): string {
  const proxySecret = request.headers["x-grounnel-internal-secret"];
  const forwardedIp = request.headers["x-grounnel-client-ip"];
  if (
    typeof proxySecret === "string" &&
    typeof forwardedIp === "string" &&
    env.GROUNNEL_INTERNAL_PROXY_SECRET &&
    proxySecret === env.GROUNNEL_INTERNAL_PROXY_SECRET
  ) {
    return forwardedIp;
  }
  return request.ip;
}

export function registerGrounnelRoutes(
  server: FastifyInstance,
  services: {
    extractService: GrounnelExtractService;
    pipelineService: GrounnelPipelineService;
    grounnelStore: GrounnelStore;
    historyStore: GrounnelHistoryStore;
    rateLimiter: RateLimiter;
    /** Separate bucket from `rateLimiter` — a burst of shared-link reads must not block a run. */
    assessmentRateLimiter: RateLimiter;
  }
) {
  server.post("/extract", { preHandler: [authHook] }, async (request, reply) => {
    // ADR-001 §4 (biassemble/backend) — request.ip is the proxy's own egress IP, not the real
    // end-user; x-grounnel-client-ip carries the real one, but only once resolveClientIp has
    // verified it came from the trusted proxy (D020 §4) — never trusted from just any caller.
    const clientIp = resolveClientIp(request);
    // Defense-in-depth behind authHook, not the primary control (D020 §4, spec.md).
    if (!(await services.rateLimiter.checkAndConsume(clientIp))) {
      return reply.status(429).send({ error: "Too many requests — try again later." });
    }

    let body: { text: string; sessionId?: string; searchEngine: "defaultFlow" | "tavily" };
    try {
      body = ExtractRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "Invalid request body", details: error.issues });
      }
      throw error;
    }

    let extracted;
    try {
      extracted = await services.extractService.run(body.text, "production", body.sessionId ?? null);
    } catch (error) {
      if (error instanceof RateLimitError) {
        // No audit exists yet (D019 trust boundary) — nowhere to write a per-claim reason, so the message becomes the /extract response itself.
        logger.error(
          { module: MODULE, operation: "POST /extract", limitType: error.limitType, requestId: request.id },
          "Gemini rate-limited during EXTRACT"
        );
        return reply.status(503).send({
          error: buildGeminiRateLimitMessage(error),
          limit_type: error.limitType,
          resets_at: error.resetsAt ?? null,
        });
      }
      logger.error({ module: MODULE, operation: "POST /extract", error, requestId: request.id }, "Extract failed");
      return reply.status(502).send({ error: "Extract failed" });
    }

    reply.status(202).send({ id: extracted.id, shareToken: extracted.shareToken });

    // No external queue (D020 §3) — eligibility classification + the pipeline both run here, after
    // the response is flushed. waitUntil (D016/assessment.service.ts's own established pattern), not
    // a bare await: Vercel freezes the container as soon as `res` finishes, regardless of whether
    // this handler's own promise chain is still pending — maxDuration only bounds how long work is
    // ALLOWED to run, it does not keep the container alive to do it. waitUntil is the actual platform
    // contract. D030 §3b (review finding) — eligibility used to run inside extractService.run(), blocking this response.
    if (extracted.pendingClaims.length > 0) {
      waitUntil(
        (async () => {
          const eligible = await services.extractService.classifyEligibility(extracted.id, extracted.pendingClaims);
          if (eligible.length > 0) {
            await services.pipelineService.run(extracted.id, eligible, body.searchEngine, body.text);
          }
        })().catch((err) => {
          logger.error(
            { module: MODULE, operation: "POST /extract (background pipeline)", auditId: extracted.id, err },
            "Eligibility classification or pipeline run failed after the 202 response was already sent"
          );
        })
      );
    }
  });

  server.get("/status/:id", { preHandler: [authHook] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: "invalid id" });
    }

    // Full shape every call, no delta logic (tasks.md T012 acceptance) — `status` itself
    // communicates extracting/verifying/done, unlike /audit's running/failed/complete split.
    const status = await services.grounnelStore.getStatus(id);
    if (!status) {
      return reply.status(404).send({ error: "not_found" });
    }

    return reply.status(200).send(status);
  });

  // Spec 019 T007 — the ONE unauthenticated route on this service, deliberately outside authHook:
  // a shared link must open with no credential (FR-004). Kept narrow on purpose — one token in,
  // one assessment out. No list, no search, no filters.
  server.get("/assessment/:token", async (request, reply) => {
    const { token } = request.params as { token: string };

    // T014 — checked before the shape test so a scraper guessing tokens is limited too. Keyed on
    // resolveClientIp, NOT request.ip: every real viewer arrives through the site's backend proxy,
    // so request.ip is that proxy's egress IP and one busy reader would 429 every other visitor.
    if (!(await services.assessmentRateLimiter.checkAndConsume(resolveClientIp(request)))) {
      return reply.status(429).send({ error: "Too many requests — try again later." });
    }

    // T008/FR-010 — a malformed token, an unknown one and a deleted run all return the SAME
    // response. Distinguishing them would make this endpoint an oracle for whether a run exists.
    // A run_id supplied here fails isShareTokenShape on length and never reaches the DB (FR-003).
    if (!isShareTokenShape(token)) {
      return reply.status(404).send({ error: "not_found" });
    }

    let assessment: Awaited<ReturnType<GrounnelHistoryStore["readAssessmentByToken"]>>;
    try {
      assessment = await services.historyStore.readAssessmentByToken(token);
    } catch (err) {
      logger.error({ module: MODULE, operation: "GET /assessment/:token", err }, "Shared assessment read failed");
      return reply.status(503).send({ error: "unavailable" });
    }

    if (!assessment) {
      return reply.status(404).send({ error: "not_found" });
    }

    // T009 — these documents may name private individuals. Links are for passing between people,
    // not for search results; robots.txt on the site is the other half of this.
    return reply.status(200).header("X-Robots-Tag", "noindex").send(assessment);
  });
}
