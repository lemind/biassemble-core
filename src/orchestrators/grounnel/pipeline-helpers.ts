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
  // spec 017 T012 — every entity a multi-topic claim is about, subjectEntity first. Empty (the
  // common case) means one topic; consumers must fall back to subjectEntity unchanged.
  subjectEntities?: string[];
}

/** A candidate plus the scores it carries between escalation tiers (spec 017 T003). */
export interface ScoredSource {
  source: SearchPassage;
  /** Discovery-rank percentile in the pool that FOUND it — frozen, never recomputed (spec 017). */
  lexicalScore: number;
  /** Rerank score from the tier that ranked it; absent on the two paths that never call the LLM. */
  llmScore?: number;
}

/** Mirrors rerankPassages' own average. Capping on lexical alone would keep lex=100/llm=20 noise over a lex=40/llm=95 page. */
export function combinedOf(s: ScoredSource): number {
  return s.llmScore === undefined ? s.lexicalScore : (s.lexicalScore + s.llmScore) / 2;
}

// Unambiguous tracking params only. Measured over 365 real retrieved URLs: content-bearing keys
// dominate (id 148, page 121, doc_id 45) and the only tracker present is utm_source (14).
const TRACKING_PARAM_RE = /^(?:utm_|fbclid$|gclid$|msclkid$|mc_[ce]id$|igshid$)/i;

// Same page can arrive under http/https, a trailing slash, or a tracking param across tiers — one
// key or the union double-counts and wastes a VERIFY slot (spec 017 T005, review finding).
export function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    // Re-encoded, not raw: searchParams DECODES, so `?a=1%26b=2` (one param) would otherwise
    // produce the same key as `?a=1&b=2` (two) and silently drop a distinct page (review finding).
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM_RE.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
    // `www.` is the same equivalence class as the scheme and differs far more often across providers.
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${path}${query}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export interface ResolvedEvidence {
  claim: PipelineClaimInput;
  // D026 §11 — up to MAX_VERIFY_PASSAGES ranked sources; array order is rank order, which
  // callVerify's label assignment depends on being meaningful.
  passages: SearchPassage[];
  sources: SearchPassage[];
  // spec 015 G1 — set when every usable source was refused as a copy of the input document, so the
  // user-facing reason can say that instead of the generic "no source found" (which would be false).
  allSourcesWereInputDuplicates?: boolean;
  // spec 017 — the capped ranked pool this tier considered, so the next tier can rank over it too.
  rankedPool?: ScoredSource[];
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
  // Never "try again in a few minutes" for an empty balance or a hit spend cap — permanently false, hides
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
