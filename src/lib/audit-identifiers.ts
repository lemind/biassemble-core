import { randomUUID } from "node:crypto";

/**
 * UUIDv4 identity for claim_id/passage_id/audit_id (research.md §2) — assigned
 * once at creation, carried by reference, never re-derived from content.
 * Content-hash IDs were rejected for claim_id specifically: two genuinely
 * different claims can share identical text after EXTRACT's own dedup rule,
 * and a content hash would collide them.
 */
export function generateAuditId(): string {
  return randomUUID();
}

export function generateClaimId(): string {
  return randomUUID();
}

export function generatePassageId(): string {
  return randomUUID();
}
