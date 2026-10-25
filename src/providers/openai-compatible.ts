/** DeepSeek schema calls use the Responses API. Qwen stays on chat json_schema, then json_object, plus one citation repair (D033 §3, §6). */
import { z, type ZodType } from "zod";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";
import { scrubErrorMessage } from "../persistence/error-scrub.js";
import { PREFLIGHT_PROMPT, PREFLIGHT_TIMEOUT_MS } from "./preflight.js";
import {
  ProviderError,
  TimeoutError,
  type CompletionRequest,
  type Provider,
  type ProviderErrorCategory,
  type ProviderResponse,
  type TokenUsage,
} from "./types.js";

const MODULE = "openai-compatible";

/** DeepSeek cuts a JSON object off when max_tokens is omitted (D033 §6). */
export const DEEPSEEK_MAX_TOKENS = 8192;

export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";

/** Chat json_schema is rejected here. This endpoint enforces the citation schema (D033 §6). */
export const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";

/** Balance probe. Amounts in the body are not stored or logged (D033 §3). */
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const JSON_REQUEST_SUFFIX = 'Reply with a JSON object. Example: {"result":"ok"}';

/** OpenAI-compatible structured-output name. strict stays false: VERIFY citations are nullable (D027). */
const JSON_SCHEMA_NAME = "grounnel_response";

/** Parsed key is evidenceCitations; the shared VERIFY prompt still says evidence_citations (D027). */
const CITATION_RULE =
  "A supported / partially_supported / contradicted verdict MUST include non-empty evidenceCitations as [{source,n}] drawn only from the given passages; if you cannot cite a given sentence, the verdict is unsupported with evidenceCitations null.";

const CATEGORY_MESSAGE: Record<ProviderErrorCategory, string> = {
  invalid_key: "The API key was rejected.",
  no_balance: "The account has no balance for this model.",
  rate_limited: "The provider rate limit stopped this check.",
  unavailable: "The provider is unavailable.",
  model_access_denied: "This account cannot use that model.",
};

export interface OpenAICompatibleConfig {
  provider: "deepseek" | "qwen";
  model: string;
  apiKey: string;
  /** Full chat-completions URL, including the Qwen workspace host. */
  baseUrl: string;
}

interface ProviderErrorBody {
  code?: unknown;
  message?: unknown;
}

