import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ExtractRequestSchema } from "../contracts/grounnel.schemas.js";
import { authHook } from "../lib/auth.js";
import { isShareTokenShape } from "../lib/share-token.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";
import { preflightHttpStatus } from "../providers/preflight.js";
import type { Provider } from "../providers/types.js";
import {
  ProviderConfigError,
  ProviderKeyRequiredError,
  SITE_DEFAULT_PROVIDER,
  resolveProvider,
  type ProviderId,
} from "../providers/registry.js";
import { sumGrounnelJudgingTokens } from "../db/queries.js";
import { ownKeyTokensAtServe } from "../lib/own-key-tokens.js";
import { buildGeminiRateLimitMessage, type GrounnelPipelineService } from "../orchestrators/grounnel/pipeline.service.js";
import type { GrounnelExtractService } from "../orchestrators/grounnel/extract.service.js";
import { startCheck, type CheckQueue } from "../orchestrators/grounnel/start-check.js";
import type { GrounnelStore } from "../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import type { RateLimiter } from "../lib/rate-limit.js";

const MODULE = "routes-grounnel";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_IDS = ["gemini", "deepseek", "qwen"] as const;

export type ExtractProviderDecision =
  | { ok: true; provider?: Provider; keySource?: "site" | "own" }
  | { ok: false; status: 400 | 502; error: "provider_requires_own_key" | "unknown_provider" | "Extract failed" };

