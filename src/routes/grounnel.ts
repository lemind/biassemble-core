import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ExtractRequestSchema } from "../contracts/grounnel.schemas.js";
import { authHook } from "../lib/auth.js";
import { logger } from "../observability/logger.js";
import { RateLimitError } from "../providers/gemini.js";
import { buildGeminiRateLimitMessage, type GrounnelPipelineService } from "../orchestrators/grounnel/pipeline.service.js";
import type { GrounnelExtractService } from "../orchestrators/grounnel/extract.service.js";
import type { GrounnelStore } from "../persistence/grounnel-store.js";
import type { RateLimiter } from "../lib/rate-limit.js";

const MODULE = "routes-grounnel";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerGrounnelRoutes(
  server: FastifyInstance,
  services: {
    extractService: GrounnelExtractService;
    pipelineService: GrounnelPipelineService;
    grounnelStore: GrounnelStore;
    rateLimiter: RateLimiter;
  }
) {
  server.post("/extract", { preHandler: [authHook] }, async (request, reply) => {
    // ADR-001 §4 (biassemble/backend) — every Grounnel request arrives via that repo's
    // server-to-server proxy, so request.ip is the backend's own egress IP for every user, not
    // the real end-user. X-Grounnel-Client-IP carries the real one; request.ip is the fallback
    // for local dev/direct testing where no proxy is in front of this route.
    const clientIp = (request.headers["x-grounnel-client-ip"] as string | undefined) || request.ip;
    // Defense-in-depth behind authHook, not the primary control (D020 §4, spec.md).
    if (!services.rateLimiter.checkAndConsume(clientIp)) {
      return reply.status(429).send({ error: "Too many requests — try again later." });
    }

    let body: { text: string; sessionId?: string };
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

    reply.status(202).send({ id: extracted.id });

    // No external queue (D020 §3) — the pipeline runs here, after the response is flushed. vercel.json's maxDuration:300 keeps the invocation alive; the client polls GET /status/:id instead.
    if (extracted.pendingClaims.length > 0) {
      await services.pipelineService.run(extracted.id, extracted.pendingClaims).catch((err) => {
        logger.error(
          { module: MODULE, operation: "POST /extract (background pipeline)", auditId: extracted.id, err },
          "Pipeline run failed after the 202 response was already sent"
        );
      });
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
}
