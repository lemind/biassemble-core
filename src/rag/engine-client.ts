import { logger } from "../observability/logger";

export type EngineSource = "vector" | "llm";

export interface BiasResult {
  id: string;
  name: string;
  retrieval_score: number;
  indicators: string;
  /**
   * Which engine signal(s) surfaced this bias — normalized to an array (D017 Decision 1).
   * `null` when the engine doesn't produce it for the active retrieval configuration.
   */
  source?: EngineSource[] | null;
  // Descriptive text the engine sends but nothing downstream reads back after persistence
  // (only workspace-builder.ts consumes a stored BiasResult, and it only uses the fields
  // above). Optional so `toStorableEngineResponse` can omit them before storage — see there
  // for why. Still present on the live response from `retrieve()`.
  definition?: string;
  examples?: string;
  false_positives?: string;
  related_biases?: string;
}

export interface EngineResponse {
  biases: BiasResult[];
  retrieved_chunks: number;
  taxonomy_version: string;
  embedding_model: string;
  request_id: string;
  // Additive top-level metadata — present only under the llm_union retrieval configuration.
  selection_strategy?: string;
  llm_model?: string;
  llm_latency_ms?: number;
  truncated_story?: boolean;
  llm_scores?: Record<string, number>;
  vector_scores?: Record<string, number>;
}

/**
 * Projects an EngineResponse down to what's actually consumed after persistence —
 * `workspace-builder.ts` (the only reader of a stored response) only ever uses
 * `id`/`name`/`retrieval_score`/`indicators`/`source` per bias, plus the top-level
 * metadata. `definition`/`examples`/`false_positives`/`related_biases` are multi-paragraph
 * engine text that made up the bulk of a stored row's size for zero downstream benefit —
 * drop them before writing to `runs.rag_result`. Does not mutate the input; used at the
 * storage boundary only, never on the live response returned from `retrieve()`.
 */
export function toStorableEngineResponse(response: EngineResponse): EngineResponse {
  return {
    ...response,
    biases: response.biases.map((b) => ({
      id: b.id,
      name: b.name,
      retrieval_score: b.retrieval_score,
      indicators: b.indicators,
      source: b.source,
    })),
  };
}

const KNOWN_SOURCES = new Set<EngineSource>(["vector", "llm"]);

/**
 * Normalize the engine's per-bias `source` into a deduped array of known signals.
 * Accepts the canonical array form and tolerates a legacy scalar (`"both"`/`"vector"`/`"llm"`).
 * Unknown values are dropped; absent/null/empty/all-unknown → `null` (triggers the downstream
 * `retrieval_score` fallback in workspace-builder). "both" is only ever a legacy scalar
 * spelling that gets expanded — it never survives as a value past this function.
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
          source: normalizeSource(b.source),
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
