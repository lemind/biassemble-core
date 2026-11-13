import { createHmac } from "node:crypto";

// One secret, two purposes kept apart by prefix (D034 §4). The key never leaves memory; only these digests do.
function hmac(secret: string | undefined, input: string): string {
  if (!secret) throw new Error("MCP_HMAC_SECRET is not set");
  return createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/** Names a provider key's limit bucket and reservations. */
export function keyHmac(secret: string | undefined, provider: string, key: string): string {
  return hmac(secret, `key:${provider}:${key}`);
}

/** Tells two starts with one request token apart by their exact text. */
export function textHmac(secret: string | undefined, text: string): string {
  return hmac(secret, `text:${text}`);
}
