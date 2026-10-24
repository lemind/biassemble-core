/** Deployment key check: npx tsx --env-file=.env scripts/check-provider-keys.ts. Prints ok or a category. Not a Grounnel check (T2001). */
const PROMPT = "Reply with the single word ok.";
const TIMEOUT_MS = 20_000;

type Category =
  | "invalid_key"
  | "no_balance"
  | "rate_limited"
  | "unavailable"
  | "model_access_denied";

type Outcome = "ok" | Category | `missing ${string}` | "request_rejected";

interface ProviderErrorBody {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  type?: unknown;
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorBlob(body: ProviderErrorBody | undefined): string {
  if (!body) return "";
  return [asText(body.code), asText(body.status), asText(body.type), asText(body.message)]
    .filter((part) => part.length > 0)
    .join(" ");
}

function parseError(raw: string): ProviderErrorBody | undefined {
  try {
    const parsed = JSON.parse(raw) as { error?: ProviderErrorBody } | ProviderErrorBody;
    if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object") {
      return parsed.error;
    }
    if (parsed && typeof parsed === "object") return parsed as ProviderErrorBody;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Gemini: a rejected key is invalid_key; quota or a depleted balance is no_balance (D033 §3). */
function classifyGemini(status: number, blob: string): Outcome {
  const lower = blob.toLowerCase();
  const balance = /quota|resource_exhausted|billing|credit|depleted|spend(?:ing)? cap/.test(lower);
  const keyRejected = /api[_ ]key|unauthenticated|permission_denied|access_token_type_unsupported|auth/.test(lower);
  if (status === 401 || (status === 400 && keyRejected) || (status === 403 && keyRejected && !balance)) {
    return "invalid_key";
  }
  if (balance && (status === 429 || status === 403 || status === 400)) return "no_balance";
  if (status === 429) return "rate_limited";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "unavailable";
  if (status === 400 || status === 422) return "request_rejected";
  return "unavailable";
}

/** DeepSeek lines up with the HTTP status: 401, 402, 429, 500, 503 (D033 §3). */
function classifyDeepseek(status: number): Outcome {
  if (status === 401) return "invalid_key";
  if (status === 402) return "no_balance";
  if (status === 429) return "rate_limited";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "unavailable";
  if (status === 400 || status === 422) return "request_rejected";
  return "unavailable";
}

/** Qwen: 403 is model_access_denied. A 429 is no_balance only for arrears, exhaustion, or AllocationQuota (D033 §3). */
function classifyQwen(status: number, blob: string): Outcome {
  const lower = blob.toLowerCase();
  if (status === 403) return "model_access_denied";
  if (status === 401 || /invalid_api_key|incorrect api key/.test(lower)) return "invalid_key";
  if (status === 429) {
    if (/arrears|insufficient|exhausted|allocationquota|overdue/.test(lower)) return "no_balance";
    return "rate_limited";
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) return "unavailable";
  if (status === 400 || status === 422) return "request_rejected";
  return "unavailable";
}

async function callProvider(
  url: string,
  init: RequestInit,
  secrets: readonly string[],
  classify: (status: number, blob: string) => Outcome,
): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.ok) return "ok";
    const raw = scrub(await response.text(), secrets).slice(0, 4_000);
    return classify(response.status, errorBlob(parseError(raw)) || raw);
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function workspaceHost(workspaceId: string): string | undefined {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId)) return undefined;
  return `${workspaceId.toLowerCase()}.ap-southeast-1.maas.aliyuncs.com`;
}

async function checkGemini(key: string): Promise<Outcome> {
  return callProvider(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT }] }],
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      }),
    },
    [key],
    classifyGemini,
  );
}

async function checkDeepseek(key: string): Promise<Outcome> {
  return callProvider(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "deepseek-flash",
        messages: [{ role: "user", content: PROMPT }],
        thinking: { type: "disabled" },
        max_tokens: 16,
      }),
    },
    [key],
    classifyDeepseek,
  );
}

async function checkQwen(key: string, workspaceId: string): Promise<Outcome> {
  const host = workspaceHost(workspaceId);
  if (!host) return "request_rejected";
  return callProvider(
    `https://${host}/compatible-mode/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "qwen3.7-flash",
        messages: [{ role: "user", content: PROMPT }],
        enable_thinking: false,
      }),
    },
    [key, workspaceId],
    classifyQwen,
  );
}

async function main(): Promise<void> {
  const geminiKey = readEnv("GEMINI_API_KEY");
  const deepseekKey = readEnv("DEEPSEEK_API_KEY");
  const qwenKey = readEnv("QWEN_API_KEY");
  const workspaceId = readEnv("QWEN_WORKSPACE_ID");

  const results = await Promise.all([
    geminiKey ? checkGemini(geminiKey) : Promise.resolve("missing GEMINI_API_KEY" as Outcome),
    deepseekKey ? checkDeepseek(deepseekKey) : Promise.resolve("missing DEEPSEEK_API_KEY" as Outcome),
    !qwenKey
      ? Promise.resolve("missing QWEN_API_KEY" as Outcome)
      : !workspaceId
        ? Promise.resolve("missing QWEN_WORKSPACE_ID" as Outcome)
        : checkQwen(qwenKey, workspaceId),
  ]);

  const lines: Array<[string, Outcome]> = [
    ["gemini", results[0] ?? "unavailable"],
    ["deepseek", results[1] ?? "unavailable"],
    ["qwen", results[2] ?? "unavailable"],
  ];
  for (const [name, outcome] of lines) console.log(`${name} ${outcome}`);
  if (lines.some(([, outcome]) => outcome !== "ok")) process.exitCode = 1;
}

main().catch(() => {
  console.log("check unavailable");
  process.exitCode = 1;
});
