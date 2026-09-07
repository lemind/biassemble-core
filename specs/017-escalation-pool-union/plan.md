---
description: "Escalation pool union — carry retrieved pages across escalation tiers instead of rediscovering from scratch"
---

# Plan: Escalation Pool Union

## Summary

`escalateUnresolved` calls `discoverUrls()` fresh at every tier and **discards the previous tier's
pool**. A later tier can therefore hand VERIFY a strictly worse evidence set than the tier before it.

Carry each claim's ranked pool forward, starting from the **base** pass, and rank each tier over
`new ∪ carried`. One file. No prompt change, no schema change, no new LLM calls, no change to how
many passages VERIFY sees.

## Measurement that justifies it

Three runs of the identical 13,797-char article, same deployed build, 20 and 40 minutes apart:
runs `7c28d45b` (A), `6760307f` (B), `f603014b` (C).

| run | contradicted | detection (9 planted) | accuracy (40 checkable) | false accusations |
|---|---|---|---|---|
| A | 8 | 88.9% | 97.5% | 0 |
| B | 5 | **55.6%** | 90.0% | 0 |
| C | 8 | 88.9% | 97.5% | 0 |

EXTRACT was byte-identical across all three (same 44 claims). 39 of 44 claims were bit-stable.

**Tier-to-tier churn**, over 32 multi-tier claim-runs:

| metric | value |
|---|---|
| tier transitions | 50 |
| transitions dropping ≥1 URL | **35 (70.0%)** |
| URLs dropped | 69 |
| dropped URLs that had already been **selected** (shown to VERIFY) | **50** |

Run A discovered `yesterdaysoffice.com/the-history-of-the-computer-mouse` at the base tier, showed it
to VERIFY, then lost it at tier 2. Same shape for `wikipedia/History_of_the_Roman_Empire`,
`wright-brothers.org`, `nasa.gov/115-years-ago`.

## Honest scope

Cross-run, of the five unstable claims **union fixes exactly one**:

| claim | loser run | had-then-dropped | never discovered |
|---|---|---|---|
| **CSS before Internet** | B | **`prysmian.com/when-was-the-internet-invented`** | 0/4 |
| Vikings / Australia | B / C | one page / none | 2/3 / **3/3** |
| First mouse wireless | B | none | 1/4 |
| Roman Empire / Greece | B | none | 2/4 |
| Wright 4th = 120 ft | A | none | 3/5 (and it is a gate bug, not retrieval) |

**Union ships on the 50-discarded-selected-pages number, not on a detection story.** For mouse, Rome
and Vikings/C the winner's deciding pages were never discovered at all — union cannot conjure a URL
discovery never returned. Those stay out of scope.

It is a **prerequisite** for the two follow-on change sets: multi-entity rerank is worthless if the
tier that finally holds both entities has thrown one away, and raising `MAX_VERIFY_PASSAGES` is
paying VERIFY to re-read the same three pages.

## Correction to the earlier diagnosis (recorded so it is not re-derived)

`rerankPassages` computes `lexicalScore = 100 * (1 - i / labeled.length)` — **position in the
discovery result, not word overlap**. The comparison-entity page (`prysmian`) survived the 3-slot cut
because Gemini's discovery ranked it *first*, not because "Internet" appears in the claim. Verified:
CSS/A tier 2 had 4 sources scoring 100 / 75 / 50 / 25, exactly `i = 0,1,2,3`.

The rerank-starvation finding is unchanged — subject-entity pages score llm 90–95, comparison-entity
pages 10–20, in every run — but the surviving mechanism is discovery order, which is more fragile
than lexical overlap, not less. **This dictates the design**: a carried page cannot be re-scored
positionally against a new tier's pool, or it lands at ~0 and the union is a no-op.

## Design

### `ScoredSource` — `src/orchestrators/grounnel/pipeline-helpers.ts`

```ts
export interface ScoredSource {
  source: SearchPassage;
  /** Discovery-rank percentile in the pool that FOUND this page. Frozen; never recomputed. */
  lexicalScore: number;
  /** Rerank score from the tier that ranked it. Absent on the two paths that never call the
   *  LLM: the union.length <= 1 short-circuit and the catch fail-open. */
  llmScore?: number;
}
```

