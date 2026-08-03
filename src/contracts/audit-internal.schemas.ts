import { z } from "zod";
import { ClaimTypeEnum, VerdictEnum } from "./audit.schemas.js";

// Raw LLM response shapes — what EXTRACT/VERIFY actually return, before
// claim_id/passage_id assignment and DB persistence. Distinct from
// audit.schemas.ts's API-facing shapes.

export const ExtractedClaimSchema = z.object({
  id: z.string().min(1),
  type: ClaimTypeEnum,
  claim: z.string().min(1),
  excerpt: z.string().min(1),
  locations: z.array(z.string()),
  period: z.string(),
  derived: z.boolean(),
});

export const ExtractResponseSchema = z.object({
  claims: z.array(ExtractedClaimSchema),
  truncated: z.boolean(),
});

export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;
export const EXTRACT_RESPONSE_KEYS = ["claims", "truncated"];

export const VerifyResultSchema = z.object({
  claim_id: z.string().min(1),
  verdict: VerdictEnum,
  evidence: z.array(z.string()).nullable(),
  source_refs: z.array(z.string()),
  synthesized: z.boolean(),
  // Found on review (real production incident): Gemini sometimes omits this
  // key entirely instead of sending `note: null`. `.nullable()` alone
  // rejects `undefined` (missing key) — that failed the whole `results`
  // array's validation as one unit over a cosmetic field, killing an
  // otherwise-good batch of verdicts. Same normalization idiom as
  // audit.schemas.ts's `source_refs` fix.
  note: z.string().nullable().optional().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1),
});

export const VerifyResponseSchema = z.object({
  results: z.array(VerifyResultSchema),
  trace: z
    .object({
      sub_threshold: z.array(z.unknown()).optional(),
      uncertainty_reasons: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export const VERIFY_RESPONSE_KEYS = ["results", "trace"];
