import { logger } from "../observability/logger";

export type EngineSource = "vector" | "llm";

export interface BiasResult {
  id: string;
  name: string;
  retrieval_score: number;
  definition: string;
  examples: string;
  indicators: string;
  false_positives: string;
  related_biases: string;
  /**
   * Which engine signal(s) surfaced this bias — normalized to an array (ADR D015 Decision 1).
   * `null` on `vector_only`/`nli_union` responses (additive; contract v3). See `normalizeSource`.
   */
  source?: EngineSource[] | null;
}

export interface EngineResponse {
  biases: BiasResult[];
  retrieved_chunks: number;
  taxonomy_version: string;
  embedding_model: string;
  request_id: string;
  // Additive top-level metadata — present only under SELECTION_STRATEGY=llm_union (contract v3).
  selection_strategy?: string;
  llm_model?: string;
  llm_latency_ms?: number;
  truncated_story?: boolean;
  llm_scores?: Record<string, number>;
  vector_scores?: Record<string, number>;
}

const KNOWN_SOURCES = new Set<EngineSource>(["vector", "llm"]);

/**
 * Normalize the engine's per-bias `source` into a deduped array of known signals.
 * Accepts the canonical array form and tolerates the legacy scalar (`"both"`/`"vector"`/`"llm"`)
 * the engine's v3 contract text still documents (ADR D015 / research R1). Unknown values are
 * dropped; absent/null/empty/all-unknown → `null` (which triggers the downstream
 * `retrieval_score` fallback in context-builder).
 */
export function normalizeSource(raw: unknown): EngineSource[] | null {
  if (raw == null) return null;

  let values: unknown[];
  if (typeof raw === "string") {
    values = raw === "both" ? ["vector", "llm"] : [raw];
  } else if (Array.isArray(raw)) {
    values = raw;
  } else {
    return null;
  }

  const known = values.filter(
    (v): v is EngineSource => typeof v === "string" && KNOWN_SOURCES.has(v as EngineSource),
  );
  const deduped = Array.from(new Set(known));
  return deduped.length > 0 ? deduped : null;
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
    private readonly hfToken?: string,
  ) {}

  async retrieve(story: string): Promise<RagClientResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-RAG-Key": this.apiKey,
      };
      if (this.hfToken) {
        headers["Authorization"] = `Bearer ${this.hfToken}`;
      }

      const response = await fetch(`${this.url}/retrieve-biases`, {
        method: "POST",
        headers,
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

      // Normalize each bias's `source` (array | legacy scalar | absent) into a canonical
      // EngineSource[] | null. Top-level llm_* metadata passes through additively.
      const normalized: EngineResponse = {
        ...body,
        biases: body.biases.map((b) => ({
          ...b,
          source: normalizeSource((b as { source?: unknown }).source),
        })),
      };

      return { status: "ok", data: normalized };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      logger.info({ err, isTimeout }, "rag_fallback");
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
