import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { registerAuditRoutes, type AuditEnqueuer } from "../../src/routes/audit.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { MockAuditStore } from "../mocks/mock-audit-store.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { ExtractService } from "../../src/orchestrators/audit/extract.service.js";
import { VerifyService } from "../../src/orchestrators/audit/verify.service.js";
import { GateService } from "../../src/orchestrators/audit/gate.service.js";
import { AuditService } from "../../src/orchestrators/audit/audit.service.js";
import type { LlmCallStore } from "../../src/persistence/ports.js";

/**
 * T021b — end-to-end usability check (the loop's own requirement, and the
 * gap the last review found: without this, POST /audit had no way to ever
 * return its result to a caller). The AuditEnqueuer here runs the pipeline
 * synchronously instead of via a real Inngest event bus — this is a stand-in
 * for jobs/audit-run.ts's async dispatch, not a claim that Inngest itself is
 * being tested; the same AuditService/ExtractService/VerifyService/
 * GateService classes audit-run.ts actually uses are exercised here.
 */

const mockLlmCallStore: LlmCallStore = {
  recordCall: vi.fn().mockResolvedValue({ id: "test-llm-call-id" }),
  getCallsBySession: vi.fn().mockResolvedValue([]),
  getCallsByStage: vi.fn().mockResolvedValue([]),
  getCallsByProvider: vi.fn().mockResolvedValue([]),
  getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
  updateParsedOutput: vi.fn().mockResolvedValue(undefined),
  updateFailure: vi.fn().mockResolvedValue(undefined),
  getCallsForMetrics: vi.fn().mockResolvedValue([]),
};

const AUTH = { authorization: "Bearer dev-secret-change-me" };

describe("POST /audit → GET /audit/:audit_id — end to end (T021b)", () => {
  let server: FastifyInstance;
  let provider: MockProvider;
  let auditStore: MockAuditStore;

  beforeAll(async () => {
    provider = new MockProvider();
    const prompts = new PromptRegistry();
    auditStore = new MockAuditStore();

    const extractService = new ExtractService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
    const verifyService = new VerifyService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
    const gateService = new GateService(auditStore);
    const auditService = new AuditService(extractService, verifyService, gateService, auditStore, "test-version");

    const enqueuer: AuditEnqueuer = {
      async enqueue(data) {
        // Synchronous stand-in for jobs/audit-run.ts's Inngest dispatch —
        // real code path (AuditService.run), fake transport.
        await auditService.run(data.auditId, {
          outputText: data.outputText,
          sources: data.sources,
          task: data.task,
          threshold: data.threshold,
          maxClaims: data.maxClaims,
        });
      },
    };

    server = Fastify();
    server.addHook("onRequest", async (req, reply) => {
      req.id = "test-request-id";
      reply.header("x-request-id", "test-request-id");
    });
    registerAuditRoutes(server, {
      auditStore,
      enqueuer,
      modelName: "mock-model",
      extractPromptVersion: "test",
      verifyPromptVersion: "test",
      pipelineCodeVersion: "test-version",
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("submits, and the result is actually retrievable (the exact gap the last review found) — full happy path to status=complete", async () => {
    // MockProvider matches by system-prompt prefix, so EXTRACT and VERIFY —
    // two distinct calls in one real run — each get their own real response.
    provider.setResponse("You are a claim-extraction engine", {
      claims: [
        {
          id: "c1",
          type: "numeric",
          claim: "Total net sales reached $111,184 million",
          excerpt: "Apple's total net sales reached $111,184 million",
          locations: ["p1s1"],
          period: "Q2 2026",
          derived: false,
        },
      ],
      truncated: false,
    });
    // VERIFY's correct claim_id is a UUID assigned by extract.service.ts
    // after EXTRACT runs — not knowable in advance for a static setResponse.
    // It IS present in VERIFY's own rendered prompt (interpolated into
    // {{claims_batch}}), so a response function reads it back out from there.
    provider.setResponseFn("You are a verification engine", (request) => {
      // Greedy capture, backtracking to the LAST "]" before "PASSAGES:" — the
      // claims_batch array itself contains nested arrays (each claim's
      // `passages: [...]`), so a non-greedy capture stops at the first,
      // inner "]" instead of the outer array's closing bracket.
      const match = request.system.match(/CLAIMS: (\[[\s\S]*\])[\s\S]*?PASSAGES:/);
      const claimsBatch = match ? JSON.parse(match[1]) : [];
      return {
        results: claimsBatch.map((c: { claim_id: string }) => ({
          claim_id: c.claim_id,
          verdict: "supported",
          evidence: ["Total net sales $111,184"],
          source_refs: [],
          synthesized: false,
          note: null,
          confidence: 0.95,
        })),
        trace: {},
      };
    });

    const postResponse = await server.inject({
      method: "POST",
      url: "/audit",
      headers: AUTH,
      payload: {
        domain: "finance",
        output_text: "Apple's total net sales reached $111,184 million.",
        sources: [{ id: "doc1", name: "10-Q", text: "Total net sales $111,184 million." }],
        options: { threshold: 0.6, maxClaims: 50 },
      },
    });

    expect(postResponse.statusCode).toBe(202);
    const { audit_id: auditId, status: submitStatus } = JSON.parse(postResponse.body);
    expect(auditId).toBeTruthy();
    expect(submitStatus).toBe("running");

    const getResponse = await server.inject({
      method: "GET",
      url: `/audit/${auditId}`,
      headers: AUTH,
    });
    expect(getResponse.statusCode).toBe(200);
    const body = JSON.parse(getResponse.body);
    expect(body.audit_id).toBe(auditId);
    expect(body.status).toBe("complete");
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].verdict).toBe("supported");
    expect(body.scores).toBeDefined();
  });

  it("returns 404 for an unknown audit_id", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/audit/${randomUUID()}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for a malformed audit_id", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/audit/not-a-uuid",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 202 with Retry-After while an audit is still running", async () => {
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    // never resolved to complete/failed — stays "running"

    const response = await server.inject({ method: "GET", url: `/audit/${auditId}`, headers: AUTH });
    expect(response.statusCode).toBe(202);
    expect(response.headers["retry-after"]).toBe("5");
    expect(JSON.parse(response.body).status).toBe("running");
  });

  it("full happy path: complete audit returns claims, verdicts, and scores together", async () => {
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claimId = randomUUID();
    await auditStore.createClaims([
      {
        claimId,
        auditId,
        type: "numeric",
        claimText: "Total net sales reached $111,184 million",
        excerpt: "Total net sales reached $111,184 million",
        locations: ["p1s1"],
        period: "Q2 2026",
        derived: false,
      },
    ]);
    await auditStore.updateClaimRetrieval(claimId, { passagesRetrievedCount: 1, retrievalStatus: "ok" });
    await auditStore.updateClaimVerdict(claimId, {
      verdict: "supported",
      evidence: ["Total net sales $111,184"],
      sourceRefs: [randomUUID()],
      synthesized: false,
      confidence: 0.95,
      note: null,
    });
    await auditStore.updateAudit(auditId, { status: "complete", completedAt: new Date() });

    const response = await server.inject({ method: "GET", url: `/audit/${auditId}`, headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("complete");
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].verdict).toBe("supported");
    expect(body.scores).toBeDefined();
    expect(body.scores.counts.S).toBe(1);
    // scores never returned without its disclosure companions (contracts/audit-endpoint.md).
    expect(body.scores.eligible).toBeDefined();
    expect(body.scores.strict_supported_rate).toBeDefined();
  });
});
