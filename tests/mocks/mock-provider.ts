import type { Provider, CompletionRequest, ProviderResponse } from "../../src/providers/types.js";
import { logger } from "../../src/observability/logger.js";

const MODULE = "mock-provider";

/**
 * Mock provider for unit/integration tests.
 * Returns pre-configured JSON responses instead of calling a real AI provider.
 */
export class MockProvider implements Provider {
  readonly mode = "mock";

  private responseMap: Map<string, unknown> = new Map();
  private defaultResponse: unknown | null = null;
  private callCount = 0;
  private failOnAttempt: number | null = null;
  private failMessage: string | null = null;
  private failEvery: boolean = false;

  /**
   * Register a response for a specific system prompt prefix.
   */
  setResponse(systemPrefix: string, response: unknown): void {
    this.responseMap.set(systemPrefix, response);
  }

  /**
   * Set a default response when no prefix matches.
   */
  setDefault(response: unknown): void {
    this.defaultResponse = response;
  }

  /**
   * Make the N-th call fail with an error (1-indexed).
   */
  failOn(n: number, message: string): void {
    this.failOnAttempt = n;
    this.failMessage = message;
    this.failEvery = false;
  }

  /**
   * Make every call fail with the given message (for retry exhaustion tests).
   */
  failAll(message: string): void {
    this.failEvery = true;
    this.failMessage = message;
    this.failOnAttempt = null;
  }

  getCallCount(): number {
    return this.callCount;
  }

  async completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>> {
    this.callCount++;

    // Simulate failure for retry tests
    if (this.failEvery) {
      logger.info(
        { module: MODULE, callCount: this.callCount },
        "Mock provider failing (failAll)"
      );
      throw new Error(this.failMessage ?? "Mock provider failure");
    }

    if (this.failOnAttempt !== null && this.callCount === this.failOnAttempt) {
      logger.info(
        { module: MODULE, callCount: this.callCount },
        "Mock provider failing on request"
      );
      throw new Error(this.failMessage ?? "Mock provider failure");
    }

    // Find a matching response by system prefix
    for (const [prefix, response] of this.responseMap) {
      if (request.system.includes(prefix)) {
        return { result: response as T };
      }
    }

    if (this.defaultResponse !== null) {
      return { result: this.defaultResponse as T };
    }

    throw new Error("Mock provider has no response configured");
  }

  reset(): void {
    this.responseMap.clear();
    this.defaultResponse = null;
    this.callCount = 0;
    this.failOnAttempt = null;
    this.failMessage = null;
    this.failEvery = false;
  }
}
