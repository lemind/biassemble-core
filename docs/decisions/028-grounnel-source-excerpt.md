# D028 — `biassemble-core` Locates Each Claim in the Source Text, Not the Frontend

## §1. Trigger

`biassemble` frontend's `matchClaimSpans.ts` reverse-engineers, after the fact, where each
claim (EXTRACT's paraphrased, pronoun-resolved `claim.text`) came from in the original article —
via a multi-tier fuzzy-matching system: exact substring, whole-sentence Jaccard, clause-splitting,
heading detection, degenerate-fragment filtering, no-threshold fallback. That heuristic layer
produced a full day of real, repeatedly-reported bugs (dates fragmented across spans, a claim's
highlight landing on a section heading or a bare stray word, degenerate 1-word clauses winning
matches), each patched individually. Direction: `biassemble-core` should tell the frontend
exactly where a claim came from, instead of the frontend guessing.

## §2. What already exists internally (verified against real code, not assumed)

The sibling `audit` orchestrator (`src/orchestrators/audit/extract.service.ts`) already does
exactly this: `Claim.excerpt`, a prompt rule, and a `.superRefine()`-in-schema check verifying
`outputText.includes(c.excerpt)`. This decision ports that pattern into Grounnel rather than
designing from scratch, but diverges on enforcement (§4).

## §3. Decision

Add `sourceExcerpt: z.string().nullable().default(null)` to `ClaimObjectSchema`
(`src/contracts/grounnel.schemas.ts`) — additive, same precedent as `citations` (D027 §2). EXTRACT's
prompt (`system.json`, bumped to `1.3.0`) asks the model for `source_excerpt`: a verbatim,
character-for-character substring of the source TEXT — the deliberate opposite of `claim`, which
stays paraphrased/pronoun-resolved for search-query quality. `extract.service.ts` verifies
`text.includes(c.source_excerpt)` (strict, un-normalized) after parsing and sets `sourceExcerpt:
null` on a miss. `source_excerpt` is passed to `callLlmForJson` via `quotedFields` (untrusted
quoted article text — the same mechanism already guarding VERIFY's `evidence`).

`ClaimResultSchema` omits `sourceExcerpt` alongside `id`/`text` — it's set once at claim creation
(`createAudit`) and never touched by a VERIFY-stage `writeClaimResult` call.

## §4. Diverged from audit's pattern: post-hoc null-out, not `.superRefine()`

Audit's `.superRefine()` check runs inside the Zod schema itself, meaning `repair.ts`'s
`salvageArrays` — which drops the **entire bad array element** on a validation failure, not just
the offending field (confirmed by reading `repair.ts`, not assumed) — would silently drop the
whole claim from verification the moment its excerpt was slightly off. That contradicts Grounnel's
own established convention: never fail/drop a whole item over one bad field (`citations:
.default([])`, `grounnel-store.ts`'s per-claim `getStatus` degradation). Instead, the excerpt
check runs in plain TypeScript after parsing, outside the schema — a bad excerpt degrades only
`sourceExcerpt` to `null`; `claim.text` and the claim itself are unaffected and still get verified
normally. The frontend degrades to its own (now much simpler) whole-sentence fallback when
`sourceExcerpt` is `null`.

## §5. Contiguity

For v1, each atomic claim carries one contiguous source excerpt. A claim whose supporting wording
is genuinely non-contiguous must use a containing contiguous excerpt (e.g. the whole sentence) or
degrade to the fallback tier — no array field. Atomicity (one fact per claim) does not itself
guarantee contiguity of wording; this is a deliberate v1 scope line, not a logical consequence.

## §6. Explicitly not doing

- **Reusing audit's `.superRefine()` mechanism** — see §4.
- **An array of excerpts per claim** — see §5; revisit only if real-run data shows the single-span
  restriction is actually losing claims, not preemptively.
- **Guaranteeing excerpt uniqueness within the article** — the prompt asks for "long enough to
  uniquely locate the fact" as guidance only; rejecting on ambiguity would lose otherwise-good data
  for no real benefit. A duplicate excerpt is the frontend's problem to resolve deterministically
  (first occurrence wins), not core's to prevent.

## Consequences

- `src/contracts/grounnel.schemas.ts`: `ClaimObjectSchema` gains `sourceExcerpt` (additive,
  defaulted); `ClaimResultSchema` explicitly omits it.
- `src/prompts/grounnel/extract/system.json`: bumped to `1.3.0`.
- `src/orchestrators/grounnel/extract.service.ts`: local `ExtractResponseSchema` gains
  `source_excerpt`; `quotedFields: ["source_excerpt"]`; post-hoc strict substring check.
- `src/orchestrators/grounnel/pipeline.service.ts`: `PipelineClaimInput` gains `sourceExcerpt:
  string | null` (type-only — this file never constructs the object literal).
- `src/persistence/grounnel-store.ts`: `createAudit`'s claim param and its `full: Claim`
  construction, and `getStatus`'s degraded-claim fallback, all thread the new field.
- No DB/schema migration; Redis rows from before this field re-parse with `sourceExcerpt: null`.
- Cross-repo follow-up, not part of this change: `biassemble/backend`'s `contracts.ts` and
  `biassemble/frontend`'s `types/grounnel.ts` + `matchClaimSpans.ts` need the same additive field
  and a rewritten, drastically simplified locator before the frontend stops guessing — tracked in
  the same change set as this decision, `biassemble` repo, branch `grounnel`.

**Source**: `biassemble-core` branch `011-gr-upd1`, 2026-08-13.
