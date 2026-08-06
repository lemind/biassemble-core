import { z } from "zod";

// Matches specs/009-grounnel/initial-context.md §3b field-for-field (T002).
// Grounnel is a self-contained API surface (spec.md) — its own enums here,
// not shared with audit.schemas.ts, even where values happen to overlap.

// ─── Enums ──────────────────────────────────────────────────

export const GrounnelStatusEnum = z.enum(["extracting", "verifying", "done", "failed"]);
export const ClaimStatusEnum = z.enum(["pending", "done", "failed"]);
export const GrounnelVerdictEnum = z.enum([
  "supported",
  "partially_supported",
  "unsupported",
  "contradicted",
  "unverifiable",
]);
// Unreachable sources are counted/shown/excluded from Eligible, not dropped (initial-context.md §4.4).
export const SourceStatusEnum = z.enum(["ok", "paywalled", "unreachable", "blocked"]);

// ─── Request schema — POST /extract ──────────────────────────

export const ExtractRequestSchema = z.object({
  text: z.string().min(1),
});

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

// ─── Submission response — POST /extract ─────────────────────

export const ExtractResponseSchema = z.object({
  id: z.string().uuid(),
});

export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

// ─── Source ───────────────────────────────────────────────────

// "web" is the only P0 producer; "attached" is P1 (user-uploaded document) — see spec.md's "Not in P0".
export const ClaimSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("web"),
    title: z.string(),
    domain: z.string(),
    url: z.url(),
    status: SourceStatusEnum,
  }),
  z.object({
    kind: z.literal("attached"),
    title: z.string(),
    documentId: z.string(),
  }),
]);

export type ClaimSource = z.infer<typeof ClaimSourceSchema>;

// ─── Claim (as it appears in GET /status/:id's claims[]) ─────

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  status: ClaimStatusEnum,
  verdict: GrounnelVerdictEnum.nullable(),
  evidence: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  reason: z.string().nullable(),
  sources: z.array(ClaimSourceSchema),
});

export type Claim = z.infer<typeof ClaimSchema>;

// GrounnelStore.writeClaimResult's `result` param (spec.md Code Style; tasks.md T007).
export const ClaimResultSchema = ClaimSchema.omit({ id: true, text: true });

export type ClaimResult = z.infer<typeof ClaimResultSchema>;

// ─── Progress ─────────────────────────────────────────────────

export const ProgressSchema = z.object({
  checked: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type Progress = z.infer<typeof ProgressSchema>;

// ─── Score ──────────────────────────────────────────────────

// not_checked_n stays a distinct field, never folded into any of the four
// verdict buckets (initial-context.md §3b field notes, §13, §4.2).
export const ScoreSchema = z
  .object({
    grounded_pct: z.number().int().min(0).max(100),
    grounded_n: z.number().int().nonnegative(),
    unclear_n: z.number().int().nonnegative(),
    no_evidence_n: z.number().int().nonnegative(),
    contradicted_n: z.number().int().nonnegative(),
    not_checked_n: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
  })
  // Guards against the exact bucket/eligible mismatch initial-context.md's own erratum shipped once.
  .refine((s) => s.grounded_n + s.unclear_n + s.no_evidence_n + s.contradicted_n + s.not_checked_n === s.eligible, {
    message: "grounded_n + unclear_n + no_evidence_n + contradicted_n + not_checked_n must sum to eligible",
  });

export type Score = z.infer<typeof ScoreSchema>;

// ─── GET /status/:id response ────────────────────────────────

export const StatusResponseSchema = z.object({
  id: z.string().uuid(),
  status: GrounnelStatusEnum,
  progress: ProgressSchema,
  claims: z.array(ClaimSchema),
  score: ScoreSchema,
  caps_hit: z.boolean(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;
