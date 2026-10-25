/** Provider table and client construction. The hidden site choice stays Gemini (D033 §1, T2007). */
import { env } from "../lib/env.js";
import { GeminiProvider } from "./gemini.js";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  OpenAICompatibleProvider,
  qwenChatCompletionsUrl,
} from "./openai-compatible.js";
import type { Provider } from "./types.js";

export type ProviderId = "gemini" | "deepseek" | "qwen";

/** One cap for every provider. extract.service MAX_CLAIMS matches this until T2009 imports it (T2007). */
export const PROVIDER_CLAIM_CAP = 40;

/** Hidden site choice. The route decides who may use the site key (T2010). */
export const SITE_DEFAULT_PROVIDER: ProviderId = "gemini";

const DEEPSEEK_MODEL = "deepseek-flash";
const QWEN_MODEL = "qwen3.6-flash";

export interface ProviderOption {
  id: ProviderId;
  claimCap: number;
  selectableWithOwnKey: boolean;
  /** Used when a run does not pass a model. Gemini stays on env.GEMINI_MODEL, not the key-check id. */
  defaultModel: string;
}

export const providerOptions: readonly ProviderOption[] = [
  { id: "gemini", claimCap: PROVIDER_CLAIM_CAP, selectableWithOwnKey: true, defaultModel: env.GEMINI_MODEL },
  { id: "deepseek", claimCap: PROVIDER_CLAIM_CAP, selectableWithOwnKey: true, defaultModel: DEEPSEEK_MODEL },
  { id: "qwen", claimCap: PROVIDER_CLAIM_CAP, selectableWithOwnKey: true, defaultModel: QWEN_MODEL },
];

export class UnknownProviderError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super("Unknown provider.");
    this.name = "UnknownProviderError";
    this.providerId = providerId;
  }
}

/** DeepSeek and Qwen are not built without a key. The caller passes the deployment key when it has one. */
export class ProviderKeyRequiredError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super("A provider key is required to build this client.");
    this.name = "ProviderKeyRequiredError";
    this.providerId = providerId;
  }
}

export class ProviderConfigError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super("The provider is not configured.");
    this.name = "ProviderConfigError";
    this.providerId = providerId;
  }
}

export function providerOption(id: string): ProviderOption | undefined {
  return providerOptions.find((option) => option.id === id);
}

/** An omitted Gemini key uses the deployment key. A passed key is forwarded. DeepSeek and Qwen throw when the key is missing (T2007). */
export function resolveProvider(choice: string, key?: string, model?: string): Provider {
  const option = providerOption(choice);
  if (!option) throw new UnknownProviderError(choice);
  const override = model?.trim();
  const resolvedModel = override ? override : option.defaultModel;
  if (option.id === "gemini") {
    return new GeminiProvider(key === undefined ? { model: resolvedModel } : { model: resolvedModel, apiKey: key });
  }
  const apiKey = key?.trim() ?? "";
  if (!apiKey) throw new ProviderKeyRequiredError(option.id);
  if (option.id === "deepseek") {
    return new OpenAICompatibleProvider({
      provider: "deepseek",
      model: resolvedModel,
      apiKey,
      baseUrl: DEEPSEEK_CHAT_COMPLETIONS_URL,
    });
  }
  const workspaceId = env.QWEN_WORKSPACE_ID;
  if (!workspaceId) throw new ProviderConfigError("qwen");
  return new OpenAICompatibleProvider({
    provider: "qwen",
    model: resolvedModel,
    apiKey,
    baseUrl: qwenChatCompletionsUrl(workspaceId),
  });
}
