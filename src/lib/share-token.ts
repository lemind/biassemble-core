import { randomBytes } from "node:crypto";

// A run's public address (spec 019, FR-002): 24 random bytes, 32 base64url chars, ~192 bits.
// Fresh entropy per run, never derived from runId — a hash of a known input is recoverable.
export function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

// 24 random bytes always encode to exactly 32 base64url characters. `legacy_` marks the rows
// backfilled by migration 0016, which had no token when they were written.
const SHARE_TOKEN_RE = /^(?:legacy_[0-9a-f]{32}|[A-Za-z0-9_-]{32})$/;

// FR-003 — a runId must never pass as a token. Length does the work: a UUID is 36 chars and its
// hyphens are inside base64url, so a permissive {20,128} check would admit one.
export function isShareTokenShape(value: string): boolean {
  return SHARE_TOKEN_RE.test(value);
}
