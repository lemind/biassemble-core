import { describe, it, expect } from "vitest";
import { z } from "zod";
import { callLlmForJson, type LlmCallCompletionInfo } from "../../../src/orchestrators/llm-json-call.js";
import { MockProvider } from "../../mocks/mock-provider.js";
import { RateLimitError } from "../../../src/providers/gemini.js";
import type { Provider } from "../../../src/providers/types.js";

const Schema = z.object({ value: z.string() });

describe("callLlmForJson's onComplete (D023 §4/T025) — additive, no behavior change when omitted", () => {
  it("does not call onComplete when it isn't passed, and behaves exactly as before", async () => {
    const provider = new MockProvider();
    provider.setDefault({ value: "hello" });
    const result = await callLlmForJson({
      provider,
      system: "test",
      user: "go",
      schema: Schema,
      expectedKeys: ["value"],
      attempts: 1,
      module: "test",
      operation: "test-op",
    });
    expect(result).toEqual({ value: "hello" });
  });

  it("calls onComplete once with status 'success' on a clean first-attempt call", async () => {
    const provider = new MockProvider();
    provider.setDefault({ value: "hello" });
    const calls: LlmCallCompletionInfo[] = [];
    await callLlmForJson({
      provider,
      system: "test",
      user: "go",
      schema: Schema,
      expectedKeys: ["value"],
      attempts: 3,
      module: "test",
      operation: "test-op",
      onComplete: (info) => calls.push(info),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "success", failureType: null, errorMessage: null });
    expect(calls[0]!.raw).toEqual({ value: "hello" });
    expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls onComplete once per attempt — a failed attempt then a successful one produces two calls", async () => {
    const provider = new MockProvider();
    provider.failOn(1, "transient failure");
    provider.setDefault({ value: "hello" });
    const calls: LlmCallCompletionInfo[] = [];
    await callLlmForJson({
      provider,
      system: "test",
      user: "go",
      schema: Schema,
      expectedKeys: ["value"],
      attempts: 3,
      module: "test",
      operation: "test-op",
      onComplete: (info) => calls.push(info),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ status: "error", failureType: "provider_error" });
    expect(calls[0]!.errorMessage).toContain("transient failure");
    expect(calls[1]).toMatchObject({ status: "success" });
  });

  it("calls onComplete with status 'error'/failureType 'parse_error' for every attempt when retries are exhausted", async () => {
    const provider = new MockProvider();
    provider.setDefault("not an object at all");
    const calls: LlmCallCompletionInfo[] = [];
    await expect(
      callLlmForJson({
        provider,
        system: "test",
        user: "go",
        schema: Schema,
        expectedKeys: ["value"],
        attempts: 2,
        module: "test",
        operation: "test-op",
        onComplete: (info) => calls.push(info),
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ status: "error" });
  });

  it("reviewed finding: calls onComplete before rethrowing a RateLimitError, not skipping it entirely", async () => {
    const rateLimitedProvider: Provider = {
      mode: "mock",
      completeJson: async () => {
        throw new RateLimitError("quota exceeded", "daily");
      },
    };
    const calls: LlmCallCompletionInfo[] = [];
    await expect(
      callLlmForJson({
        provider: rateLimitedProvider,
        system: "test",
        user: "go",
        schema: Schema,
        expectedKeys: ["value"],
        attempts: 3,
        module: "test",
        operation: "test-op",
        onComplete: (info) => calls.push(info),
      })
    ).rejects.toThrow(RateLimitError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "error", failureType: "provider_error" });
  });

  it("reviewed finding: tags an isValid() rejection as failureType 'schema_validation', distinct from a genuine parse failure ('parse_error')", async () => {
    const provider = new MockProvider();
    provider.setDefault({ value: "hello" }); // parses fine, but isValid below rejects it
    const calls: LlmCallCompletionInfo[] = [];
    await expect(
      callLlmForJson({
        provider,
        system: "test",
        user: "go",
        schema: Schema,
        expectedKeys: ["value"],
        attempts: 2,
        module: "test",
        operation: "test-op",
        isValid: () => false,
        onComplete: (info) => calls.push(info),
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ status: "error", failureType: "schema_validation" });
  });
});
