import { logger } from "../observability/logger";

export interface BiasResult {
  id: string;
  name: string;
  retrieval_score: number;
  definition: string;
  examples: string;
  indicators: string;
  false_positives: string;
  related_biases: string;
}

export interface EngineResponse {
  biases: BiasResult[];
  retrieved_chunks: number;
  taxonomy_version: string;
  embedding_model: string;
  request_id: string;
}

export type RagClientResult =
  | { status: "ok"; data: EngineResponse }
  | { status: "unavailable" }
  | { status: "auth_error" };

export function isEngineResponse(v: unknown): v is EngineResponse {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return Array.isArray(obj["biases"]) && typeof obj["request_id"] === "string";
}

export class RagEngineClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async retrieve(story: string): Promise<RagClientResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}/retrieve-biases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ story }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        logger.warn({ status: response.status }, "rag_auth_error");
        return { status: "auth_error" };
      }

      if (!response.ok) {
        logger.info({ status: response.status }, "rag_fallback");
        return { status: "unavailable" };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          logger.info({ err, isTimeout: true }, "rag_fallback");
        } else {
          logger.warn({ err }, "rag_invalid_response");
        }
        return { status: "unavailable" };
      }

      if (!isEngineResponse(body)) {
        logger.warn({ body }, "rag_invalid_response");
        return { status: "unavailable" };
      }

      return { status: "ok", data: body };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      logger.info({ err, isTimeout }, "rag_fallback");
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
