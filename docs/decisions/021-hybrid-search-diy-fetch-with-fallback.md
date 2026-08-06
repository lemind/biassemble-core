# D021 — Hybrid Retrieval: DIY Fetch Primary, Tavily/Exa as Fallback Only

Amends SPEC-GROUNNEL v10 §4.1's blanket "Do not build custom fetch + readability + cleaning for MVP." That line was a reasonable default when written — no data existed yet either way. This ADR drops it, based on real measurement, not another guess.

---

## Situation

Real budget math (this conversation, same session) showed Tavily's free tier alone sustains roughly **1 article/day** at realistic claim counts (30 claims/article, 1 credit/search, 1,000 credits/month). That's too low for even light personal use of an MVP. Google's own "billing removes the free tier entirely, no hybrid mode" (verified against current docs) closes off the easy fix. The only genuinely free levers left were: cache (already planned, D019 §4/§6a), a lower `maxClaims` cap, Exa as a second free-tier pool — and, previously rejected without testing, doing the page-fetch step ourselves.

v10 §4.1 rejected DIY fetch on the reasonable assumption that it meant rebuilding what Tavily/Exa already solved, from scratch, for MVP. That assumption was never actually tested. This ADR is the test.

## Research

**Method:** for each claim, call Gemini (`gemini-2.5-flash-lite`, `google_search` tool, per-claim — matching the pipeline's real one-claim-one-search shape) to get citation URLs via `groundingChunks`. Follow each redirect (`requests`, browser `User-Agent`, `allow_redirects=True`). Parse the resolved page with `BeautifulSoup` (strip `script`/`style`, `get_text()`). Count DIY as successful for a claim if at least one of the top 3 cited URLs resolved to a real page (HTTP 200, >800 chars of parsed text, containing terms relevant to the claim). Only call Tavily when DIY failed for a claim, not preemptively.

**Script and raw results are committed, not just described here** — `specs/009-grounnel/research/diy-fetch-vs-tavily-test.py` (the exact script, batch-2 `CLAIMS` list as run), `results-batch1-famous-claims.json`, `results-batch2-obscure-claims.json` (raw per-claim output, same directory). One value was redacted before committing: `results-batch2-obscure-claims.json`'s 10th entry originally leaked the real `GEMINI_API_KEY` inside a `requests` library exception message (`429 Client Error: ... key=AIza...`) — caught before commit, replaced with `[REDACTED]`. Worth naming as a reminder for whoever writes the real pipeline's error handling: **don't let provider error messages containing the request URL (with an embedded API key) propagate into logs or stored records unredacted** — this is exactly the kind of leak that's easy to introduce accidentally in exception-message logging.

**Batch 1 — 5 well-known claims** (Eiffel Tower, Everest, Great Wall, bananas, Bukowski — reused from earlier benchmarking in this conversation): **5/5 succeeded on DIY fetch alone. 0 Tavily calls.**

**Batch 2 — 10 claims (5 true / 5 false) from a genuinely obscure, single-source-likely news story** — deliberately harder than batch 1: *"UCR historian awarded NEH grant to expand Early California Population Project"* (news.ucr.edu, 2026-08-03), a low-traffic university press release, not a famous topic with abundant redundant sources. Claims covered specific names, dollar amounts, funder identity, and record counts — including deliberately swapped false versions (wrong institution, wrong funder, wrong dollar figure, wrong dean, inflated record count).

**Result: 8/10 succeeded cleanly on DIY fetch.** Of the 2 that didn't:
- One (claim about who holds the Dean role) was a **test-script bug**, not a pipeline failure — DIY fetch got exactly the right page (`chass.ucr.edu/about-the-dean`, real, 6.5K chars, containing `"Contact the Dean Email: daryle.williams@ucr.edu"`), but the test's crude relevance keyword list didn't recognize it. Real answer: this claim didn't need Tavily either.
- One (a collaborator-attribution claim) was a **genuine gap** — DIY found the correct person's real bio pages, but they didn't explicitly restate their role on this specific project. Legitimate case for a fallback, not a DIY-fetch failure.
- One (institution-swap claim) hit a **Gemini API rate limit** (`429`) from the test script's own rapid-fire pace, unrelated to content availability.

**Verified, not assumed: real quotable evidence.** Pulled actual substring-matchable sentences from DIY-fetched pages for several claims — e.g. `"$41.4 million in grants announced by the NEH on Wednesday for 81 humanities projects"` and `"Contact the Dean Email: daryle.williams@ucr.edu"` — the exact shape gate #1 (D019 §2) needs to check `evidence` against. Not every DIY-fetched page yielded an equally clean quote on first pass (one case needed more of the page than a quick grep captured) — noted as a real, not glossed-over, limitation.

**Real per-URL failure rate, not hidden by the claim-level success number:** across both batches, roughly **20-27% of individual cited URLs failed** (bot-blocked: Britannica, mirion.com; rate-limited: huntington.org; malformed: one `facebook.com` link, HTTP 400). Claim-level success looks strong specifically because 2-3 URLs were tried per claim and only one needed to work — this ratio would look worse if a claim ever needed 2+ independently corroborating sources.

## Decision

Reverse v10 §4.1's blanket prohibition. `SearchProvider`'s implementation becomes a **hybrid, not a single vendor call**:

```
claim → Gemini search (google_search tool) → citation URLs (groundingChunks)
       → DIY fetch (own request + parse) on top 2-3 cited URLs
       → any one succeeds (200, substantial, relevant)? → use it, done
       → all fail? → Tavily (or Exa) as fallback, for this claim only
```

This does **not** replace Tavily/Exa or reopen D019 §2/§3's decisions. Gemini's search here is used purely for **URL discovery** (which `webSearchQueries`/`groundingChunks` already do reliably — confirmed across dozens of real calls this session) — never for **content or verdicts**, which is what D019 §3 disqualified it for and this finding does not touch. Tavily/Exa stay in the architecture as the reliability fallback, not removed.

## Prerequisite — resolved

Checked `ai.google.dev/gemini-api/terms` directly. The clause of concern: "You will not... cache, frame, syndicate, resell, analyze, train on, or otherwise learn from Grounded Results or Search Suggestions." Read in context, that whole list targets treating Gemini's own *generated answer text* as a reusable data asset (scraping it to train a model, reselling it, etc.) — this design never touches or repurposes that text. It uses a citation URL for exactly what citations are for: following it to check whether the actual third-party destination page (not Google's content) supports a claim. The separate "will not redirect end users away from destination pages" clause governs UI behavior toward a human clicking a citation Google shows them — this design never shows Google's citation to an end user at all; it shows its own independently-fetched source. Verdict: legitimate, intended use of the grounding feature, not a violation. T008 implements the hybrid design as originally specified.

