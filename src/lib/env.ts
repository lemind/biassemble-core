import { z } from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  AI_CORE_API_KEY: z.string().min(1, "AI_CORE_API_KEY is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Audit mode sends a whole claim batch plus its retrieved passages; the 10s story-flow default
  // aborted 2 of 5 live runs at 46 claims. D018 §5.10.
  AUDIT_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Wall-clock budget spanning EXTRACT + all VERIFY batches; 240s leaves margin under vercel.json's
  // maxDuration:300. D018 §5.13.
  AUDIT_MAX_DURATION_MS: z.coerce.number().int().positive().default(240000),
  AI_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  INNGEST_SERVE_HOST: z.string().optional(),
  VERCEL_BYPASS_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  // Stage 004: RAG engine (optional — omit in CI/eval to disable RAG, service falls back to roster)
  RAG_ENGINE_URL: z.url().optional(),
  RAG_API_KEY: z.string().min(1).optional(),
  // RAG runs in a background Inngest job (Stage 005), decoupled from the response
  // path, so the timeout only bounds the engine call itself — no user waits on it.
  // The llm_union strategy (Gemma on cpu-basic) takes ~2.9s p50; 500ms aborted every
  // call and made the engine permanently "unavailable". 8s covers p50 plus cold-start
  // and concurrency headroom.
  RAG_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  RAG_HF_TOKEN: z.string().optional(),
  // Grounnel's SearchProvider fallback (D021) — optional since Grounnel isn't wired into
  // server.ts yet (T012); required only once that wiring exists.
  TAVILY_API_KEY: z.string().min(1).optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = `[env] Invalid environment variables: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`;
    console.error(msg);
    throw new Error(msg);
  }
  return parsed.data;
}

export const env = loadEnv();