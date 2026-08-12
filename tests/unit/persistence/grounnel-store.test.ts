import { describe, it, expect } from "vitest";
import { RedisGrounnelStore } from "../../../src/persistence/grounnel-store.js";
import { FakeRedisHashClient } from "../../mocks/fake-redis-hash-client.js";

function makeStore() {
  return new RedisGrounnelStore(new FakeRedisHashClient());
}

describe("RedisGrounnelStore (T007)", () => {
  it("creates an audit and returns it via getStatus with every claim pending", async () => {
    const store = makeStore();
    const { id } = await store.createAudit({
      text: "some pasted article",
      maxClaims: 100,
      claims: [
        { id: "11111111-1111-4111-8111-111111111111", text: "Claim A" },
        { id: "22222222-2222-4222-8222-222222222222", text: "Claim B" },
      ],
      truncated: false,
    });

    const status = await store.getStatus(id);
    expect(status).not.toBeNull();
    expect(status!.progress).toEqual({ checked: 0, total: 2 });
    expect(status!.status).toBe("extracting");
    expect(status!.claims).toHaveLength(2);
    expect(status!.claims.every((c) => c.status === "pending" && c.verdict === null)).toBe(true);
    expect(status!.caps_hit).toBe(false);
  });

  it("returns null for an audit id that was never created", async () => {
    const store = makeStore();
    expect(await store.getStatus("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("writeClaimResult updates a single claim and preserves its id/text", async () => {
    const store = makeStore();
    const claimId = "11111111-1111-4111-8111-111111111111";
    const { id } = await store.createAudit({
      text: "article",
      maxClaims: 100,
      claims: [{ id: claimId, text: "Bukowski attended Los Angeles City College." }],
      truncated: false,
    });

    await store.writeClaimResult(id, claimId, {
      status: "done",
      verdict: "supported",
      evidence: "attended Los Angeles City College",
      confidence: 0.9,
      reason: "Wikipedia confirms this.",
      sources: [],
    });

    const status = await store.getStatus(id);
    const claim = status!.claims[0]!;
    expect(claim.id).toBe(claimId);
    expect(claim.text).toBe("Bukowski attended Los Angeles City College.");
    expect(claim.verdict).toBe("supported");
    expect(claim.confidence).toBe(0.9);
  });

  it("throws when writing a result for a claim that was never created on this audit", async () => {
    const store = makeStore();
    const { id } = await store.createAudit({ text: "article", maxClaims: 100, claims: [], truncated: false });
    await expect(
      store.writeClaimResult(id, "nonexistent-claim-id", {
        status: "done",
        verdict: "supported",
        evidence: "x",
        confidence: 1,
        reason: "y",
        sources: [],
      })
    ).rejects.toThrow();
  });

  it("concurrent writeClaimResult calls for different claims on the same audit both land (T007's core acceptance)", async () => {
    const store = makeStore();
    const claimA = "11111111-1111-4111-8111-111111111111";
    const claimB = "22222222-2222-4222-8222-222222222222";
    const { id } = await store.createAudit({
      text: "article",
      maxClaims: 100,
      claims: [
        { id: claimA, text: "Claim A" },
        { id: claimB, text: "Claim B" },
      ],
      truncated: false,
    });

    await Promise.all([
      store.writeClaimResult(id, claimA, {
        status: "done",
        verdict: "supported",
        evidence: "evidence A",
        confidence: 0.8,
        reason: "reason A",
        sources: [],
      }),
      store.writeClaimResult(id, claimB, {
        status: "done",
        verdict: "contradicted",
        evidence: "evidence B",
        confidence: 0.7,
        reason: "reason B",
        sources: [],
      }),
    ]);

    const status = await store.getStatus(id);
    const a = status!.claims.find((c) => c.id === claimA)!;
    const b = status!.claims.find((c) => c.id === claimB)!;
    expect(a.verdict).toBe("supported");
    expect(b.verdict).toBe("contradicted");
    expect(status!.progress.checked).toBe(2);
    expect(status!.status).toBe("done");
  });

  it("computes progress/score entirely from claim state; status also gates on meta.escalating (D026 §14) once that exists", async () => {
    const store = makeStore();
    const claimA = "11111111-1111-4111-8111-111111111111";
    const claimB = "22222222-2222-4222-8222-222222222222";
    const { id } = await store.createAudit({
      text: "article",
      maxClaims: 100,
      claims: [
        { id: claimA, text: "Claim A" },
        { id: claimB, text: "Claim B" },
      ],
      truncated: false,
    });

    let status = await store.getStatus(id);
    expect(status!.status).toBe("extracting");

    await store.writeClaimResult(id, claimA, {
      status: "done",
      verdict: "supported",
      evidence: "e",
      confidence: 1,
      reason: "r",
      sources: [],
    });
    status = await store.getStatus(id);
    expect(status!.status).toBe("verifying");
    expect(status!.score.grounded_n).toBe(1);
    expect(status!.score.eligible).toBe(1);
    expect(status!.score.grounded_pct).toBe(100);

    await store.writeClaimResult(id, claimB, {
      status: "failed",
      verdict: null,
      evidence: null,
      confidence: null,
      reason: null,
      sources: [],
    });
    status = await store.getStatus(id);
    expect(status!.status).toBe("done");
    expect(status!.score.not_checked_n).toBe(1);
    expect(status!.score.eligible).toBe(2);
    expect(status!.score.grounded_pct).toBe(50);
  });

  it("sets caps_hit when the caller reports truncation", async () => {
    const store = makeStore();
    const { id } = await store.createAudit({
      text: "article",
      maxClaims: 1,
      claims: [{ id: "11111111-1111-4111-8111-111111111111", text: "Only claim" }],
      truncated: true,
    });
    const status = await store.getStatus(id);
    expect(status!.caps_hit).toBe(true);
  });

  it("does NOT set caps_hit when the claim count merely equals maxClaims but nothing was truncated", async () => {
    const store = makeStore();
    const { id } = await store.createAudit({
      text: "article",
      maxClaims: 1,
      claims: [{ id: "11111111-1111-4111-8111-111111111111", text: "Only claim" }],
      truncated: false,
    });
    const status = await store.getStatus(id);
    expect(status!.caps_hit).toBe(false);
  });

  it("D026 §14: stays 'verifying', not 'done', while escalating is true — even once every claim is non-pending (the real bug: a client polling for 'done' must not read pre-escalation results)", async () => {
    const store = makeStore();
    const claimId = "11111111-1111-4111-8111-111111111111";
    const { id } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: "Claim A" }], truncated: false });

    await store.writeClaimResult(id, claimId, { status: "done", verdict: "unsupported", evidence: null, confidence: null, reason: "no evidence found", sources: [] });
    let status = await store.getStatus(id);
    expect(status!.status).toBe("done"); // pre-fix behavior, confirmed still correct when nothing is escalating

    await store.setEscalating(id, true);
    status = await store.getStatus(id);
    expect(status!.status).toBe("verifying"); // every claim is "done", but the run itself isn't

    await store.setEscalating(id, false);
    status = await store.getStatus(id);
    expect(status!.status).toBe("done"); // flips back once escalation genuinely finishes
  });

  it("D026 §14: setEscalating on a missing/expired audit is a silent no-op, matching getStatus's own null-on-missing convention", async () => {
    const store = makeStore();
    await expect(store.setEscalating("00000000-0000-0000-0000-000000000000", true)).resolves.toBeUndefined();
  });

  it("D027 FR-007: a claim row written before `citations` existed (no key at all) still parses via getStatus, defaulting to []", async () => {
    const redis = new FakeRedisHashClient();
    const store = new RedisGrounnelStore(redis);
    const claimId = "11111111-1111-4111-8111-111111111111";
    const auditId = "22222222-2222-4222-8222-222222222222";
    // Hand-written, pre-D027-shape claim row — no `citations` key, written directly to the fake
    // Redis backing store, bypassing createAudit/writeClaimResult (which always write it now) to
    // simulate a real audit persisted before this field existed.
    await redis.hset(`audit:${auditId}`, {
      meta: JSON.stringify({ total: 1, truncated: false, createdAt: new Date().toISOString(), escalating: false }),
      [`claim:${claimId}`]: JSON.stringify({
        id: claimId,
        text: "Pre-existing claim",
        status: "done",
        verdict: "supported",
        evidence: "some evidence",
        confidence: 0.9,
        reason: "some reason",
        sources: [],
      }),
    });

    const status = await store.getStatus(auditId);
    expect(status).not.toBeNull();
    expect(status!.claims[0]!.citations).toEqual([]);
  });

  // Reviewed finding (D027, code review): the new citations/evidence refine() is enforced at
  // read time (ClaimSchema.parse in getStatus), never at write time — a future write bug could
  // silently store a row that fails it. Before this fix, ANY one malformed claim row would throw
  // uncaught out of getStatus's loop, 500-ing the whole audit's status for every other, healthy
  // claim too — a strictly worse blast radius than the pre-D027 silent-wrong-data behavior.
  it("D027: one malformed claim row degrades to status:failed instead of crashing the whole audit's status response", async () => {
    const redis = new FakeRedisHashClient();
    const store = new RedisGrounnelStore(redis);
    const healthyId = "11111111-1111-4111-8111-111111111111";
    const brokenId = "33333333-3333-4333-8333-333333333333";
    const auditId = "22222222-2222-4222-8222-222222222222";

    await redis.hset(`audit:${auditId}`, {
      meta: JSON.stringify({ total: 2, truncated: false, createdAt: new Date().toISOString(), escalating: false }),
      [`claim:${healthyId}`]: JSON.stringify({
        id: healthyId,
        text: "A healthy claim",
        status: "done",
        verdict: "supported",
        evidence: "real evidence",
        confidence: 0.9,
        reason: "real reason",
        sources: [],
        citations: [],
      }),
      // Hand-crafted violation of the citations/evidence invariant — evidence null but citations
      // non-empty. Should never happen via any real writer in this codebase (all tested), but
      // simulates the "future write bug" scenario the fix is a backstop for.
      [`claim:${brokenId}`]: JSON.stringify({
        id: brokenId,
        text: "A broken claim",
        status: "done",
        verdict: "unsupported",
        evidence: null,
        confidence: null,
        reason: null,
        sources: [],
        citations: [{ source: "A", sentence: 1, url: "https://example.com", text: "orphaned citation" }],
      }),
    });

    const status = await store.getStatus(auditId);
    expect(status).not.toBeNull();
    expect(status!.claims).toHaveLength(2);

    const healthy = status!.claims.find((c) => c.id === healthyId)!;
    expect(healthy.verdict).toBe("supported");

    const broken = status!.claims.find((c) => c.id === brokenId)!;
    expect(broken.status).toBe("failed");
    expect(broken.citations).toEqual([]);
  });
});