export function qwenChatCompletionsUrl(workspaceId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId)) {
    throw new Error("Qwen workspace id is not a host label");
  }
  return `https://${workspaceId.toLowerCase()}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
}

/** DeepSeek follows the HTTP status. Qwen does not: a 429 and a 403 depend on the error code (D033 §3). */
export function classifyCompatibleError(
  provider: "deepseek" | "qwen",
  status: number,
  code: string,
  message: string,
): ProviderErrorCategory | null {
  if (provider === "deepseek") {
    if (status === 401) return "invalid_key";
    if (status === 402) return "no_balance";
    if (status === 429) return "rate_limited";
    if (status === 500 || status === 503) return "unavailable";
    return null;
  }
  const blob = `${code} ${message}`.toLowerCase();
  // Balance: arrears, exhausted/insufficient quota, AllocationQuota, or a free tier that ran out (D033 §3).
  const outOfBalance = /arrears|insufficient|exhausted|allocationquota|overdue|free quota|add funds/.test(blob);
  // A 403 is an unpurchased/unauthorized model, UNLESS the body says the balance or quota ran out — the
  // free tier returns 403 insufficient_quota, which is no_balance, not model_access_denied (D033 §3).
  if (status === 403) return outOfBalance ? "no_balance" : "model_access_denied";
  if (status === 429) {
    // Throttling.RateQuota is an RPM limit. Balance is arrears, exhausted, or AllocationQuota (D033 §3).
    if (outOfBalance) return "no_balance";
    return "rate_limited";
  }
  if (status === 401 || /invalid_api_key|incorrect api key/.test(blob)) return "invalid_key";
  if (status === 500 || status === 503) return "unavailable";
  return null;
}

function promptHasJsonContract(system: string, user: string): boolean {
  const combined = `${system}\n${user}`;
  return /\bjson\b/i.test(combined) && /\{[^{}]*\}/.test(combined);
}

const CITING_VERDICTS = ["supported", "partially_supported", "contradicted"];
const QUIET_VERDICTS = ["unsupported", "unverifiable", "excluded"];

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  required?: string[];
  additionalProperties?: boolean;
  minItems?: number;
}

/** Drop draft metadata, input defaults, and Zod's safe-integer bounds. Real min/max stay. */
function providerJsonSchema(schema: ZodType): JsonSchemaNode {
  return stripSchemaNoise(z.toJSONSchema(schema, { io: "input" })) as JsonSchemaNode;
}

function stripSchemaNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema" || key === "default") continue;
    if ((key === "minimum" || key === "maximum") && typeof value === "number" && Math.abs(value) >= Number.MAX_SAFE_INTEGER) continue;
    out[key] = stripSchemaNoise(value);
  }
  return out;
}

function jsonSchemaResponseFormat(schema: ZodType): { type: "json_schema"; json_schema: { name: string; schema: JsonSchemaNode; strict: false } } {
  return {
    type: "json_schema",
    json_schema: { name: JSON_SCHEMA_NAME, schema: providerJsonSchema(schema), strict: false },
  };
}

/** Field sketch, plus the citation rule when the schema has evidenceCitations. This path only (D033). */
function outputContract(schema: ZodType): string {
  const json = providerJsonSchema(schema);
  const rule = schemaHasKey(json, "evidenceCitations") ? ` ${CITATION_RULE}` : "";
  return `OUTPUT CONTRACT: ${sketch(json)}.${rule}`;
}

/** Citing verdicts require a citation. The other verdicts require null. Wire schema only; Zod stays nullable (D027). */
function tightenCitationSchema(node: JsonSchemaNode): JsonSchemaNode {
  if (node.properties && "evidenceCitations" in node.properties) return citationOneOf(node);
  const next: JsonSchemaNode = { ...node };
  if (node.properties) next.properties = mapSchema(node.properties);
  if (node.items) next.items = tightenCitationSchema(node.items);
  if (node.anyOf) next.anyOf = node.anyOf.map(tightenCitationSchema);
  if (node.oneOf) next.oneOf = node.oneOf.map(tightenCitationSchema);
  return next;
}

function mapSchema(properties: Record<string, JsonSchemaNode>): Record<string, JsonSchemaNode> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, tightenCitationSchema(value)]));
}

function citationOneOf(node: JsonSchemaNode): JsonSchemaNode {
  const props = node.properties ?? {};
  const rest: Record<string, JsonSchemaNode> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "verdict" || key === "evidenceCitations") continue;
    rest[key] = tightenCitationSchema(value);
  }
  const verdict = props.verdict ?? { type: "string" };
  const branch = (enumValues: string[], citations: JsonSchemaNode): JsonSchemaNode => ({
    type: "object",
    properties: { ...rest, verdict: { ...verdict, enum: enumValues }, evidenceCitations: citations },
    required: ["id", "verdict", "confidence", "evidenceCitations"],
    additionalProperties: false,
  });
  return {
    oneOf: [
      branch(CITING_VERDICTS, citationArrayBranch(props.evidenceCitations ?? {})),
      branch(QUIET_VERDICTS, { type: "null" }),
    ],
  };
}

function citationArrayBranch(node: JsonSchemaNode): JsonSchemaNode {
  const array = node.anyOf?.find((child) => child.type === "array") ?? (node.type === "array" ? node : undefined);
  if (array) return { ...array, minItems: 1 };
  return {
    type: "array",
    minItems: 1,
    items: { type: "object", properties: { source: { type: "string" }, n: { type: "integer" } }, required: ["source", "n"] },
  };
}

function schemaHasKey(node: JsonSchemaNode | undefined, key: string): boolean {
  if (!node) return false;
  if (node.properties && (key in node.properties || Object.values(node.properties).some((child) => schemaHasKey(child, key)))) return true;
  return schemaHasKey(node.items, key)
    || (node.anyOf?.some((child) => schemaHasKey(child, key)) ?? false)
    || (node.oneOf?.some((child) => schemaHasKey(child, key)) ?? false);
}

function sketch(node: JsonSchemaNode): string {
  if (node.oneOf && node.oneOf.length > 0) return node.oneOf.map(sketch).join("|");
  if (node.anyOf && node.anyOf.length > 0) return node.anyOf.map(sketch).join("|");
  if (node.enum && node.enum.length > 0) return node.enum.map((item) => String(item)).join("|");
  if (node.type === "object") {
    const fields = Object.entries(node.properties ?? {}).map(([key, value]) => `${key}:${sketch(value)}`);
    return `{${fields.join(",")}}`;
  }
  if (node.type === "array") return `${sketch(node.items ?? { type: "string" })}[]`;
  if (node.type === "integer") return "integer";
  if (node.type === "number") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "null") return "null";
  return node.type ?? "value";
}

/** A rejected json_schema. Classified auth, balance, and quota errors are not this (D033 §3). */
function schemaFormatRejected(provider: "deepseek" | "qwen", status: number, code: string, message: string, raw: string): boolean {
  if (classifyCompatibleError(provider, status, code, message)) return false;
  return /json_schema|response_format/i.test(`${code} ${message} ${raw}`);
}

export class OpenAICompatibleProvider implements Provider {
  readonly mode: string;
  readonly model: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.mode = config.provider;
    this.model = config.model;
  }

  async completeJson<T>(request: CompletionRequest): Promise<ProviderResponse<T>> {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;
    const contract = request.responseSchema ? outputContract(request.responseSchema) : undefined;
    const { system, user } = this.requestMessages(request.system, request.user, contract);
    const parsed = await this.completeOnce<T>(request, system, user, timeoutMs);
    normalizeCitationKeys(parsed.result);
    if (!needsCitationRepair(parsed.result)) return parsed;
    // Passages are inside the system prompt. Keep it, and name the camelCase key the gate reads (D027).
    const repairSystem = `${system}\n\nReply with a JSON object only. The key is evidenceCitations, never evidence_citations. ${CITATION_RULE}`;
    const repairUser = `${user}\n\nThe previous JSON is invalid. ${CITATION_RULE}`;
    return this.postJson<T>(this.chatBody(repairSystem, repairUser, request, { type: "json_object" }), timeoutMs, false);
  }

  private async completeOnce<T>(
    request: CompletionRequest,
    system: string,
    user: string,
    timeoutMs: number,
  ): Promise<ProviderResponse<T>> {
    if (request.responseSchema && this.config.provider === "deepseek") {
      try {
        return await this.postResponses<T>(system, user, request, request.responseSchema, timeoutMs);
      } catch (error: unknown) {
        if (!(error instanceof SchemaFormatUnsupported)) throw error;
      }
    }
    const structured = request.responseSchema && this.config.provider !== "deepseek"
      ? jsonSchemaResponseFormat(request.responseSchema)
      : undefined;
    let body = this.chatBody(system, user, request, structured ?? { type: "json_object" });
    let allowSchemaFallback = structured !== undefined;
    for (;;) {
      try {
        return await this.postJson<T>(body, timeoutMs, allowSchemaFallback);
      } catch (error: unknown) {
        if (allowSchemaFallback && error instanceof SchemaFormatUnsupported) {
          // One retry on json_object. The contract is already on this request (D033).
          body = this.chatBody(system, user, request, { type: "json_object" });
          allowSchemaFallback = false;
          continue;
        }
        throw error;
      }
    }
  }

  /** DeepSeek reads balance. Qwen sends one fixed completion. Neither call takes the article (T2013). */
  async preflight(): Promise<void> {
    if (this.config.provider === "deepseek") {
      await this.preflightDeepSeek();
      return;
    }
    await this.preflightQwen();
  }

  private async preflightDeepSeek(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
    try {
      const response = await fetch(DEEPSEEK_BALANCE_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) throw await this.errorForResponse(response, "preflight");
      const available = await readBalanceAvailable(response, this.config.apiKey);
      if (available === false) {
        logger.warn(
          { module: MODULE, operation: "preflight", provider: "deepseek", category: "no_balance" },
          "provider call classified",
        );
        throw new ProviderError("no_balance", CATEGORY_MESSAGE.no_balance);
      }
    } catch (error: unknown) {
      if (error instanceof ProviderError || error instanceof TimeoutError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out|aborted|abort/i.test(error.message))) {
        throw new TimeoutError("provider call timed out");
      }
      logger.warn({ module: MODULE, operation: "preflight", provider: "deepseek" }, "provider call failed");
      throw new ProviderError("unavailable", CATEGORY_MESSAGE.unavailable);
    } finally {
      clearTimeout(timer);
    }
  }

  private async preflightQwen(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: PREFLIGHT_PROMPT }],
          enable_thinking: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw await this.errorForResponse(response, "preflight");
      await response.text();
    } catch (error: unknown) {
      if (error instanceof ProviderError || error instanceof TimeoutError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out|aborted|abort/i.test(error.message))) {
        throw new TimeoutError("provider call timed out");
      }
      logger.warn({ module: MODULE, operation: "preflight", provider: "qwen" }, "provider call failed");
      throw new ProviderError("unavailable", CATEGORY_MESSAGE.unavailable);
    } finally {
      clearTimeout(timer);
    }
  }

  private chatBody(
    system: string,
    user: string,
    request: CompletionRequest,
    responseFormat: Record<string, unknown>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: responseFormat,
      temperature: request.options?.temperature ?? 0,
    };
    if (this.config.provider === "deepseek") {
      body.max_tokens = request.options?.maxTokens ?? DEEPSEEK_MAX_TOKENS;
      body.thinking = { type: "disabled" };
    } else {
      body.enable_thinking = false;
    }
    return body;
  }

  private async postResponses<T>(
    system: string,
    user: string,
    request: CompletionRequest,
    schema: ZodType,
    timeoutMs: number,
  ): Promise<ProviderResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(DEEPSEEK_RESPONSES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions: system,
          input: user,
          reasoning: { effort: "none" },
          max_output_tokens: request.options?.maxTokens ?? DEEPSEEK_MAX_TOKENS,
          text: {
            format: {
              type: "json_schema",
              name: JSON_SCHEMA_NAME,
              schema: tightenCitationSchema(providerJsonSchema(schema)),
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readErrorBody(response, this.config.apiKey);
        if (classifyCompatibleError(this.config.provider, response.status, detail.code, detail.message)) {
          throw this.errorFromDetail(response.status, detail, "completeJson");
        }
        logger.warn(
          { module: MODULE, operation: "completeJson", provider: this.config.provider, status: response.status },
          "responses json_schema rejected, using json_object",
        );
        throw new SchemaFormatUnsupported();
      }
      return await this.parseResponses<T>(response);
    } catch (error: unknown) {
      if (error instanceof ProviderError || error instanceof TimeoutError || error instanceof SchemaFormatUnsupported) throw error;
      if (isKeptProviderError(error)) throw error;
      if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out|aborted|abort/i.test(error.message))) {
        throw new TimeoutError("provider call timed out");
      }
      logger.warn({ module: MODULE, operation: "completeJson", provider: this.config.provider }, "provider call failed");
      throw new ProviderError("unavailable", CATEGORY_MESSAGE.unavailable);
    } finally {
      clearTimeout(timer);
    }
  }

  private async postJson<T>(body: Record<string, unknown>, timeoutMs: number, allowSchemaFallback: boolean): Promise<ProviderResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.config.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readErrorBody(response, this.config.apiKey);
        if (allowSchemaFallback && schemaFormatRejected(this.config.provider, response.status, detail.code, detail.message, detail.raw)) {
          logger.warn(
            { module: MODULE, operation: "completeJson", provider: this.config.provider, status: response.status },
            "json_schema unsupported, using json_object",
          );
          throw new SchemaFormatUnsupported();
        }
        throw this.errorFromDetail(response.status, detail, "completeJson");
      }
      return await this.parseSuccess<T>(response);
    } catch (error: unknown) {
      if (error instanceof ProviderError || error instanceof TimeoutError || error instanceof SchemaFormatUnsupported) throw error;
      if (isKeptProviderError(error)) throw error;
      if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out|aborted|abort/i.test(error.message))) {
        throw new TimeoutError("provider call timed out");
      }
      logger.warn({ module: MODULE, operation: "completeJson", provider: this.config.provider }, "provider call failed");
      throw new ProviderError("unavailable", CATEGORY_MESSAGE.unavailable);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestMessages(system: string, user: string, outputContractText?: string): { system: string; user: string } {
    const withJson = promptHasJsonContract(system, user) ? user : `${user}\n\n${JSON_REQUEST_SUFFIX}`;
    if (!outputContractText) return { system, user: withJson };
    // The shared VERIFY prompt still shows evidence_citations. The contract after it names evidenceCitations (D027).
    return { system: `${system}\n\n${outputContractText}`, user: `${withJson}\n\n${outputContractText}` };
  }

  private async errorForResponse(response: Response, operation = "completeJson"): Promise<Error> {
    return this.errorFromDetail(response.status, await readErrorBody(response, this.config.apiKey), operation);
  }

  private errorFromDetail(status: number, detail: { code: string; message: string }, operation: string): Error {
    const category = classifyCompatibleError(this.config.provider, status, detail.code, detail.message);
    if (!category) {
      logger.warn(
        { module: MODULE, operation, provider: this.config.provider, status },
        "provider rejected the request",
      );
      return new Error("The provider rejected the request.");
    }
    logger.warn(
      { module: MODULE, operation, provider: this.config.provider, status, category, code: detail.code },
      "provider call classified",
    );
    return new ProviderError(category, CATEGORY_MESSAGE[category]);
  }

  private async parseSuccess<T>(response: Response): Promise<ProviderResponse<T>> {
    const raw = await response.text();
    let payload: {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      throw new Error("Malformed JSON from AI provider");
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("provider returned empty content");
    }
    let result: T;
    try {
      result = JSON.parse(content) as T;
    } catch {
      throw new Error("Malformed JSON from AI provider");
    }
    const usage = payload.usage;
    const tokens: TokenUsage | undefined = usage
      ? {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }
      : undefined;
    return { result, usage: tokens };
  }

  private async parseResponses<T>(response: Response): Promise<ProviderResponse<T>> {
    const raw = await response.text();
    let payload: {
      output?: Array<{ type?: string; content?: Array<{ text?: string | null }> }>;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      throw new Error("Malformed JSON from AI provider");
    }
    const message = payload.output?.find((item) => item.type === "message");
    const content = message?.content?.find((part) => typeof part.text === "string" && part.text.trim() !== "")?.text;
    if (typeof content !== "string") throw new Error("provider returned empty content");
    let result: T;
    try {
      result = JSON.parse(content) as T;
    } catch {
      throw new Error("Malformed JSON from AI provider");
    }
    const usage = payload.usage;
    const tokens: TokenUsage | undefined = usage
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }
      : undefined;
    return { result, usage: tokens };
  }
}

/** Copy a real evidence_citations array onto evidenceCitations. An empty string is not a citation (D027). */
function normalizeCitationKeys(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const results = (result as { results?: unknown }).results;
  if (!Array.isArray(results)) return;
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as { evidenceCitations?: unknown; evidence_citations?: unknown };
    const camelEmpty = row.evidenceCitations == null || (Array.isArray(row.evidenceCitations) && row.evidenceCitations.length === 0);
    if (!camelEmpty || !Array.isArray(row.evidence_citations) || row.evidence_citations.length === 0) continue;
    row.evidenceCitations = row.evidence_citations;
    delete row.evidence_citations;
  }
}

/** A citing verdict whose evidenceCitations is null or empty. Repaired once (D027). */
function needsCitationRepair(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const results = (result as { results?: unknown }).results;
  if (!Array.isArray(results)) return false;
  return results.some((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as { verdict?: unknown; evidenceCitations?: unknown };
    if (typeof row.verdict !== "string" || !CITING_VERDICTS.includes(row.verdict)) return false;
    return row.evidenceCitations == null || (Array.isArray(row.evidenceCitations) && row.evidenceCitations.length === 0);
  });
}

/** True, false, or unknown. The balance figures in the body are discarded (D033 §3). */
async function readBalanceAvailable(response: Response, apiKey: string): Promise<boolean | null> {
  const raw = scrubErrorMessage(await response.text(), [apiKey]) ?? "";
  try {
    const parsed = JSON.parse(raw) as { is_available?: unknown };
    return typeof parsed.is_available === "boolean" ? parsed.is_available : null;
  } catch {
    return null;
  }
}

/** Signals one json_object retry. Not a provider failure and not logged as one. */
class SchemaFormatUnsupported extends Error {
  constructor() {
    super("json_schema response_format is unsupported");
    this.name = "SchemaFormatUnsupported";
  }
}

function isKeptProviderError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === "provider returned empty content" ||
      error.message === "Malformed JSON from AI provider" ||
      error.message === "The provider rejected the request.")
  );
}

async function readErrorBody(response: Response, apiKey: string): Promise<{ code: string; message: string; raw: string }> {
  const raw = scrubErrorMessage(await response.text(), [apiKey]) ?? "";
  try {
    const parsed = JSON.parse(raw) as { error?: ProviderErrorBody } | ProviderErrorBody;
    const error = parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object"
      ? parsed.error
      : (parsed as ProviderErrorBody);
    return {
      code: typeof error.code === "string" ? error.code : "",
      message: typeof error.message === "string" ? error.message : "",
      raw,
    };
  } catch {
    return { code: "", message: "", raw };
  }
}
