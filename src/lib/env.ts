import { z } from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  AI_CORE_API_KEY: z.string().min(1, "AI_CORE_API_KEY is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  AI_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  INNGEST_SERVE_HOST: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
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