Cap ordering uses a derived combined score matching `rerankPassages`'s own formula:

```ts
const combinedOf = (s: ScoredSource) =>
  s.llmScore === undefined ? s.lexicalScore : (s.lexicalScore + s.llmScore) / 2;
```

`llmScore` exists because capping on `lexicalScore` alone would drop the lex=40 / llm=95
`almabetter.com/history-of-css` page and keep lex=100 / llm=20 noise — the exact inversion this
change exists to prevent.

### Changes — `src/orchestrators/grounnel/pipeline.service.ts`

1. `ResolvedEvidence` gains optional `rankedPool?: ScoredSource[]` — the capped ranked pool this tier
   considered. `passages` stays the `MAX_VERIFY_PASSAGES` slice, unchanged.
2. `resolveEvidence` takes optional trailing `carried?: ScoredSource[]`; builds the pool as
   new-ok-sources (positional scores over the new pool) ∪ `carried`, **deduped by normalized URL,
   newer wins**.
   - Dedup key: lowercase scheme+host, strip trailing slash, `http` ≡ `https`. `fetchCandidate`
     returns the post-redirect `response.url`, so a page can still arrive under two paths across
     tiers — normalization narrows that, it does not close it.
   - Input-duplicate check runs on **every new source**, re-fetches included. Only *carried* pages
     skip it. If the newer copy of a shared URL is refused as a duplicate the URL is dropped
     **entirely** — the stale carried copy is not resurrected.
3. `rerankPassages` takes and returns `ScoredSource[]`, uses each entry's supplied `lexicalScore`.
   - **Short-circuit keys off `union.length <= 1`, not the new-fetch count.** One new page plus seven
     carried is a pool of eight and must go to the LLM. Keying it off new sources alone fails
     silently and makes the change a no-op on exactly the claims it targets.
   - Excerpts stay `buildPassageSentences`-bounded. The pool grew; the per-candidate excerpt must
     not.
   - LLM call, `catch` fail-open, and `recordRerankDecisions` otherwise unchanged. Both no-LLM paths
     emit `llmScore: undefined`.
4. `resolveAllEvidence` populates `rankedPool`.
5. `escalateUnresolved` takes `Map<claimId, ScoredSource[]>`, threads it per claim, replaces each
   entry with that tier's `rankedPool`.
6. `run` builds the map from the base pass's `resolved`.

### Bounds

- **Carried pool capped at 8 `status === "ok"` pages per claim**, by `combinedOf` descending. Page
  text is uncapped, so an unbounded carry would hold every article a claim ever touched.
- Max union = 8 carried + 8 fetched = 16, keeping `String.fromCharCode(65 + i)` inside A–Z. That
  overflow at >26 candidates is a latent bug; the cap keeps us clear and fixing it is out of scope.
- **No new LLM calls, no extra VERIFY tokens.** Added cost is entirely rerank *input*: ~11 escalated
  claims × 2 tiers × up to +8 sentence-bounded excerpts ≈ **+70K rerank input tokens per run**.

### Out of scope

Skipping the re-fetch of a URL already held (needs a set threaded into `SearchProvider`, widening a
provider contract); `MAX_VERIFY_PASSAGES`; multi-entity `subject_entity`; the Wright
`retry_reconciliation` path (D030).

## False-accusation surface

`MAX_VERIFY_PASSAGES` stays 3 — the pool widens, the window does not. Materially smaller FA surface
than opening the window.

The residual vector is real: a tier-1 reject can win a tier-3 slot because the **new pool is weaker**,
not because the page got better. `guardEscalatedContradictionReversals` and the D030 §3h
escalation-replacement floor are unchanged and still apply — **but neither catches this**. The guard
only re-checks flips *away* from `contradicted`, so a new-and-wrong `contradicted` has no net under
it. Golden FA is the only thing standing there.

**Pre-registered revert rule: if golden FA moves off 0, revert — including if CSS goes 3/3.**

## Not doing

- Freezing contradictions across tiers. The 14-day census killed it: 716 transitions, 163 created a
  contradiction, 10 destroyed one.
- Per-case gates for mouse / CSS / Wright.
- Another rerank-prompt round.