function headerText(value: unknown): { kind: "absent" } | { kind: "value"; value: string } | { kind: "invalid" } {
  if (value === undefined) return { kind: "absent" };
  // A duplicated or non-string header is not read. Its contents are not logged (D033).
  if (typeof value !== "string") return { kind: "invalid" };
  const trimmed = value.trim();
  return trimmed.length > 0 ? { kind: "value", value: trimmed } : { kind: "absent" };
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function deploymentKey(id: ProviderId): string | undefined {
  if (id === "deepseek") return env.DEEPSEEK_API_KEY;
  if (id === "qwen") return env.QWEN_API_KEY;
  return undefined;
}

/** No provider and no key keeps the boot Gemini client. deepseek or qwen without a key is rejected unless that id is the hidden site choice (D033, T2010). */
export function chooseExtractProvider(
  providerHeader: unknown,
  keyHeader: unknown,
  siteDefault: ProviderId = SITE_DEFAULT_PROVIDER,
): ExtractProviderDecision {
  const providerText = headerText(providerHeader);
  if (providerText.kind === "invalid") return { ok: false, status: 400, error: "unknown_provider" };
  if (providerText.kind === "value" && !isProviderId(providerText.value)) {
    return { ok: false, status: 400, error: "unknown_provider" };
  }
  // Absent provider is Gemini, not the hidden choice. The hidden choice is not a request header (D033).
  const providerId: ProviderId = providerText.kind === "value" && isProviderId(providerText.value) ? providerText.value : "gemini";
  const keyText = headerText(keyHeader);
  const visitorKey = keyText.kind === "value" ? keyText.value : undefined;
  if (!visitorKey) {
    if (providerId === "gemini") return { ok: true };
    if (providerId !== siteDefault) return { ok: false, status: 400, error: "provider_requires_own_key" };
    return buildResolved(providerId, deploymentKey(providerId), "site");
  }
  return buildResolved(providerId, visitorKey, "own");
}

function buildResolved(id: ProviderId, key: string | undefined, keySource: "site" | "own"): ExtractProviderDecision {
  try {
    return { ok: true, provider: resolveProvider(id, key), keySource };
  } catch (err) {
    if (err instanceof ProviderKeyRequiredError || err instanceof ProviderConfigError) {
      return { ok: false, status: 502, error: "Extract failed" };
    }
    throw err;
  }
}

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
    /** Absent: checks finish in the starting invocation (D034 §3). */
    queue?: CheckQueue;
    grounnelStore: GrounnelStore;
    historyStore: GrounnelHistoryStore;
    rateLimiter: RateLimiter;
    /** Own-key checks. Separate from `rateLimiter`; still per IP, because search is site-paid (FR-018). */
    ownKeyRateLimiter: RateLimiter;
    /** Separate bucket from `rateLimiter` — a burst of shared-link reads must not block a run. */
    assessmentRateLimiter: RateLimiter;
  }
) {
  server.post("/extract", { preHandler: [authHook] }, async (request, reply) => {
    // ADR-001 §4 (biassemble/backend) — request.ip is the proxy's own egress IP, not the real
    // end-user; x-grounnel-client-ip carries the real one, but only once resolveClientIp has
    // verified it came from the trusted proxy (D020 §4) — never trusted from just any caller.
    const clientIp = resolveClientIp(request);
    // A blank or duplicated key header is not an own key, so it stays on the stricter site bucket (FR-018).
    const hasOwnKey = headerText(request.headers["x-grounnel-provider-key"]).kind === "value";
    const limiter = hasOwnKey ? services.ownKeyRateLimiter : services.rateLimiter;
    if (!(await limiter.checkAndConsume(clientIp))) {
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

    // Headers only. The hidden site choice is SITE_DEFAULT_PROVIDER, which a visitor cannot set (D033).
    const decision = chooseExtractProvider(request.headers["x-grounnel-provider"], request.headers["x-grounnel-provider-key"]);
    if (!decision.ok) {
      if (decision.status === 502) {
        logger.error({ module: MODULE, operation: "POST /extract", requestId: request.id }, "Provider is not configured");
      }
      return reply.status(decision.status).send({ error: decision.error });
    }

    const started = await startCheck(services, {
      text: body.text,
      sessionId: body.sessionId ?? null,
      searchEngine: body.searchEngine,
      provider: decision.provider,
      keySource: decision.keySource,
      entryPoint: "website",
      ...(decision.keySource === "own" ? { ownKey: (request.headers["x-grounnel-provider-key"] as string).trim() } : {}),
    });
    if (!started.ok) {
      if (started.kind === "preflight") {
        logger.warn(
          { module: MODULE, operation: "POST /extract", requestId: request.id, category: started.failure.category, provider: decision.provider?.mode },
          "Visitor key preflight failed",
        );
        return reply.status(preflightHttpStatus(started.failure.category)).send({ error: started.failure.category, message: started.failure.message });
      }
      if (started.kind === "rate_limited") {
        // No audit exists yet (D019 trust boundary) — nowhere to write a per-claim reason, so the message becomes the /extract response itself.
        logger.error(
          { module: MODULE, operation: "POST /extract", limitType: started.error.limitType, requestId: request.id },
          "Gemini rate-limited during EXTRACT"
        );
        return reply.status(503).send({
          error: buildGeminiRateLimitMessage(started.error),
          limit_type: started.error.limitType,
          resets_at: started.error.resetsAt ?? null,
        });
      }
      logger.error({ module: MODULE, operation: "POST /extract", error: started.error, requestId: request.id }, "Extract failed");
      return reply.status(502).send({ error: "Extract failed" });
    }

    // Eligibility and the pipeline already run after this reply, inside startCheck (D034 §3).
    return reply.status(202).send({ id: started.id, shareToken: started.shareToken });
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

    // Same live sum as the share page. A Redis snapshot raced the llm-call inserts and stuck at 0 (T2018).
    if (status.status === "done" || status.status === "failed") {
      const keySource = (await services.grounnelStore.hasOwnKey(id)) ? "own" : undefined;
      status.ownKeyTokens = await ownKeyTokensAtServe(id, keySource, status.status, sumGrounnelJudgingTokens);
    }

    return reply.status(200).send(status);
  });

  // Spec 019 T007 — the ONE unauthenticated route, deliberately outside authHook: a shared link
  // must open with no credential (FR-004). One token in, one assessment out.
  server.get("/assessment/:token", async (request, reply) => {
    const { token } = request.params as { token: string };

    // T014 — before the shape test, so token-guessing is limited too. Keyed on resolveClientIp,
    // not request.ip: every viewer arrives via the site's proxy, which is one shared bucket.
    if (!(await services.assessmentRateLimiter.checkAndConsume(resolveClientIp(request)))) {
      return reply.status(429).send({ error: "Too many requests — try again later." });
    }

    // T008/FR-010 — malformed, unknown and deleted return the SAME response; separating them makes
    // this an existence oracle. A runId fails isShareTokenShape on length (FR-003).
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