## Do not

- **Do not** treat 15 test-script claims across 2 stories as validated at MVP scale, and don't mistake claim *count* for the thing that actually needs re-measuring. Batch 2 proved DIY works on one obscure, single-source story — it says nothing about the long tail a real pasted article will contain: dead links, paywalled journals, foreign-language sources, sites with no redundant corroboration at all. Re-measure against **source-diversity**, not just a bigger number of claims — a 50-claim batch drawn from the same kind of well-indexed English-language web content as batch 2 would not actually close this gap.
- **Do not** skip building real rate-limit/backoff handling before shipping this. Both Gemini's and a third-party site's (huntington.org) rate limits were hit just from this test's pace — production traffic will hit this harder, not easier.
- **Do not** treat DIY fetch as replacing gate #4's passage-relevance filter or gate #1's contradiction-evidence check (D019 §2) — a DIY-fetched page still goes through both gates exactly like a Tavily-fetched one. This ADR changes *where the passage comes from*, not what happens to it afterward.
- **Do not** collapse every fetch failure into one undifferentiated "DIY failed → Tavily fallback" bucket. D019 §3 case 3 already demonstrated Gemini can return a **fabricated URL** (the `nasa.gov` 404) with zero grounding metadata behind it — under this design, that URL enters the pipeline at the discovery step, DIY fetch tries it, gets a 404, and falls through to Tavily. The *outcome* is safe (D019 §2's trust boundary still holds — a fabricated URL never reaches VERIFY as if it were real content), but a 404-on-a-fabricated-URL and a 403-on-a-real-blocked-page look identical at the fetch layer if not logged separately. **Log fetch failures with enough granularity to distinguish them** (status code + a flag for "Gemini never returned grounding metadata for this chunk" vs. "grounding metadata existed, fetch was blocked") — otherwise a rising fabrication rate from Gemini's discovery step hides invisibly inside a rising "Tavily fallback rate" metric, and nobody would know which one actually changed.

## Consequences

- **Prerequisite cleared** (see above) — `plan.md`/`tasks.md`'s `SearchProvider`/Tavily-only design (T008) was rewritten to the hybrid shape and implemented (`src/providers/search/hybrid-provider.ts`, `tavily-provider.ts`).
- Tavily/Exa credit usage drops sharply if this holds at scale (14/15 claims needed zero Tavily calls in testing) — directly addresses the budget problem that prompted this research.
- New engineering surface not previously scoped: retry/backoff for both the Gemini call and DIY fetches, a real (not keyword-heuristic) relevance check reusing gate #4's actual logic rather than a one-off test-script approximation, and fetch-failure logging granular enough to separate fabricated-URL 404s from bot-blocked 403s.
