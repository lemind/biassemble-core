// VERIFY/consistency-check/passage-rerank response schemas for GrounnelPipelineService (D031 split, pure move).

import { z } from "zod";
import { GrounnelVerdictEnum } from "../../contracts/grounnel.schemas.js";
import type { ResolvedCitation } from "./passage-sentences.js";

export const VerifyResultSchema = z.object({
  id: z.string(),
  verdict: GrounnelVerdictEnum,
  // Gemini sometimes omits a null-valued key entirely rather than sending `null` — same
  // normalization idiom as audit-internal.schemas.ts's VerifyResultSchema (D018 §5, production incident).
  evidence: z.string().nullable().optional().transform((v) => v ?? null),
  reason: z.string().nullable().optional().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1),
});
// D027 — callVerify's real return shape (see ADR §3 for why citations aren't part of VerifyResultSchema itself).
export type VerifyProcessedResult = z.infer<typeof VerifyResultSchema> & { citations: ResolvedCitation[] };

// D026 §7/§11 — cites {source, n} pairs, never free-text quotes. Derived from VerifyResultSchema
// (not copy-pasted) so fields can't drift. `source` names which pooled passage a citation is from.
export const VerifyRawResultSchema = VerifyResultSchema.omit({ evidence: true }).extend({
  evidenceCitations: z
    .array(z.object({ source: z.string(), n: z.number().int() }))
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
export const VerifyRawResponseSchema = z.object({ results: z.array(VerifyRawResultSchema) });

// D025/T035 — batched "does reason support verdict?" classifier response.
export const ConsistencyCheckResultSchema = z.object({ id: z.string(), consistent: z.boolean() });
export const ConsistencyCheckResponseSchema = z.object({ results: z.array(ConsistencyCheckResultSchema) });

// D026 §18 — batched passage-relevance reranker response; score only, no free-text field (nothing
// downstream reads an explanation, so the prompt doesn't ask for one).
export const PassageRerankResultSchema = z.object({ id: z.string(), score: z.number().min(0).max(100) });
export const PassageRerankResponseSchema = z.object({ results: z.array(PassageRerankResultSchema) });
