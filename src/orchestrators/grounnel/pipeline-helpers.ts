// Free-standing helpers/types for GrounnelPipelineService — no `this` (D031 split, pure move). See pipeline.service.ts for the class.

import { logger } from "../../observability/logger.js";
import { GrounnelVerdictEnum, type ClaimSource, type ClaimCitation } from "../../contracts/grounnel.schemas.js";
import type { RateLimitError } from "../../providers/gemini.js";
import type { SearchPassage } from "../../providers/search/search-provider.js";
import type { ResolvedCitation } from "./passage-sentences.js";
import type { GateEventInput } from "../../persistence/grounnel-gate-event-store.js";
import type { GateReason } from "../../persistence/types.js";
import type { z } from "zod";

const MODULE = "grounnel-pipeline-service";

export type Verdict = z.infer<typeof GrounnelVerdictEnum>;

export interface PipelineClaimInput {
  id: string;
  text: string;
  // D028 — verified verbatim substring of the source text, or null if unproduced/unverified.
  sourceExcerpt: string | null;
  // g17 — EXTRACT's disambiguated name for who/what this claim is about, or "" when none applies.
  subjectEntity: string;
}

export interface ResolvedEvidence {
  claim: PipelineClaimInput;
  // D026 §11 — up to MAX_VERIFY_PASSAGES ranked sources; array order is rank order, which
  // callVerify's label assignment depends on being meaningful.
  passages: SearchPassage[];
  sources: SearchPassage[];
}

export interface ResolvedWithPassage extends ResolvedEvidence {
  passages: SearchPassage[]; // guaranteed non-empty by hasPassage below
}

export function hasPassage(r: ResolvedEvidence): r is ResolvedWithPassage {
  return r.passages.length > 0;
}

// Escalation-replacement guard (D030 §3h) — citations, not `evidence`, is the reliable ground-truth signal; see the ADR for why citationsInvariant only enforces that direction.
export function hasValidEvidence(citations: unknown[]): boolean {
  return citations.length > 0;
}

export function toClaimSources(sources: SearchPassage[]): ClaimSource[] {
  return sources.map((s) => ({ kind: "web" as const, title: s.title, domain: s.domain, url: s.url, status: s.status, retrievalMethod: s.retrievalMethod }));
}

/** Client-facing message for a Gemini RateLimitError — also reused by the route handler for EXTRACT's own case (no audit exists yet there, so it becomes the /extract response directly). */
export function buildGeminiRateLimitMessage(err: RateLimitError): string {
  // Never "try again in a few minutes" for a depleted balance — that is permanently false and hides
  // an operator problem behind a user-looking transient error (2026-08-28 incident).
  if (err.limitType === "billing") {
    return "Fact-checking is temporarily unavailable. Our team has been notified — please try again later.";
  }
  if (err.limitType === "daily") {
    return err.resetsAt
      ? `We've hit today's AI usage limit. Please try again after ${err.resetsAt}.`
      : "We've hit today's AI usage limit. Please try again tomorrow.";
  }
  return "We're being rate-limited right now. Please try again in a few minutes.";
}

// D027 §2 — callVerify's citation label codec ("A"-"Z" over `passages`, rank order); single-letter
// only, coupled by convention to MAX_VERIFY_PASSAGES staying ≤ 26 (guarded below, not just assumed).
export function passageLabelForIndex(i: number): string {
  if (i >= 26) throw new Error(`passageLabelForIndex: index ${i} exceeds the single-letter A-Z label scheme`);
  return String.fromCharCode(65 + i);
}
export function passageIndexForLabel(label: string): number {
  return label.charCodeAt(0) - 65;
}

// Reconciliation-disagreement telemetry (D030 T010 backlog — see tasks.md). Caller must pass only
// the CURRENT pass's gate events (review finding: a concatenated trail can surface a stale flip).
/** Gates whose `contradicted` is grounded enough to survive reconciliation and gate #2's force-supported (D030 §3d; spec 013 T21 added the second). */
export const PROTECTED_CONTRADICTION_GATES: ReadonlySet<string> = new Set(["reason_ordinal", "instance_attribution"]);

export function originatingContradictionGate(gateEvents: GateEventInput[]): { gate: string; reason: GateReason | null } | null {
  const event = gateEvents.findLast((e) => e.overridden && e.verdictAfter === "contradicted");
  return event ? { gate: event.gate, reason: event.reason } : null;
}

// Shared by all 3 reconciliation-downgrade sites (tasks.md backlog) — one aggregatable log stream; verdictBefore varies by site.
// verdictAfter is a real param, not always "unsupported" — D030 §3i Mode B's checkRetryContradiction
// call site can also downgrade to "unverifiable"; a hardcoded message here would silently mismatch
// the actual stored verdict on that path, in a codebase whose regression strategy leans on this telemetry.
export function logReconciliationDowngrade(operation: string, auditId: string, claimId: string, verdictBefore: Verdict, verdictAfter: Verdict, originating: { gate: string; reason: GateReason | null } | null): void {
  logger.info(
    { module: MODULE, operation, auditId, claimId, verdictBefore, verdictAfter, originatingGate: originating?.gate ?? null, originatingReason: originating?.reason ?? null },
    `Reconciliation classifier downgraded a verdict to ${verdictAfter}`
  );
}

// D027 §2 — out-of-range labels are dropped (logged), not thrown; see ADR §2 for why this is safe by construction today.
export function attachCitationUrls(citations: ResolvedCitation[], passages: SearchPassage[]): ClaimCitation[] {
  const result: ClaimCitation[] = [];
  for (const citation of citations) {
    const passage = passages[passageIndexForLabel(citation.source)];
    if (!passage) {
      logger.warn({ module: MODULE, operation: "attachCitationUrls", source: citation.source }, "Citation source label did not resolve to a pooled passage — dropping this citation");
      continue;
    }
    result.push({ source: citation.source, sentence: citation.sentence, url: passage.url, text: citation.text });
  }
  return result;
}
