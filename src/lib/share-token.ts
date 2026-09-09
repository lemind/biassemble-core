import { randomBytes } from "node:crypto";

/**
 * A run's public address (spec 019, FR-002). 24 random bytes → 32 base64url characters, ~192 bits.
 *
 * Fresh entropy per run, never derived from runId: a hash of a known input is recoverable by anyone
 * holding that input, which would defeat FR-003 exactly as reusing runId would. base64url so it is
 * URL-safe with no escaping, and visually unlike the UUIDs that appear in logs and telemetry.
 */
export function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

// 24 random bytes always encode to exactly 32 base64url characters. `legacy_` marks the rows
// backfilled by migration 0016, which had no token when they were written.
const SHARE_TOKEN_RE = /^(?:legacy_[0-9a-f]{32}|[A-Za-z0-9_-]{32})$/;

/**
 * FR-003 — a run_id must never reach the database as a token. Length is what does the work here:
 * a UUID is 36 characters and its hyphens are inside base64url's alphabet, so a permissive
 * `[A-Za-z0-9_-]{20,128}` check would let one straight through. Kept beside the generator so the
 * two cannot drift.
 */
export function isShareTokenShape(value: string): boolean {
  return SHARE_TOKEN_RE.test(value);
}
