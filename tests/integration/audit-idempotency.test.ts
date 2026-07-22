import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
 * T031 — submitting identical input twice must produce two distinct,
 * linked audits: different audit_id (a fresh run each time — no silent
 * dedup that would hide a real re-run from the caller), same input_ref
 * (data-model.md's Audit entity — a deterministic hash of the normalized
 * { output_text, sources[], task } triple, computed with no timestamp/nonce).
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

const REQUEST_BODY = {
  domain: "finance" as const,
  output_text: "Apple's total net sales reached $111,184 million.",
  sources: [{ id: "doc1", name: "10-Q", text: "Total net sales $111,184 million." }],
  options: { threshold: 0.6, maxClaims: 50 },
};

describe("POST /audit — idempotency (T031)", () => {
  let server: FastifyInstance;
  let provider: MockProvider;
  let auditStore: MockAuditStore;

  beforeAll(async () => {
    provider = new MockProvider();
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
    provider.setResponseFn("You are a verification engine", (request) => {
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

    const prompts = new PromptRegistry();
    auditStore = new MockAuditStore();
    const extractService = new ExtractService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
    const verifyService = new VerifyService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
    const gateService = new GateService(auditStore);
    const auditService = new AuditService(extractService, verifyService, gateService, auditStore, "test-version");

    const enqueuer: AuditEnqueuer = {
      async enqueue(data) {
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

  it("submitting identical input twice yields two distinct audit_ids sharing the same input_ref", async () => {
    const first = await server.inject({ method: "POST", url: "/audit", headers: AUTH, payload: REQUEST_BODY });
    const second = await server.inject({ method: "POST", url: "/audit", headers: AUTH, payload: REQUEST_BODY });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const firstId = JSON.parse(first.body).audit_id;
    const secondId = JSON.parse(second.body).audit_id;
    expect(firstId).not.toBe(secondId);

    const firstGet = await server.inject({ method: "GET", url: `/audit/${firstId}`, headers: AUTH });
    const secondGet = await server.inject({ method: "GET", url: `/audit/${secondId}`, headers: AUTH });
    const firstBody = JSON.parse(firstGet.body);
    const secondBody = JSON.parse(secondGet.body);

    expect(firstBody.status).toBe("complete");
    expect(secondBody.status).toBe("complete");
    expect(firstBody.input_ref).toBe(secondBody.input_ref);
    expect(firstBody.input_ref).toBeTruthy();
  });

  it("each run gets its own fresh claim_ids — not reused across audits sharing the same input_ref", async () => {
    const first = await server.inject({ method: "POST", url: "/audit", headers: AUTH, payload: REQUEST_BODY });
    const second = await server.inject({ method: "POST", url: "/audit", headers: AUTH, payload: REQUEST_BODY });
    const firstId = JSON.parse(first.body).audit_id;
    const secondId = JSON.parse(second.body).audit_id;

    const firstGet = await server.inject({ method: "GET", url: `/audit/${firstId}`, headers: AUTH });
    const secondGet = await server.inject({ method: "GET", url: `/audit/${secondId}`, headers: AUTH });
    const firstClaimIds = JSON.parse(firstGet.body).claims.map((c: { claim_id: string }) => c.claim_id);
    const secondClaimIds = JSON.parse(secondGet.body).claims.map((c: { claim_id: string }) => c.claim_id);

    expect(firstClaimIds).toHaveLength(1);
    expect(secondClaimIds).toHaveLength(1);
    expect(firstClaimIds[0]).not.toBe(secondClaimIds[0]);
  });

  it("a request with different content produces a different input_ref", async () => {
    const first = await server.inject({ method: "POST", url: "/audit", headers: AUTH, payload: REQUEST_BODY });
    // Keeps the same excerpt (so EXTRACT's verbatim-substring check still
    // passes and this audit reaches status="complete" like the others) while
    // changing the overall output_text content, so input_ref must differ.
    const different = await server.inject({
      method: "POST",
      url: "/audit",
      headers: AUTH,
      payload: {
        ...REQUEST_BODY,
        output_text: "Apple's total net sales reached $111,184 million, alongside strong iPhone demand.",
      },
    });
    const firstId = JSON.parse(first.body).audit_id;
    const differentId = JSON.parse(different.body).audit_id;

    const firstGet = await server.inject({ method: "GET", url: `/audit/${firstId}`, headers: AUTH });
    const differentGet = await server.inject({ method: "GET", url: `/audit/${differentId}`, headers: AUTH });
    const firstBody = JSON.parse(firstGet.body);
    const differentBody = JSON.parse(differentGet.body);

    expect(firstBody.status).toBe("complete");
    expect(differentBody.status).toBe("complete");
    expect(firstBody.input_ref).not.toBe(differentBody.input_ref);
  });
});
