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
    const { id } = await store.createAudit({ text: "article", maxClaims: 100, claims: [] });
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

  it("computes status/progress/score entirely from claim state, never from a separately stored flag", async () => {
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

  it("sets caps_hit when the extracted claim count reached maxClaims", async () => {
    const store = makeStore();
    const { id } = await store.createAudit({
      text: "article",
      maxClaims: 1,
      claims: [{ id: "11111111-1111-4111-8111-111111111111", text: "Only claim" }],
    });
    const status = await store.getStatus(id);
    expect(status!.caps_hit).toBe(true);
  });
});
