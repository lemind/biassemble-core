# D027 — Expose Per-Source Citation Provenance in the Grounnel API

## §1. Trigger

The `biassemble` frontend team asked for a "jump to the supporting text" affordance on each highlighted claim. Investigating what the public API already provides: `claim.evidence` is a single flattened string, sometimes joining sentences from *multiple different sources* with `" ... "` (e.g. `"Sentence A3 states X. Sentence A7 states Y."` — those `A3`/`A7` labels are literally the model's own internal citation vocabulary leaking into prose, not structured data). There is no way for a consumer to know which sentence came from which source URL.

## §2. What already exists internally (verified against real code, not assumed)

- `resolveEvidence` (`pipeline.service.ts`) pools up to `MAX_VERIFY_PASSAGES` (3) ranked passages per claim (D026 §11), each sentence-split and labeled `A`/`B`/`C` in rank order (`buildPassageSentencesMulti`, `passage-sentences.ts`).
- VERIFY cites structured `{source, n}` pairs (`evidenceCitations`) — never free text (D026 §7).
- `resolveEvidenceFromCitations` (`passage-sentences.ts`) resolves those citations to real sentence text, then **joins them into one string and discards the source label** (`pipeline.service.ts`'s `callVerify`). This is the exact point provenance is lost today.
- The public `sources[]` array (`toClaimSources`) is a *different, broader* list than the pooled `passages[]` used for citations — includes every attempted source (even unreachable ones), in original search-result order, not rank order. **Verified by tracing object identity**: `ResolvedEvidence.passages` and `.sources` are built from the same underlying `SearchPassage[]` objects (`okSources = sources.filter(...)`, `rerankPassages` returns those same references unchanged) — so a pooled passage can be matched back to its full `sources[]` entry by object identity, not by URL string comparison. This sidesteps a URL-canonicalization problem entirely (no `https://foo` vs `https://foo/` risk), since nothing in this path ever reconstructs a URL string.
- **Gate interaction, the part that isn't optional to get right**: `runGateChain` can null `evidence` wholesale (gate #1's groundedness check, gate #1b's cross-claim-contamination check, and `checkRetryContradiction`'s invalidation path) — but never *rewrites* it to a different non-null string. Verified directly in `gates.ts`: `applyContradictionEvidenceGate` returns either `evidence: input.evidence` unchanged or `evidence: null`; `applyNumericGate` doesn't touch `evidence` at all. This means citation survival can be derived post-hoc — `finalCitations = chain.evidence !== null ? citationsBeforeGates : null` — without threading a second parallel value through every gate function.

## §3. Decision

Add a new field to the public claim shape, additive only:

```ts
export const ClaimCitationSchema = z.object({
  source: z.string(),   // internal label ("A"/"B"/"C") — kept for traceability/debugging
  sentence: z.number().int(),
  url: z.url(),
  text: z.string(),
});

// on ClaimSchema:
citations: z.array(ClaimCitationSchema).default([]),
```

One entry per citation, **not deduplicated or merged by source** — if VERIFY cites `A2`, `C1`, `A7`, the array has three entries in that order, even though two share a source. Aggregation (e.g. grouping by URL for display) is presentation logic and belongs in a consumer, not this API — merging here would be a one-way door (individual citations can't be recovered once joined), while a consumer can always merge a flat list itself if it wants to.

`evidence: string` is unchanged — nothing downstream that reads it needs to change. `citations` is purely additive.

### Implementation shape

`callVerify`'s per-result return gains a `citations` field alongside `evidence`, both derived from the same `resolveEvidenceFromCitations`-family call (split into a version that returns structure, not just a joined string) — the resolver stays responsible for *resolution*, not presentation, matching the file's existing `ResolvedEvidence`/`resolveEvidence` naming convention. `retryVerifyClaim` needs no separate change — it already returns one element of `callVerify`'s result array, so the new field flows through for free. `processVerifyResults` picks `result.citations` or `retried.citations` (whichever evidence source won, same binary choice already made for `evidence`/`reason`/`confidence`), then applies the gate-survival rule from §2 before writing `citations` alongside `evidence` in the final `ClaimResult`.

### Backward compatibility

`citations: z.array(...).default([])` — a Redis row written before this field existed re-parses with `citations: []`, not a validation error. No migration needed (Redis is the only store for this shape; Postgres history tables aren't in scope for this change).

## §4. Explicitly not doing

- **Character-offset citation** — already rejected in D026 §7 for reliability reasons (models are unreliable at exact counting); sentence-level citation is the deliberate, working design, not reopened here.
- **`#:~:text=` deep links** — noted as a possible future consumer of this data, not attempted here. Brittle in practice (whitespace normalization, HTML-stripping artifacts already documented in D026 §16, Unicode normalization, browser support) — a frontend concern to revisit only once real excerpt text is available to test against.
- **Attached-document sources** (`kind: "attached"`) — not produced by this pipeline; no excerpt concept applies.
- **Deduplicating/merging citations by source** — see §3; deliberately left to consumers.
- **Threading citations through every gate function as a second parallel value** — the derived post-hoc rule (§2) is correct given the verified gate behavior and is significantly less invasive.

## Consequences

- `src/contracts/grounnel.schemas.ts`: new `ClaimCitationSchema`, `ClaimSchema` gains `citations` (additive, defaulted).
- `src/orchestrators/grounnel/passage-sentences.ts`: citation resolution returns structure (source/sentence/text), not just a joined string.
- `src/orchestrators/grounnel/pipeline.service.ts`: `callVerify`'s return shape, `processVerifyResults`'s citation-survival-after-gates logic, `toClaimSources`-adjacent mapping from pooled passage back to its full `SearchPassage` (by object identity) for the `url`.
- No DB/schema migration. No prompt change (`verify/system.json` untouched — the model's output shape doesn't change, only how the response is processed downstream).
- Cross-repo follow-up, not part of this change: `biassemble/backend`'s `contracts.ts` and `biassemble/frontend`'s `types/grounnel.ts` need the same additive field before the frontend can consume it — tracked separately.

**Source**: `specs/010-grounnel-citation-provenance/` (this branch, `011-gr-upd1`), 2026-08-12.
