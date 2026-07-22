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
 * T034 — every completed audit must have a fully populated `meta` versioning
 * surface (data-model.md's Audit entity). SC-004 claims "100% of runs," which
 * a single hand-checked example can't actually prove — this samples several
 * distinct audits, including one with an empty sources[] (the degenerate but
 * permitted "sources are silent" case, D018 §2.3) to catch a field that's
 * only populated on the happy path.
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

describe("GET /audit/:audit_id — meta versioning surface has zero nulls across multiple runs (T034)", () => {
  let server: FastifyInstance;
  let provider: MockProvider;

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
    const auditStore = new MockAuditStore();
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

  const requestBodies = [
    {
      domain: "finance" as const,
      output_text: "Apple's total net sales reached $111,184 million.",
      sources: [{ id: "doc1", name: "10-Q", text: "Total net sales $111,184 million." }],
      options: { threshold: 0.6, maxClaims: 50 },
    },
    {
      domain: "finance" as const,
      output_text: "Apple's total net sales reached $111,184 million, alongside strong iPhone demand.",
      sources: [{ id: "doc2", name: "10-Q v2", text: "Total net sales $111,184 million." }],
      options: { threshold: 0.6, maxClaims: 50 },
    },
    {
      // Degenerate but permitted case: empty sources[] ("sources are silent," D018 §2.3).
      domain: "finance" as const,
      output_text: "Apple's total net sales reached $111,184 million, per no submitted source.",
      sources: [],
      options: { threshold: 0.6, maxClaims: 50 },
    },
  ];

  it("every field in meta is non-null across a batch of distinct completed audits", async () => {
    for (const body of requestBodies) {
      const post = await server.inject({ method: "POST", url: "/audit", headers: AUTH, payload: body });
      expect(post.statusCode).toBe(202);
      const auditId = JSON.parse(post.body).audit_id;

      const get = await server.inject({ method: "GET", url: `/audit/${auditId}`, headers: AUTH });
      const result = JSON.parse(get.body);
      expect(result.status).toBe("complete");

      const meta = result.meta;
      for (const [key, value] of Object.entries(meta)) {
        if (typeof value === "object" && value !== null) {
          for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
            expect(innerValue, `meta.${key}.${innerKey} for output_text=${JSON.stringify(body.output_text)}`).not.toBeNull();
            expect(innerValue).not.toBe("");
          }
        } else {
          expect(value, `meta.${key} for output_text=${JSON.stringify(body.output_text)}`).not.toBeNull();
          expect(value).not.toBe("");
        }
      }
    }
  });
});
