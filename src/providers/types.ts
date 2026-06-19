import type { ZodSchema } from "zod";

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CompletionRequest {
  system: string;
  user: string;
  responseSchema?: ZodSchema;
  options?: CompletionOptions;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderResponse<T> {
  result: T;
  usage?: TokenUsage;
}

export interface Provider {
  readonly mode: string;
  completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>>;
}
