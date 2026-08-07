import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsertLlmCall = vi.fn();

vi.mock("../../../src/db/queries.js", () => ({
  insertGrounnelLlmCall: (...args: unknown[]) => mockInsertLlmCall(...args),
}));

const { DrizzleGrounnelLlmCallStore } = await import("../../../src/persistence/grounnel-llm-call-store.js");

describe("DrizzleGrounnelLlmCallStore (T025) — D023 §4, best-effort, never throws", () => {
  beforeEach(() => {
    mockInsertLlmCall.mockReset();
  });

  it("recordCall returns a closure that inserts a row combining the call context with the completion info", async () => {
    mockInsertLlmCall.mockResolvedValue({ id: "llm1" });
    const store = new DrizzleGrounnelLlmCallStore();
    const onComplete = store.recordCall({
      runId: "r1",
      stage: "extract",
      callType: "primary",
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      promptVersion: "1.0.0",
    });

    const startedAt = new Date("2026-01-01T00:00:00Z");
    const endedAt = new Date("2026-01-01T00:00:01Z");
    onComplete({
      raw: { foo: "bar" },
      startedAt,
      endedAt,
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      status: "success",
      failureType: null,
      errorMessage: null,
    });

    // onComplete fires the insert without awaiting (matches the fire-and-forget contract callers rely on) — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInsertLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "r1",
        stage: "extract",
        callType: "primary",
        provider: "gemini",
        model: "gemini-2.5-flash-lite",
        promptVersion: "1.0.0",
        rawResponse: JSON.stringify({ foo: "bar" }),
        status: "success",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        durationMs: 1000,
      })
    );
  });

  it("does not throw when the DB insert fails", async () => {
    mockInsertLlmCall.mockRejectedValue(new Error("connection refused"));
    const store = new DrizzleGrounnelLlmCallStore();
    const onComplete = store.recordCall({
      runId: "r1",
      stage: "verify",
      callType: "primary",
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      promptVersion: "2.0.0",
    });

    expect(() =>
      onComplete({
        raw: null,
        startedAt: new Date(),
        endedAt: new Date(),
        durationMs: 5,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        status: "error",
        failureType: "provider_error",
        errorMessage: "boom",
      })
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("sets rawResponse to null when raw is null (e.g. a failed attempt before any response was parsed)", async () => {
    mockInsertLlmCall.mockResolvedValue({ id: "llm2" });
    const store = new DrizzleGrounnelLlmCallStore();
    const onComplete = store.recordCall({
      runId: "r1",
      stage: "extract",
      callType: "primary",
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      promptVersion: "1.0.0",
    });
    onComplete({
      raw: null,
      startedAt: new Date(),
      endedAt: new Date(),
      durationMs: 5,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      status: "error",
      failureType: "provider_error",
      errorMessage: "network error",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockInsertLlmCall).toHaveBeenCalledWith(expect.objectContaining({ rawResponse: null }));
  });
});
