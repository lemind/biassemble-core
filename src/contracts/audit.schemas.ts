import { z } from "zod";

// Matches specs/008-b2b/contracts/audit-endpoint.md field-for-field (T005).

// ─── Constants ────────────────────────────────────────────

/** Schema version carried in every response. Bump when breaking changes are made. */
export const AUDIT_SCHEMA_VERSION = "1.0.0" as const;

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MAX_CLAIMS = 50;

// ─── Enums ──────────────────────────────────────────────────

export const DomainEnum = z.enum(["general", "finance", "legal", "healthcare"]);
export const ClaimTypeEnum = z.enum(["numeric", "entity", "attribution", "causal", "derived"]);
export const VerdictEnum = z.enum([
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "unverifiable",
]);
export const RetrievalStatusEnum = z.enum(["ok", "error"]);
export const AuditStatusEnum = z.enum(["running", "complete", "failed"]);
export const FailedStageEnum = z.enum(["extract", "retrieve", "verify", "gate"]);

// ─── Request schema ─────────────────────────────────────────

// No client-supplied `mode` field (contracts/audit-endpoint.md — the route is
// the mode boundary; the server stamps mode: "audit" before the orchestrator
// sees it, per D018 §1's mode-branching invariant).
export const AuditSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  text: z.string(),
});

export const AuditRequestSchema = z.object({
  domain: DomainEnum,
  task: z.string().optional(),
  output_text: z.string().min(1),
  // Empty sources[] is valid — a degenerate but permitted input, per the
  // "sources are silent" principle (D018 §2.3) — not rejected outright.
  sources: z.array(AuditSourceSchema),
  options: z
    .object({
      threshold: z.number().min(0).max(1).default(DEFAULT_THRESHOLD),
      maxClaims: z.number().int().positive().default(DEFAULT_MAX_CLAIMS),
    })
    .default(() => ({ threshold: DEFAULT_THRESHOLD, maxClaims: DEFAULT_MAX_CLAIMS })),
});

export type AuditRequest = z.infer<typeof AuditRequestSchema>;

// ─── Submission response ────────────────────────────────────

export const AuditSubmitResponseSchema = z.object({
  audit_id: z.string().uuid(),
  status: z.literal("running"),
});

export type AuditSubmitResponse = z.infer<typeof AuditSubmitResponseSchema>;

// ─── Claim (includes Verdict fields — 1:1 extension, not a separate shape) ──

export const ClaimSchema = z.object({
  claim_id: z.string().uuid(),
  type: ClaimTypeEnum,
  claim: z.string(),
  excerpt: z.string(),
  locations: z.array(z.string()),
  period: z.string().nullable(),
  derived: z.boolean(),
  retrieval_status: RetrievalStatusEnum.nullable(),
  passages_retrieved_count: z.number().int().nonnegative(),
  verdict: VerdictEnum.nullable(),
  evidence: z.array(z.string()).nullable(),
  source_refs: z.array(z.string()),
  synthesized: z.boolean().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  note: z.string().nullable(),
});

export type Claim = z.infer<typeof ClaimSchema>;

// ─── Score Summary ───────────────────────────────────────────

// Nullable rate fields — data-model.md's zero-denominator guard: Eligible = 0
// persists these as null, never NaN, with insufficient_eligible_claims: true.
export const ScoreSummarySchema = z.object({
  grounded_rate: z.number().nullable(),
  groundedness_score: z.number().int().nullable(),
  strict_supported_rate: z.number().nullable(),
  contradiction_rate: z.number().nullable(),
  unsupported_rate: z.number().nullable(),
  retrieval_success_rate: z.number(),
  retrieval_coverage: z.number(),
  avg_evidence_quality: z.number().nullable(),
  synthesized_count: z.number().int().nonnegative(),
  counts: z.object({
    S: z.number().int().nonnegative(),
    P: z.number().int().nonnegative(),
    U: z.number().int().nonnegative(),
    C: z.number().int().nonnegative(),
    X: z.number().int().nonnegative(),
  }),
  eligible: z.number().int().nonnegative(),
  low_decisiveness: z.boolean(),
  insufficient_eligible_claims: z.boolean(),
});

export type ScoreSummary = z.infer<typeof ScoreSummarySchema>;

// ─── GET /audit/:audit_id — the three possible response shapes ─────────────

export const AuditRunningResponseSchema = z.object({
  audit_id: z.string().uuid(),
  status: z.literal("running"),
});

export const AuditFailedResponseSchema = z.object({
  audit_id: z.string().uuid(),
  status: z.literal("failed"),
  failed_stage: FailedStageEnum,
  error_summary: z.string(),
});

// rates.findings_count/gated_out_count count bias-module findings (D018 §3,
// out of scope for this feature — always 0 here). Distinct from `scores`,
// the claim-verdict business metrics (D018 §4) this feature actually computes.
export const AuditRatesSchema = z.object({
  findings_count: z.number().int().nonnegative(),
  gated_out_count: z.number().int().nonnegative(),
});

export const AuditMetaSchema = z.object({
  prompt_revision: z.object({ extract: z.string(), verify: z.string() }),
  model_revision: z.object({ extract: z.string(), verify: z.string() }),
  corpus_id: z.string(),
  retrieval_provider: z.string(),
  threshold: z.number(),
  pipeline_code_version: z.string(),
});

export const AuditCompleteResponseSchema = z.object({
  audit_id: z.string().uuid(),
  status: z.literal("complete"),
  input_ref: z.string(),
  domain: DomainEnum,
  claims: z.array(ClaimSchema),
  truncated: z.boolean(),
  rates: AuditRatesSchema,
  scores: ScoreSummarySchema,
  gated_candidates: z.array(z.unknown()),
  bias_flags: z.array(z.unknown()),
  meta: AuditMetaSchema,
});

export const AuditGetResponseSchema = z.discriminatedUnion("status", [
  AuditRunningResponseSchema,
  AuditFailedResponseSchema,
  AuditCompleteResponseSchema,
]);

export type AuditRunningResponse = z.infer<typeof AuditRunningResponseSchema>;
export type AuditFailedResponse = z.infer<typeof AuditFailedResponseSchema>;
export type AuditCompleteResponse = z.infer<typeof AuditCompleteResponseSchema>;
export type AuditGetResponse = z.infer<typeof AuditGetResponseSchema>;

export const AuditNotFoundResponseSchema = z.object({
  error: z.literal("not_found"),
});
