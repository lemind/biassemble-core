/** Strip key material before a log line or an error_message write. Pino misses a key inside a string (D033 §5). */
const QUERY_KEY = /key=[^&\s"]+/gi;
const BEARER = /bearer\s+\S+/gi;
const GOOG_HEADER = /x-goog-api-key:\s*\S+/gi;
const SK_KEY = /sk-[A-Za-z0-9._-]+/g;
const AIZA_KEY = /AIza[0-9A-Za-z_-]{10,}/g;

export function scrubErrorMessage(message: string | null, secrets: readonly string[] = []): string | null {
  if (message === null) return null;
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out
    .replace(QUERY_KEY, "key=[REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(GOOG_HEADER, "x-goog-api-key: [REDACTED]")
    .replace(SK_KEY, "[REDACTED]")
    .replace(AIZA_KEY, "[REDACTED]");
}
