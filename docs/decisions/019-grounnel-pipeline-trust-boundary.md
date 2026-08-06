# D019 — Grounnel Data Pipeline: Stages, Trust Boundary, and the Native-Search Disqualification

One ADR, three parts: the pipeline itself (§1), the trust-boundary principle that governs every gate in it — named explicitly here for the first time rather than left as four isolated fixes (§2) — and the concrete evidence that disqualifies Gemini's native search tool as a retrieval option, which is what made the principle worth naming (§3). State storage (§4) is included since it followed directly from the same "what's independently checkable" question.

Source: SPEC-GROUNNEL v9 (pasted in conversation, not yet committed as a repo file) §2–§4a, §6a, §14, plus a live benchmark run against `gemini-2.5-flash-lite` on 2026-08-04 (this repo's `GEMINI_API_KEY`/`GEMINI_MODEL`), not yet moved into `evaluations/`.

---

## §1. Pipeline stages

**Decision**: one claim is the unit of work, same convention as D018 §2's audit pipeline, but with search replacing corpus retrieval:

```
paste text
  → EXTRACT (Gemini)                    claim list, written to state immediately
  → pre-search opinion filter (code)    drop non-factual claims → unverifiable, no search spent
  → one claim → one search (SearchProvider — Tavily/Exa for P0) — not topic-batched at P0 (§10 open question, deferred)
  → fetch top 2-3 URLs (provider-returned text, no custom readability build)
  → passage relevance filter (code)     drop passages missing the claim's own entities/numbers (lexical presence only — known gap, see §2)
  → VERIFY (Gemini, batched 5-10 claims per call, sharing passages)
  → deterministic gates (§2 below)
  → write verdict to state (§4)
```

`POST /extract` returns as soon as the claim list is written — before any search happens — so the client has a grey, unchecked, in-place-highlighted claim list to render immediately. `GET /status/:id` is the only read path: full current state, every poll, no delta/diff on the server side. Per-claim status stays `pending` / `done` / `failed`; the search/fetch/verify choreography inside `pending` is explicitly not part of the API contract, so P1 topic-batching can change it without touching the client.

**Why**: mirrors D018 §2's already-proven claim-as-unit-of-work shape, swapping RETRIEVE (closed corpus) for SEARCH (open web) — no new pipeline philosophy, same batching convention (5-10/call), same append-only rule (each stage consumes the frozen output of the last).

**Do not**: batch claims by topic before measuring cost/quality on real pasted prose (§10, deferred to P1). Let the search/fetch/batching strategy leak into the API contract — it stays a `pending`-internal implementation detail by design.

**Consequences**: the API surface (`/extract`, `/status/:id`) can absorb a P1 orchestration rewrite (topic batching, WebSockets) without a client-visible break. Search quota (§4.1, low-thousands/month free tier) is the tightest real constraint — tighter than Gemini's own rate limits — so caps-and-`not_checked` (never silently absorbed into a verdict bucket) apply from P0.

---

## §2. Trust boundary — nothing is trusted unchecked

**Decision**: every tool in the pipeline — the search API and the LLM alike — is a source of *claims about the world*, not a source of truth. Nothing is trusted just because it came back correctly formatted; every tool output gets checked against something independent before it can produce a colored verdict. This is not new mechanics — it's the retroactive, explicit name for what the four gates in SPEC-GROUNNEL §4a already do, scattered across the spec as four separate items instead of stated once:

| Tool | What it claims | What independently double-checks it |
|---|---|---|
| Search/fetch (Tavily/Exa) | "this passage is relevant to your claim" | Passage relevance pre-filter — code checks the claim's own entities/numbers are actually present in the passage before it's sent to VERIFY |
| VERIFY (Gemini) | "here's a verdict + a quoted passage" | Contradiction evidence gate — code checks the quote is a real substring of the passage that was actually fetched, not the model's self-report |
| VERIFY (Gemini) | "here's the number comparison result" | Numeric normalization/comparison in code — arithmetic never trusted as model reasoning, same rule D018 §2.3 already established for the B2B engine |
| EXTRACT (Gemini) | "this is a checkable factual claim" | Pre-search opinion filter — cheap rule-based check before a search call is spent on something EXTRACT may have mis-tagged |

**The load-bearing requirement, not previously stated**: this only works when there is a genuinely independent artifact to check a tool's output against. The passage-relevance and contradiction-evidence gates work against Tavily/Exa specifically because Tavily/Exa hands back real, held passage text — that text is the second party. A gate has nothing to invoke without one.

**Why**: every production false-contradiction bug in the B2B engine (D018 §5) was fixed by moving a judgment out of the LLM and into code once the LLM's self-report proved unreliable — row-matching, period-matching, numeric normalization, contradiction-vocabulary detection. Grounnel applies the same lesson from day one instead of re-discovering it through incidents. Naming it as one rule (rather than four independent-looking gates) means a future decision — query-rewrite design, a retrieval-provider swap — gets checked against "is there an independent artifact this can be verified against," instead of being evaluated as an isolated choice each time.

**Do not**: add a gate that checks a tool's output against another opinion from the *same* tool (e.g., asking VERIFY to re-confirm its own quote) — that is not a second party, it's the same untrusted source checked against itself, which is precisely why §3 disqualifies native search.

**Open gap, not yet closed**: the passage relevance filter's current rule (claim's own entities/numbers present as a substring in the passage) is a lexical check only. A passage that legitimately discusses the claim's subject through pronoun reference or coreference — never repeating the name after its first sentence — will be wrongly dropped by this rule. No fix is adopted here; naming the gap is preferable to hedged wording ("...unless linked through coreference") that implies a mechanism exists when none has been designed. Coreference resolution is a real NLP problem, not a one-line rule change, and reaching for a model call to solve it would reintroduce exactly the kind of unchecked LLM judgment this section exists to keep out of a "cheap deterministic gate." Left open for a future ADR once real pasted-article false-negative data exists to design against.

