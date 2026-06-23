import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAndRecordLlmCall } from "../../../src/observability/llm-call-recorder.js";
import { TimeoutError } from "../../../src/providers/types.js";
import type { ProviderResponse } from "../../../src/providers/types.js";
import type { LlmCallMetadata } from "../../../src/observability/llm-call-recorder.js";
import type { LlmCallStore } from "../../../src/persistence/ports.js";

const mockLlmCallStore: LlmCallStore = {
  recordCall: vi.fn(),
  getCallsBySession: vi.fn().mockResolvedValue([]),
  getCallsByStage: vi.fn().mockResolvedValue([]),
  getCallsByProvider: vi.fn().mockResolvedValue([]),
  getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
  updateParsedOutput: vi.fn().mockResolvedValue(undefined),
  updateFailure: vi.fn().mockResolvedValue(undefined),
  getCallsForMetrics: vi.fn().mockResolvedValue([]),
};

const mockMetadata: LlmCallMetadata = {
  sessionId: "session-123",
  stage: "assessment",
  callType: "primary",
  provider: "gemini",
  model: "gemini-2.5-flash",
  promptVersion: "v1.0.0",
};

describe("executeAndRecordLlmCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("success case", () => {
    it("should record successful call with raw response", async () => {
      const mockResult = { name: "test", value: 42 };
      const mockResponse: ProviderResponse<typeof mockResult> = {
        result: mockResult,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
      const providerCall = vi.fn().mockResolvedValue(mockResponse);
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-1" } as any);

      const { result, llmCallId } = await executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore);

      expect(result).toEqual(mockResult);
      expect(llmCallId).toBe("call-id-1");
      expect(providerCall).toHaveBeenCalledOnce();
      expect(mockLlmCallStore.recordCall).toHaveBeenCalledOnce();

      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.status).toBe("success");
      expect(recordedData.failureType).toBeNull();
      expect(recordedData.rawResponse).toBe(JSON.stringify(mockResult));
      expect(recordedData.sessionId).toBe("session-123");
      expect(recordedData.stage).toBe("assessment");
      expect(recordedData.callType).toBe("primary");
      expect(recordedData.provider).toBe("gemini");
      expect(recordedData.model).toBe("gemini-2.5-flash");
      expect(recordedData.promptVersion).toBe("v1.0.0");
    });

    it("should capture token usage from provider response", async () => {
      const mockResponse: ProviderResponse<{ data: string }> = {
        result: { data: "test" },
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      };
      const providerCall = vi.fn().mockResolvedValue(mockResponse);
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-2" } as any);

      await executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore);

      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.inputTokens).toBe(200);
      expect(recordedData.outputTokens).toBe(100);
      expect(recordedData.totalTokens).toBe(300);
    });

    it("should handle missing token usage", async () => {
      const mockResponse: ProviderResponse<{ data: string }> = {
        result: { data: "test" },
      };
      const providerCall = vi.fn().mockResolvedValue(mockResponse);
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-3" } as any);

      await executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore);

      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.inputTokens).toBeNull();
      expect(recordedData.outputTokens).toBeNull();
      expect(recordedData.totalTokens).toBeNull();
    });
  });

  describe("duration calculation", () => {
    it("should compute durationMs from timestamps", async () => {
      const mockResponse: ProviderResponse<{ data: string }> = {
        result: { data: "test" },
      };
      const providerCall = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockResponse), 50))
      );
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-4" } as any);

      await executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore);

      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.durationMs).toBeGreaterThanOrEqual(40);
      expect(recordedData.durationMs).toBeLessThan(200);
      expect(recordedData.startedAt).toBeDefined();
      expect(recordedData.endedAt).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should map TimeoutError to status=timeout, failureType=timeout", async () => {
      const providerCall = vi.fn().mockRejectedValue(new TimeoutError("Request timed out"));
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-5" } as any);

      await expect(executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore)).rejects.toThrow("Request timed out");

      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.status).toBe("timeout");
      expect(recordedData.failureType).toBe("timeout");
      expect(recordedData.errorMessage).toBe("Request timed out");
      expect(recordedData.rawResponse).toBeNull();
    });

    it("should map generic errors to status=error, failureType=provider_error", async () => {
      const providerCall = vi.fn().mockRejectedValue(new Error("Network failure"));
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-6" } as any);

      await expect(executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore)).rejects.toThrow("Network failure");

      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.status).toBe("error");
      expect(recordedData.failureType).toBe("provider_error");
      expect(recordedData.errorMessage).toBe("Network failure");
    });
  });

  describe("fire-and-forget recording", () => {
    it("should not propagate DB recording failures", async () => {
      const mockResponse: ProviderResponse<{ data: string }> = {
        result: { data: "test" },
      };
      const providerCall = vi.fn().mockResolvedValue(mockResponse);
      vi.mocked(mockLlmCallStore.recordCall).mockRejectedValue(new Error("DB connection failed"));

      const { result, llmCallId } = await executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore);

      expect(result).toEqual({ data: "test" });
      expect(llmCallId).toBeNull();
      expect(providerCall).toHaveBeenCalledOnce();
    });

    it("should still record on provider error (fire-and-forget)", async () => {
      const providerCall = vi.fn().mockRejectedValue(new Error("Provider down"));
      vi.mocked(mockLlmCallStore.recordCall).mockResolvedValue({ id: "call-id-7" } as any);

      await expect(executeAndRecordLlmCall(providerCall, mockMetadata, mockLlmCallStore)).rejects.toThrow("Provider down");

      expect(mockLlmCallStore.recordCall).toHaveBeenCalledOnce();
      const recordedData = vi.mocked(mockLlmCallStore.recordCall).mock.calls[0][0];
      expect(recordedData.status).toBe("error");
    });
  });
});
