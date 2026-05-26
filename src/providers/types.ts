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

export interface Provider {
  readonly mode: string;
  completeJson<T>(request: CompletionRequest): Promise<T>;
}