**Provider abstraction scope**: the search/fetch layer (§1) is consumed behind a narrow `SearchProvider` interface — this ADR and future ones define required behavior (return relevant passage text for a query), not a specific vendor's API, unless a vendor-specific limitation materially affects the architecture (as §3 does for Gemini's native search). This scoping applies to the search/cache layer only — it does not extend to EXTRACT/VERIFY's gates, which are deliberately shaped around what Gemini's specific response does and doesn't contain, and would need re-deriving, not just re-pointing, for a different model provider.

**Consequences**: this is the standing test for any future provider or architecture change in this pipeline — not just the four gates that already exist.

---

## §3. Native Gemini search (Option C) — disqualified, not merely lower-quality

**Decision**: Tavily/Exa (SPEC-GROUNNEL §4.1) is retrieval for P0. Gemini's built-in `google_search` grounding tool is **not** used for RETRIEVE, and this is closed as a structural disqualification under §2, not a "revisit if quality improves" open item.

**Evidence** (live run, `gemini-2.5-flash-lite`, `google_search` tool enabled, 2026-08-04 — 5-claim set: Eiffel Tower height/completion year, Everest 2020 remeasurement, Great Wall visibility myth, banana radioactivity):

1. **Batched (5 claims, 1 call)**: search never fired. Zero `groundingChunks`, zero `webSearchQueries`, no search-tool tokens in `usageMetadata` — despite an explicit "you MUST call search, never answer from memory" instruction. Confirmed this wasn't a wiring bug by re-running the same call shape against a time-sensitive query (today's date / gold spot price), which returned full grounding metadata.
2. **Per-claim (1 call per claim, matching the pipeline's actual one-claim-one-search shape)**: search queries fired for all 5, but `groundingChunks` (the only citable material in the response) came back empty for 2 of 5. Where chunks existed, each contained only a bare domain-as-title and a `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URI — no snippet, no retrievable passage text, ever.
3. **Asking explicitly for a direct URL and a verbatim-or-null quote made it worse, not better**: one claim ("Great Wall visible from space") came back `verdict: contradicted`, a fully-formed verbatim-looking quote, and a specific, official-sounding `nasa.gov` URL — with **zero grounding metadata** (no queries, no chunks) behind it. Fetched that exact URL directly: `404`, on a domain otherwise live (`nasa.gov` root returns `200`). A confident, correctly-formatted, non-existent citation, on the one color that's supposed to require a real quoted passage.
4. Where a real grounding redirect existed, it did resolve to genuine third-party content (confirmed by following one to a live radiation-info page) — the underlying search index is real — but that page, like another cited source, returned `403` to a direct fetch (browser user-agent included), i.e. bot-blocked. That is exactly the extraction problem Tavily/Exa are paid to solve (§4.1); recovering it ourselves would mean rebuilding the custom fetch+readability layer §4.1 explicitly avoids.

**Why disqualified, precisely**: under §2, the contradiction-evidence gate needs an independent artifact — real passage text held outside the model's own report — to check `evidence` against. Gemini's native search response contains no such artifact: no snippet, only a redirect link and a title, and the model will fabricate a plausible, well-formatted, fully-fake citation to fill the gap when the real grounding is thin (case 3, above) rather than degrade to `unverifiable`. This is not "Option C is lower quality than Tavily" — it's that "don't trust anyone, recheck everyone" has no second party to invoke against Option C's response shape. Tavily/Exa's fetched page text is that second party; nothing plays that role for native search. This is an architectural incompatibility with §2, not a quality gap: even a hypothetically flawless native-search response — perfect verdicts, no fabrication — would still not contain the independently-held passage text the trust boundary requires, so it remains disqualified regardless of any future improvement to Gemini's search quality.

**Do not**: revisit Option C on the basis of prompt tuning — case 3 shows a more explicit prompt produced a *more* convincing fabrication, not a fix. Follow grounding redirect URIs as a substitute fetch source without accounting for the same bot-blocking Tavily/Exa already solve — this is not a cheaper path to the same gate.

**Consequences**: closes the open benchmark item from SPEC-GROUNNEL's Gemini-search-benchmark note as a resolved, negative result. No change to §4.1's provider choice.

---

## §4. State store — Redis only, no Postgres

**Decision (P0)**: audit state is stored only in Redis, treated as **ephemeral execution state**, not product storage — a scoped choice for the current phase, not a permanent rejection of Postgres. Reintroduce Postgres if persistent history, analytics, multi-user features, or long-lived shareable reports become actual product requirements; none of those are P0 requirements today. The organizing principle: Redis holds the state a running audit needs to progress and answer polls; Postgres, if it ever arrives, would hold product-durable records — the two are different tiers for different lifetimes, not competing choices for the same job.

Implementation: the same Upstash Redis store already provisioned for the search/fetch cache (SPEC-GROUNNEL §6a), as one **hash per audit** (`audit:{id}`) with one field per claim plus a `meta` field for top-level status/progress, not one JSON blob:

```
HSET audit:{id} claim:{claimId} '{"text":...,"verdict":...,"evidence":...,"sources":[...]}'
HSET audit:{id} meta '{"status":"verifying","progress":{"checked":14,"total":55}}'
GET /status/:id  →  one HGETALL audit:{id}, assembled into the response shape in code
```

**Why**: `GET /status/:id`'s response is already one self-contained object per audit (§3b) — nothing relational leaks into the API. A single JSON blob would need read-modify-write on every batch completion, which races: two batches finishing close together can each `GET` the same stale blob and the later `SET` silently drops the first batch's verdicts. Per-claim hash fields give the same per-row independence Postgres's `UPDATE ... WHERE claim_id = ...` gave for free, without adding a second datastore. One Upstash REST call either way (`HSET` per claim write, one `HGETALL` per poll) — no change to the request-budget assumptions already in §4.2/§6a. A TTL of roughly 24h–30 days on `audit:{id}` comfortably covers both the P0 one-shot flow and a time-limited `/g/:id` shareable-result-page (§14) without needing Postgres — only a requirement for a *permanent*, never-expiring shareable link would actually force it, which is a real, nameable trigger rather than a vague "might need this later." Redis-restart durability (an in-flight audit vanishing on infra restart) is deliberately not hardened against here — MVP already depends on Tavily, Gemini, and Vercel all staying up, and none of those are being hardened against either; singling out Redis for extra durability engineering would be inconsistent effort allocation, not risk management.

**Do not**: read-modify-write a single-key JSON blob for audit state. Let the audit-state TTL collide with the search/fetch cache's own TTL — set it deliberately, not whatever Redis defaults to. Treat this decision as a permanent architecture choice — it's scoped to P0 and reopens on the named triggers above.

**Consequences**: Postgres is fully removed from P0 scope, on the criteria stated in the Decision above — not by default, and not permanently.
