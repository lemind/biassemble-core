# SPEC-GROUNNEL v10 — MVP

**Status:** MVP build spec
**Supersedes:** v4, v5, v6, v7, v8, v9
**Changes from v9:** syncs the spec to D019 (the ADR this conversation produced,
cross-reviewed twice, corrections applied). Five changes: (1) `SearchProvider` replaces
hard-coded "Tavily/Exa" as the architectural term throughout — vendor choice is now
explicitly configuration, not architecture (§4.1); (2) §4a is reframed around one named
governing principle, **the trust boundary** ("nothing is trusted unchecked"), with the
four gates as its instances rather than four unrelated fixes; (3) native Gemini search
(Option C) is formally closed as **disqualified by the trust boundary**, not merely
lower-quality — with the real benchmark evidence that produced that finding; (4) §6a is
rewritten: **Redis only, no Postgres, for P0** — audit state as ephemeral execution
state, with named, checkable triggers for when Postgres would actually be reintroduced;
(5) the passage-relevance gate's coreference/pronoun gap is named as an explicit open
issue rather than silently left as a latent bug.

**Erratum (found during an automated consistency review, 2026-08-05, corrected in place):**
two internal self-contradictions from the original v10 text, not a decision change —
§2's flow diagram said "batch claims by topic" where §4.3 (a few hundred lines later, in
this same original text) already said "Not in P0 ... one claim → one search"; and §3b's
example response had `progress.total: 55` next to `score.eligible: 85` with buckets
summing to 85, i.e. two different totals for the same claim count in one example. Both
were transcription/arithmetic errors in the document as originally written, not a
reflection of any decision being reopened — everything else in this file is unchanged
and still reflects v10 as written, kept frozen per `spec.md`'s header.

---

## 1. What it is

> Paste any text. Every factual claim gets checked against the web. Claims light up
> green / yellow / orange / red as results come in. One score at the top.

Canonical MVP input: **a Wikipedia article pasted into a box.**

No login. No upload. One textarea, one button.

---

## 2. The flow

```
paste text
   ↓
EXTRACT  →  claim list appears immediately (grey, unchecked)
   ↓
[NEW] pre-search filter — drop non-factual/opinion claims before they cost a search call
   ↓
one claim → one search (not topic-batched at P0 — see §4.3; this line previously said
"batch claims by topic," contradicting §4.3 below in the original text — erratum, see Changelog)
   ↓
per claim:  SEARCH → FETCH → VERIFY (batched only at the VERIFY step, 5-10 claims/call — §5)
   ↓
[NEW] deterministic gates on VERIFY output (see §4a)
   ↓
FE polls GET /status/:id every 10s — reads current state
   ↓
claims turn green/yellow/orange/red live
   ↓
score updates as denominator fills
   ↓
click any claim → evidence + source links
```

The claim list appearing **before** any verification is deliberate — the user sees the
product working in ~3 seconds instead of staring at a spinner for two minutes. This
live, step-by-step reveal (claims streaming in, score updating as the denominator fills)
is a structural product requirement, not optional polish — it is the entire point of
EXTRACT-first, batch-streamed-after. The only thing genuinely undecided is whether the
top-line score number updates continuously or holds until the run completes (§10).

---

## 3. What changes from the B2B engine

| Stage | Status |
|---|---|
| EXTRACT | Reused **as logic/prompt**, called directly against Gemini — not proxied through Biassemble's `/audit` endpoint. See §3a. |
| RETRIEVE | **Replaced.** `stub-lexical` over submitted sources → web search + fetch |
| VERIFY | Reused **as logic/prompt**, called directly against Gemini, same batching convention (5-10 claims). See §3a and §4a. |
| Reconcilers | Reused, ported into Grounnel's own code. Fire less often (web prose is unstructured) but still fire on numerics — this is where they matter most. |
| GATE | Reused |
| Scoring | Reused. Contradictions never netted, denominators shown |

### 3a. Why Grounnel does not call the Biassemble `/audit` API

Grounnel does not have `sources[]` at claim-extraction time — that's the entire premise
of the product (open-world search happens *after* claims are known, not before).
Biassemble's existing `/audit` endpoint requires `sources[]` up front and returns a
single coupled EXTRACT+RETRIEVE+VERIFY result. Routing Grounnel through that endpoint
would mean calling it once with `sources: []` just to get EXTRACT's claim list (forcing
a wasted VERIFY-against-nothing pass every time), then again per batch once real web
passages are fetched (EXTRACT re-run redundantly, since the endpoint always runs the
full pipeline) — and would make Grounnel's uptime and latency depend on Biassemble-
core's own queue depth and Gemini quota, an unnecessary shared point of failure between
two products with different traffic shapes.

**Decision: `/audit` stays exactly as-is** for callers who already have `sources[]` (the
B2B case, unchanged). **Biassemble-core exposes a second, new API surface** for the
Grounnel case, sharing the underlying EXTRACT/VERIFY prompt logic and the deterministic
gates (§4a) as actual shared code within core. **There is no separate Grounnel backend
service.** Once core natively handles the no-sources-yet case (`/extract` does its own
search/fetch internally per §3b), a Grounnel-side proxy would add a network hop that
does no actual work — Grounnel's frontend calls core's new endpoints directly. Grounnel
is a frontend on Biassemble-core, not a second backend calling into a first one.

### 3b. The new core API surface: `POST /extract` + `GET /status/:id`

Two calls. No exposed choreography beyond that.

**`POST /extract`** (called directly by Grounnel's frontend, no intermediary)
```
Request:  { text: "<pasted text>", options: { maxClaims } }
Response: 202 { id: "uuid" }
```
Runs EXTRACT (and the pre-search opinion filter, §4a #3) against the pasted text, writes
the initial claim list to state (§6a) with every claim `status: "pending"`, `verdict:
null`, and returns immediately. This is what makes the "claim list appears in ~3
seconds, grey and unchecked" requirement (§2) possible — the client has something to
render before any search or verify work has happened at all.

Internally, once the claim list is written, core's own orchestration takes over: query
rewrite → search → fetch → passage relevance filter (§4a #4) → VERIFY → deterministic
gates (§4a #1, #2) → write verdict back to the claim's row. **How this orchestration is
structured — one claim at a time, batched by topic, sequential or parallel — is entirely
a BE-internal implementation detail and is not part of the API contract.** This is
deliberate: it means core's batching/orchestration strategy can change in P1 (e.g.
adding topic batching per §4.3) without ever touching the shape FE depends on.

**`GET /status/:id`** — the only polling endpoint, called directly by Grounnel's
frontend on a fixed interval, **every 10 seconds** for P0. No delta/changed-only variant —
every poll returns the **full current state of every claim**, identically shaped
whether or not anything changed since the last poll. This is deliberate simplicity: at
MVP scale (tens of claims, 10s interval) the bandwidth cost of always sending everything
is negligible, and it avoids an entire class of cache-invalidation/missed-delta bugs. If
FE wants to animate a claim's transition from grey to colored, that's a client-side diff
against its own last-received object — the server does no diffing and tracks no "since"
state per client.

```
Response: 200 {
  id: "uuid",
  status: "extracting" | "verifying" | "done" | "failed",
  progress: { checked: 14, total: 85 },  // was 55 in the original text — didn't match score.eligible below; erratum, see Changelog
  claims: [
    {
      id: "uuid",
      text: "...",
      status: "pending" | "done" | "failed",
      verdict: null | "supported" | "partially_supported" |
               "unsupported" | "contradicted" | "unverifiable",
      evidence: null | "verbatim quoted passage",
      sources: [ { title, domain, url } ]
    },
    ...
  ],
  score: {
    grounded_pct: 23, grounded_n: 20,
    unclear_n: 31, no_evidence_n: 28, contradicted_n: 6,
    not_checked_n: 0,
    eligible: 85
  },
  caps_hit: false
}
```

Field notes:
- `status` (top-level) is coarse and exists only for FE's overall label/spinner —
  "extracting" vs "verifying" vs "done." It does **not** attempt to describe per-claim
  progress; that's what `claims[].status` and `progress` are for.
- `claims[].status` is deliberately minimal: `pending` (still somewhere in the
  pipeline — search, fetch, and verify are not distinguished, because FE doesn't need
  to know which), `done` (verdict populated, color it), `failed` (batch died, render as
  `not checked` per the non-negotiables in §13, never silently dropped).
- `score` is computed by core on every poll from the claims currently in state — cheap,
  since it's just a count over rows already being returned in the same response — so FE
  never has to compute it client-side, and it's always consistent with the `claims[]`
  array in the same response.
- `not_checked_n` stays a distinct field, never folded into any of the four verdict
  buckets, per §13.
- `caps_hit` is a plain boolean so FE can show a "stopped at N claims" notice per §4.2,
  without FE having to infer it from `progress.total` being suspiciously round.

### 3c. Rate limiting on `/extract` — P0 requirement, not a show-off item

`/extract` is now a public-facing endpoint that, per call, triggers roughly one claim's
worth of Gemini usage immediately and up to ~85 downstream search + fetch + VERIFY calls
over the following minutes (§4.1). Unlike `/audit`, which is a B2B integration behind an
API key and presumably reasonable per-customer usage, `/extract` is reachable from
Grounnel's public paste-box frontend with no auth. Without a limit, one shared link or
one bot submitting repeatedly can burn the entire monthly search quota (§4.1's already-
identified tightest constraint) or run up Gemini cost in a single afternoon.

This is not infrastructure for its own sake — it is the one gap between "MVP" and "MVP
that can be accidentally or maliciously exhausted." Simple IP-based or session-based
rate limiting (e.g. N submissions per IP per hour) is cheap to implement on Vercel and
should ship at P0, not be deferred alongside the genuinely optional items in §14.

---

## 4. SEARCH — the new stage, and most of MVP complexity

```
claim
  ↓
[NEW] pre-search filter — is this claim even checkable? (see §4a)
  ↓
query rewrite        — strip hedges, keep entities + assertion
  ↓
search               — SearchProvider (Tavily or Exa for P0; see §4.1)
  ↓
result reranking     — pick best 2-3 URLs
  ↓
fetch + clean HTML   — provider returns ready text; own fetch = readability extract
  ↓
[NEW] passage relevance pre-filter (see §4a — known gap noted there)
  ↓
split passages
  ↓
retrieve relevant passages
  ↓
VERIFY               — same prompt contract as before, source_refs = real URLs
  ↓
[NEW] deterministic output gates (see §4a)
```

**Search quality dominates everything.** If search returns poor pages, VERIFY cannot
recover. The retrieval step is the actual quality bottleneck — VERIFY is the product
surface the user sees, but search is what determines whether it works.

### 4.1 MVP: SearchProvider — Tavily or Exa for P0

Do not build custom fetch + readability + cleaning for MVP. Tavily and Exa return
pre-extracted text. Swap later.

**Architecture, not vendor.** Search/fetch is consumed behind a narrow `SearchProvider`
interface — the codebase, and any future ADR, defines *required behavior* (return
relevant passage text for a query), never a specific vendor's API. This is deliberate:
changing providers should be a configuration decision, not another architecture change.
The one exception is when a vendor-specific limitation materially affects the
architecture itself — see §4.1a, where this is exactly what happened.

```
SEARCH
  ↓
SearchProvider (interface)
  ↓
  ├─ Tavily
  ├─ Exa
  ├─ Google CSE
  └─ internal search (future)
```

Everything downstream of SEARCH (fetch, passage filter, VERIFY, gates, scoring, UI)
stays identical regardless of which implementation sits behind the interface.

**Search quota is the tightest real constraint at zero-cost tier** — tighter than Vercel
compute, tighter than Gemini's own rate limits in practice. Free-tier search APIs are
commonly capped in the low thousands of calls per month; an 85-claim document burns
~85 calls in one run. Size expectations (documents/month at $0 spend) against the actual
provider quota before assuming MVP traffic is unconstrained — this is a monthly-volume
ceiling, not primarily a concurrency ceiling.

### 4.1a Native Gemini search (Option C) — disqualified, evidence recorded

Before committing to Tavily/Exa as the `SearchProvider` implementation, Gemini's own
built-in `google_search` grounding tool was benchmarked as a candidate — same model
(`gemini-2.5-flash-lite`) already used elsewhere in this pipeline, replacing the entire
search+fetch+clean stage with one native tool call. **Disqualified, and closed as a
structural finding, not a "revisit later" open item.**

Live benchmark (2026-08-04, 5-claim set: Eiffel Tower height/completion year, Everest
2020 remeasurement, Great Wall visibility myth, banana radioactivity):

1. **Batched (5 claims, 1 call):** search never fired — zero `groundingChunks`, zero
   `webSearchQueries`, despite an explicit "you MUST call search" instruction. Confirmed
   not a wiring bug via a control call (today's date / gold price) that returned full
   grounding metadata on the same call shape.
2. **Per-claim (1 call per claim, matching this spec's actual one-claim-one-search
   architecture):** search fired for all 5, but `groundingChunks` — the only citable
   material in the response — was empty for 2 of 5. Where present, each chunk contained
   only a bare domain-as-title and an opaque
   `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URI. No snippet, no
   retrievable passage text, ever, in any response.
3. **Asking explicitly for a direct URL and a verbatim-or-null quote made it worse, not
   better:** one claim came back `verdict: contradicted`, a fully-formed verbatim-
   looking quote, and a specific, official-sounding `nasa.gov` URL — with zero grounding
   metadata behind it. That exact URL: `404`, on a domain otherwise live. A confident,
   correctly-formatted, non-existent citation, on the one verdict that's supposed to
   require a real quoted passage.

**Why this is disqualified, precisely** (full reasoning and the governing rule this
follows from is §4a's trust boundary, below): the contradiction-evidence gate needs an
independent artifact — real passage text held outside the model's own report — to check
`evidence` against. Native search's response contains no such artifact, and under
pressure to look complete, the model fabricates one rather than degrading to
`unverifiable`. **This is an architectural incompatibility, not a quality gap** — even a
hypothetically flawless native-search response would still not contain the
independently-held passage text the trust boundary requires, so this does not reopen if
Gemini's search quality improves in a future model version. It would only reopen if the
API's *response shape* changed to include independently-held passage text — a different
and separate question from quality.

**Do not** revisit this on the basis of prompt tuning — a more explicit prompt produced
a *more* convincing fabrication in testing, not a fix. Do not use the grounding redirect
URIs as a substitute fetch source without accounting for bot-blocking (§4.1a evidence
point 4 in the source ADR) — that reintroduces exactly the custom-fetch problem §4.1
already avoids paying for.

### 4.2 Cost and caps

85 claims × 1 search = ~85 API calls per document. Cache search results by normalized
query and fetched pages by URL hash — both across users, via Redis (§6a).

Cap per-document: max claims, max searches. Exceed → verify the first N, mark the rest
`not checked` explicitly. Never silently inflate the score.

`not checked` is a distinct UI state, never folded into any verdict bucket.

### 4.3 Topic batching

**Not in P0.** Grouping claims by entity before searching introduces an NLP problem
before you have data to know if it's necessary. Run one claim → one search first, measure
actual cost and quality, optimize after. Add batching in P1 if measurements justify it.

### 4.4 Fetch failures

A source we couldn't read is never scored as if we read it. `paywalled` / `unreachable`
/ `blocked` counted, shown, excluded from Eligible.

### 4a. The trust boundary — nothing is trusted unchecked

**Governing principle, named explicitly rather than left as four unrelated fixes:**
every tool in this pipeline — the search provider and the LLM alike — is a source of
*claims about the world*, not a source of truth. Nothing is trusted just because it came
back correctly formatted; every tool output gets checked against something independent
before it can produce a colored verdict. This principle is drawn directly from
Biassemble-core's production bug history: every false-contradiction bug in the B2B
engine was fixed by moving a judgment out of the LLM and into code once the LLM's
self-report proved unreliable — row-matching, period-matching, numeric normalization,
contradiction-vocabulary detection. Grounnel applies the lesson from day one instead of
re-discovering it through incidents.

| Tool | What it claims | What independently double-checks it |
|---|---|---|
| SearchProvider | "this passage is relevant to your claim" | Passage relevance pre-filter (#4 below) |
| VERIFY (Gemini) | "here's a verdict + a quoted passage" | Contradiction evidence gate (#1 below) |
| VERIFY (Gemini) | "here's the number comparison result" | Numeric normalization in code (#2 below) |
| EXTRACT (Gemini) | "this is a checkable factual claim" | Pre-search opinion filter (#3 below) |

**The load-bearing requirement:** this only works when there is a genuinely independent
artifact to check a tool's output against. The passage-relevance and contradiction-
evidence gates work against Tavily/Exa specifically because the provider hands back
real, held passage text — that text is the second party. A gate has nothing to invoke
without one. This is precisely why §4.1a disqualifies native Gemini search: its response
contains no independent artifact, so the trust boundary has nothing to check it against.

**Do not** add a gate that checks a tool's output against another opinion from the
*same* tool (e.g. asking VERIFY to re-confirm its own quote) — that is not a second
party, it's the same untrusted source checked against itself.

**This is explicitly not** a proposal to train or host a replacement model for EXTRACT
or VERIFY. There is no training data (a handful of hand-checked test cases is not a
golden set) and no MVP justification for that scope — that remains P3 ("own fine-tuned
model replacing Gemini for VERIFY," gated on having confirmed-verdict training examples
at volume). What follows is deterministic *code around* the existing Gemini calls, not a
model to replace them.

Four gates, ordered cheapest-to-build-first:

1. **Contradiction evidence gate.** If VERIFY returns `verdict: contradicted`, code
   checks that the `evidence` field is non-empty and is an actual substring (or close
   match) of the fetched passage actually sent to the model. If the check fails, the
   verdict is force-downgraded to `unsupported` before it ever reaches the client. Directly
   prevents the "unqualified contradiction regex" failure class already found once in
   B2B. Near-zero implementation cost — pure string containment check.

2. **Numeric normalization and comparison in code, never in the LLM.** Once VERIFY (or a
   pre-pass) extracts the two numbers being compared, the actual arithmetic comparison
   (equal / inverted / wrong scale / wrong period) happens in code, not as model
   reasoning. This is a direct port of an existing, already-proven B2B rule ("numeric
   normalization in code, never LLM") and the exact mechanism that fixed all three
   root-caused false-`contradicted` bugs in the B2B engine.

3. **Pre-search opinion/non-factual filter.** Before a claim ever reaches SEARCH, a cheap
   check (rule-based first; only reach for a model call if rules prove insufficient in
   testing) screens out claims with no checkable referent — value judgments,
   predictions, vague intensifiers ("really strong quarter"). These route straight to
   `unverifiable` without spending a search call. Directly protects the tightest real
   MVP constraint (search quota, §4.1).

4. **Passage relevance pre-filter.** Before a fetched passage is sent to VERIFY, a cheap
   check confirms it actually contains at least one of the claim's key entities or
   numbers as a substring. Passages that don't are dropped before the VERIFY call. This
   is a free correctness gate — sending an irrelevant passage to VERIFY is a direct path
   to a confidently wrong `unsupported` or spurious `supported` verdict.

   **Open gap, not yet closed:** this rule is lexical-presence only. A passage that
   legitimately discusses the claim's subject through pronoun reference or coreference —
   e.g. claim "Bukowski attended Los Angeles City College," passage "He studied there
   for two years," no entity ever repeated — will be wrongly dropped. No fix is adopted
   here. Naming the gap is preferable to hedged wording ("...unless linked through
   coreference") that implies a mechanism exists when none has been designed:
   coreference resolution is a real NLP problem, not a one-line rule change, and
   reaching for a model call to solve it would reintroduce exactly the kind of unchecked
   LLM judgment this section exists to keep out of what's supposed to be a cheap
   deterministic gate. Left open for a future ADR once real pasted-article false-
   negative data exists to design against.

Query rewrite (claim → search query) is a candidate for the same treatment
(rule-based-first: strip known hedge phrases, extract entities via lightweight NER,
fall back to an LLM call only if the rule-based pass is empty or clearly degenerate) but
is lower priority and needs real pasted-article data before the rule set can be
designed with any confidence — left as an open design question (§10), not a committed
gate.

**Validation gate #1 (contradiction evidence check) was informally exercised** against a
5-claim hand-built test (3 groundable, 1 opinion, 1 absent-not-contradicted) run directly
against Gemini 2.5-flash-lite: all 5 landed on the expected verdict, including the
critical inverted-number case (claim quoted the correct passage and reasoned "increase,
not decrease" correctly) and the absent-claim case (correctly returned `unsupported`,
not `contradicted`, for a fact the source never mentioned). This is a single manual run,
not a golden-set entry — promote it to one once the harness exists (§9).

---

## 5. Batching + streaming

**Batch size:** 5-10 claims per VERIFY call (matches existing pipeline convention).

**P0 — polling only, all on Vercel.** No Render migration required for P0 — see §11 for
the corrected reasoning (Vercel's Fluid Compute free tier now covers the pipeline's
existing wall-clock budget). Client polls `GET /status/:id` every 10 seconds (§3b),
receiving the full current state on every poll — no delta/changed-only variant, read
from Redis (§6a).

**P1 — WebSockets**, gated on an actual measured need (polling-induced lag, wasted
calls, or a concurrency ceiling actually being hit), not simply "Vercel". Requires the
Render migration (§11) since Vercel serverless functions cannot hold a persistent
connection open reliably regardless of duration limits. Contract:

```
→ { type: "claims",    claims: [{ id, text, span }] }        // immediately after EXTRACT
→ { type: "progress",  done: 12, total: 85 }
→ { type: "verdicts",  results: [{ id, verdict, confidence,
                                   evidence[], sources[] }] } // per batch
→ { type: "score",     grounded, uncertain, unsupported,
                       contradicted, not_checked, rate }      // recomputed per batch
→ { type: "done" }
→ { type: "error",     claim_ids[], reason }                  // batch failed, claims marked
```

A failed batch marks its claims `not checked` and **keeps going** in both P0 and P1.
One bad batch must never kill the run.

---

## 6. Colors

| Color | Verdict | Label shown |
|---|---|---|
| 🟢 Green | `supported` | Evidence found supporting this |
| 🟡 Yellow | `partially_supported` / `unverifiable` | Partly supported / unclear |
| 🟠 Orange | `unsupported` | **No evidence found** |
| 🔴 Red | `contradicted` | Sources say otherwise |
| ⬜ Grey | not checked / non-factual | — |

**Orange is the honest-labeling problem.** With open-world search, "unsupported" means
*our search didn't find it* — not *it's false*. Obscure-but-true claims will land orange
constantly. So:

- Orange label is literally **"No evidence found"** — never "unsupported," never "false."
- Orange tooltip states what was searched, so the user can see the attempt.
- Orange is **visually cooler than red**, not adjacent to it.
- Red requires an actual contradicting passage, quoted, and now additionally
  **verified programmatically by gate #1 (§4a)** before the client ever sees it. No
  passage → not red, enforced in code, not left to the model's own honesty about
  whether it complied with the prompt's instruction to quote.

Red is the only color that makes a claim *about the world*. Everything else is a claim
about our search. Keep that line sharp.

### 6a. State store — Redis only for P0, no Postgres

Vercel functions are stateless between invocations, so partial results (the whole point
of §2's live streaming) need a durable store outside the function runtime. This store
belongs to **Biassemble-core**, not to a separate Grounnel service (there isn't one,
§3a) — Grounnel's frontend never touches Redis directly, it only ever sees
`GET /status/:id` responses.

**Decision (P0): audit state is stored only in Upstash Redis, treated as ephemeral
execution state, not product storage** — a scoped choice for the current phase, not a
permanent rejection of Postgres. Reintroduce Postgres if persistent history, analytics,
multi-user features, or long-lived (permanent, non-expiring) shareable reports become
actual product requirements; none of those are P0 requirements today. The organizing
principle: Redis holds the state a running audit needs to progress and answer polls;
Postgres, if it ever arrives, would hold product-durable records — two different tiers
for different lifetimes, not competing choices for the same job.

Same Upstash Redis store already used for the search/fetch cache (§4.2) — one **hash
per audit** (`audit:{id}`), one field per claim plus a `meta` field for top-level
status/progress, not one JSON blob:

```
HSET audit:{id} claim:{claimId} '{"text":...,"verdict":...,"evidence":...,"sources":[...]}'
HSET audit:{id} meta '{"status":"verifying","progress":{"checked":14,"total":55}}'
GET /status/:id  →  one HGETALL audit:{id}, assembled into the response shape in code
```

**Why per-claim hash fields, not a single JSON blob:** `GET /status/:id`'s response is
already one self-contained object per audit (§3b) — nothing relational leaks into the
API. A single JSON blob would need read-modify-write on every batch completion, which
races: two batches finishing close together can each `GET` the same stale blob and the
later `SET` silently drops the first batch's verdicts. Per-claim hash fields give the
same per-row independence a relational `UPDATE ... WHERE claim_id = ...` would give, for
free, without adding a second datastore. One Upstash REST call either way (`HSET` per
claim write, one `HGETALL` per poll) — no change to the request-budget assumptions
already in §4.2.

**TTL:** roughly 24h–30 days on `audit:{id}` comfortably covers both the P0 one-shot
flow and a time-limited `/g/:id` shareable-result-page (§14) without needing Postgres —
only a requirement for a *permanent*, never-expiring shareable link would actually force
it, which is a real, nameable trigger rather than a vague "might need this later." Set
deliberately, distinct from the search/fetch cache's own TTL — don't let the two
collide by accident.

**On durability:** Redis-restart durability (an in-flight or completed audit vanishing
on infra restart) is deliberately not hardened against at P0. MVP already depends on
Tavily, Gemini, and Vercel all staying up, and none of those are being hardened against
either — singling out Redis for extra durability engineering here would be inconsistent
effort allocation, not real risk management.

Provisioned via Vercel Marketplace (`vercel install upstash`), credentials auto-injected
as environment variables — same free tier already used for the search/fetch cache
(§4.2): 30,000 requests/month, 10,000/day cap, 0.25 GB storage.

**Do not:** read-modify-write a single-key JSON blob for audit state. Let the audit-state
TTL collide with the search/fetch cache's TTL. Treat this as a permanent architecture
choice — it's scoped to P0 and reopens on the named triggers above, not by default and
not permanently.

---

## 7. Score

```
85 factual claims
🟢 20 grounded   🟡 31 unclear   🟠 28 no evidence found   🔴 6 contradicted
      Groundedness  23%   (20 / 85)
      Needs attention  65   (of 85)
```

- Contradictions **never netted** — always their own line.
- Every percentage with its denominator.
- `not checked` shown separately, never folded into any bucket.
- Headline number is groundedness; "needs attention" is the actionable one.
- Score is computed by Grounnel itself across all its own batch calls — Biassemble-
  core's own per-call `scores` block (grounded_rate, groundedness_score, etc., were
  Grounnel to call `/audit`) is not used; moot now that Grounnel calls Gemini directly
  (§3a) rather than proxying through that endpoint.

---

## 8. Click-through

Per claim: extracted claim · verdict · confidence · **the retrieved passage, verbatim** ·
source links (title + domain + URL) · one-line reason.

The passage and the links are the product. The color is navigation. A user who disagrees
must be able to click the source in one action and check us.

---

## 9. Known fixes (standard plumbing, detail in ADRs)

- **EXTRACT fails on no-number prose** — debug + partial-array salvage so one bad claim
  drops, not the list.
- **VERIFY malformed response ~1/5** — retry + mark batch failed and continue.
- **Retry stacking past the wall-clock budget** — per-stage time budget, fail clean.
  Budget itself needs re-checking against Grounnel's longer per-document runtime, but
  the existing 240s figure fits comfortably inside Vercel Fluid Compute's free-tier
  5-minute function window (§11) — this is tuning, not a blocking redesign.
- **[NEW] No golden-set harness yet for Grounnel specifically.** The 5-claim manual test
  in §4a was run by hand against raw Gemini output, not through any pipeline code, and
  is not repeatable/regression-checked. Before relying on the deterministic gates in
  §4a, build a small golden set (start from the same 5-claim shape: clean support,
  inverted-number contradiction, attribution, opinion, silent-absence) that runs against
  actual Grounnel pipeline code, not hand-pasted prompts.

## 10. Open design questions (resolve in ADRs, not here)

- **Query generation** — claim → search query. Candidate for rule-based-first / LLM-
  fallback (§4a) but needs prototyping on real prose before the rule set can be
  designed with confidence.
- **Topic-batching heuristic** — grouping claims by shared entity before searching is
  the main future cost lever, deferred to P1.
- **Source trust / ranking** — filter sources or show everything and let the user judge.
- **Score display during streaming** — live-updating or hold until complete. (Note: this
  is the only genuinely open part of "show groundedness step by step" — the per-claim
  color streaming itself is decided, §2.)

---

## 11. Deployment strategy

**Design rule, unchanged:** all orchestration (search, verify, future queue/worker
layers) stays deployment-agnostic. The platform can change without rewriting the
pipeline.

**P0 — Vercel only, frontend + backend, polling, no separate infra beyond Marketplace
storage (§6a).**

**Revised reasoning on Vercel viability** (this reverses the urgency implied in earlier
drafts of this spec): Vercel's Fluid Compute execution model is now default on new
deployments and materially changes the "Vercel can't do long-running work" assumption
this spec previously relied on —

- Free (Hobby) tier functions can run **up to 5 minutes** under Fluid Compute.
- Paid (Pro) tier extends to **800 seconds standard, 1800 seconds in beta**.

The existing `AUDIT_MAX_DURATION_MS` figure (240s) **fits inside the free tier**, not
just the paid tier. This means the original justification for an early Render move
("Vercel serverless wants 500ms requests, this pipeline runs 5+ minutes — those are
opposites") is weaker than stated: duration alone is not the blocker it was assumed to
be.

**What Vercel genuinely still cannot do, regardless of Fluid Compute:**
- No persistent in-memory worker processes between requests (Fluid Compute is
  concurrency *within* a function instance, not a standing process).
- No reliable long-lived WebSocket connections.
- Cold-start variance under bursty/concurrent load.

**Revised P1 trigger:** move the backend to Render when polling UX or concurrency
actually becomes a felt problem — not on a calendar assumption, and not simply because
a document takes a few minutes to audit (that case is already covered on the free
tier). This is a measured trigger, not a "pretty soon" default.

| Component | Introduce when... | Free-tier path | Spec anchor |
|---|---|---|---|
| **Render backend migration** | Vercel's actual remaining gaps (no standing workers, no real WebSockets, cold-start variance under real concurrent load) are hit in practice, not assumed in advance | Render free web service (spins down after 15 min idle — fine for low/no traffic, awkward for live demos immediately after idle) | §11 P1 |
| **WebSockets** | Only after Render migration; only once polling is measurably bad, not just theoretically inferior | Native on a standing Render process, no extra service needed | §5 P1 |
| **Redis (cache role)** | Now — already in P0 scope, see §6a | Upstash free tier via Vercel Marketplace | §4.2, §6a |
| **Queue (Kafka/RabbitMQ/Inngest)** | When batch orchestration genuinely outgrows a loop over async calls — real fan-out/retry/backoff complexity, not just "would be nice to have." The B2B architecture diagram already names **Inngest**, not a broker, as the intended queue layer — a Kafka/RabbitMQ move would be a deliberate deviation from that, not a natural next step, and is not driven by any current product need | Inngest free tier, works on both Vercel and Render | Explicitly out of scope for MVP; lowest-priority "show off" item |
| **Grafana / observability** | When real traffic volume makes eyeballing logs insufficient — trend visibility (search cost/claim, cache hit rate, per-stage failure rate) over time, not single-run debugging | Grafana Cloud free tier (limited retention) | Not in spec; pure post-MVP polish, lowest priority overall |

**Why this ordering matters:** every item in the "show off" category (Render, WebSockets,
a broker, Grafana) is real, useful engineering — but each was evaluated against actual
product need in this pass, not introduced because it's impressive. The zero-cost-MVP
goal and the "show off later, gated on need" goal are the same constraint stated two
ways: nothing above gets pulled forward without a concrete trigger being hit first.

```
P0:  Frontend (Vercel) → Backend API (Vercel, Fluid Compute) → Upstash Redis
P1:  Frontend (Vercel) → Backend API (Render) → Inngest (if justified) → Redis → WebSocket to frontend
```

## 12. Phasing

**P0 — the loop, on Vercel only, with polling.** Textarea → EXTRACT (direct Gemini call)
→ pre-search filter → one-claim-one-search → VERIFY (direct Gemini call) →
deterministic gates → polling → colored highlights → score → click-through evidence.
No topic batching, no WebSockets, no Render. Validate that the product is worth
building.

**P1 — migrate backend to Render (only once its trigger in §11 is actually hit), add
WebSockets, measure and optimize search.** Topic batching only if cost measurements
justify it. Span-level highlighting if stability measures ≥95%. Queue/broker layer only
if orchestration complexity genuinely demands it.

**P2 — inputs.** Doc upload, batch, PDF/DOCX/HTML.

**P3 — own fine-tuned model** replacing Gemini for VERIFY, once there is real training
data (confirmed verdicts at volume, not a 5-claim manual test). This remains the only
point in the roadmap where "our own model" is in scope — the deterministic gates in §4a
are code around Gemini, not a replacement for it, and are P0, not P3.

---

## 13. Non-negotiables carried forward

- Never "false," "wrong," "fabricated," "hallucinated."
- Every verdict shows its passage; every source is clickable.
- Orange ≠ red, visually and verbally.
- Contradictions never netted into the score.
- Sources we couldn't read are never scored as if we read them.
- Caps and failures are always visible, never silently absorbed into a bucket.
- **[NEW]** A `contradicted` verdict without a programmatically-verified quoted passage
  never reaches the client — enforced in code (§4a gate #1), not left to prompt
  compliance alone.

---

## 14. "Show off" architecture catalog — assessed, not adopted by default

This section exists so future temptation to add infrastructure (a broker, tracing,
dashboards, etc.) gets checked against a considered list rather than re-litigated from
scratch. Nothing here is adopted by simply appearing on this list — each item still
needs its own trigger to be hit (consistent with §11's trigger table for
Render/WebSockets/queue/Grafana, which this section extends rather than duplicates).

### Genuinely useful, cheap, do now (not really "show off" — basic hygiene)

- **Structured request tracing / correlation IDs.** Pass one `id` through every internal
  hop of a single `/extract` run — EXTRACT call, each search query, each fetch, each
  VERIFY batch — and log it consistently. When a claim comes back wrong, this is what
  lets you trace exactly which search query and which passage fed VERIFY, rather than
  guessing. Costs almost nothing to add now; expensive to retrofit once the pipeline has
  grown. Not infrastructure — just discipline in what gets logged and how.
- **Rate limiting on `/extract`.** Already promoted out of this catalog into §3c as an
  actual P0 requirement — listed here only for completeness of the "what did we
  consider" record.

### Useful middle ground — worth it if you want something to point at, optional otherwise

- **A tiny internal metrics endpoint** (e.g. `GET /internal/metrics`) reading straight
  from the existing Redis state — total search calls made, cache hit rate, average
  claims per document, `not_checked` rate. No Grafana, no separate metrics pipeline,
  just a read over data that already exists. This is a legitimate "we measure what we
  build" artifact without owning any dashboard infrastructure. Reasonable to add once
  §3c's rate limiting is in place, since at that point you likely want visibility into
  what the limits are actually catching.
- **A read-only shareable result page** (e.g. `/g/:id` showing a completed audit).
  Product-useful rather than an engineering flex — cheap now that state already lives in
  Redis (§6a) for the TTL window, and gives something demoable without any new
  architecture. Worth considering as a product feature on its own merits, separate from
  the "show off" framing entirely. A *permanent* (non-expiring) version of this page is
  the one named trigger that would pull Postgres back into scope (§6a).

### Decorative at current scale — skip, revisit only if the trigger is genuinely hit

- **Grafana Cloud dashboard.** Useful once there's real traffic and trends worth
  watching over time; decorative before that, since eyeballing logs or the metrics
  endpoint above is entirely sufficient at MVP volume. Already listed in §11's trigger
  table — not duplicated as a separate decision here.
- **A message broker (Kafka / RabbitMQ).** Actively fights the current architecture: the
  B2B system's own diagram already names Inngest, not a broker, as the intended future
  queue layer (§11), and there is no fan-out/retry/backoff complexity today that a
  broker would meaningfully improve on. Skip regardless of "show off" appeal — this was
  already reasoned through in §11 and stands.
- **OpenTelemetry / distributed tracing.** Built for cross-service hops. Now that
  Grounnel has no separate backend of its own (§3a) — it's one frontend calling one
  service's two endpoints — there is no second service to trace *between*. The simple
  correlation-ID logging above covers the actual debugging need at this scale;
  full distributed tracing would be solving a topology problem that no longer exists.
- **WebSockets, Render migration, queue/worker infra generally.** Already covered by
  §11's trigger table; restated here only to keep this catalog complete as the single
  place to check before reaching for any of it.

---

## Changelog

**v10** — syncs the spec to D019 (the ADR produced and cross-reviewed twice in this
project's history). `SearchProvider` replaces hard-coded "Tavily/Exa" as the
architectural term (§4.1) — vendor choice is now explicitly configuration, not
architecture, with the narrow exception carved out in §4.1a. §4a is reframed around one
named governing principle, **the trust boundary** ("nothing is trusted unchecked"),
with the four gates presented as its instances rather than four unrelated fixes.
Native Gemini search (Option C) is formally closed as **disqualified by the trust
boundary, not merely lower-quality** (§4.1a) — with the real benchmark evidence
(batched search never firing, empty grounding chunks, and a fabricated `nasa.gov`
citation under a stricter prompt) that produced the finding, and an explicit note that
this does not reopen on future model-quality improvements, only on a response-shape
change. §6a is rewritten: **Redis only, no Postgres, for P0** — audit state as
ephemeral execution state with named, checkable triggers (persistent history,
analytics, multi-user, or a *permanent* shareable link) for when Postgres would
actually be reintroduced, replacing the earlier Neon Postgres + Redis split. The
passage-relevance gate's coreference/pronoun gap (a legitimate false-negative case,
e.g. "he studied there" with no repeated entity) is named as an explicit open issue
with no adopted fix, rather than papered over with hedged wording that implied a
mechanism existed. Stale `/grounnel/:id` and Neon Postgres references elsewhere in the
doc (§3b, §5, §11 diagram) corrected to match.

**v9** — collapses the architecture further: confirms Grounnel has no separate backend
service at all (§3a) — it is a frontend calling Biassemble-core's `/extract` and
`/status/:id` directly, with no proxy hop in between. Redis and Postgres (§6a) are
explicitly core-internal; Grounnel's frontend never touches either. Adds §3c, promoting
rate limiting on `/extract` from a "nice to have" into an actual P0 requirement, since
the endpoint is now public-facing and cost-incurring with no auth. Adds §14, a full
assessed catalog of "show off" / extra-architecture options — sorted into do-now hygiene
(tracing/correlation IDs), optional middle ground (internal metrics endpoint, shareable
result page), and decorative-skip-for-now (Grafana, a broker, OpenTelemetry) — so the
temptation to add infrastructure for its own sake has a considered answer to check
against rather than being re-argued each time it comes up.

**v8** — resolves the FE/BE API contract. Biassemble-core gains a second API surface
(`POST /extract` + `GET /status/:id`) alongside the unchanged `/audit` endpoint —
`/audit` continues to serve callers who supply `sources[]` up front (B2B case);
Grounnel's new surface serves the case where claims are known before sources are. The
new surface exposes exactly two calls: one to kick off EXTRACT and get an immediate,
grey, unchecked claim list; one to poll full current state (claims, progress, score) on
a fixed 10-second interval, always returning the complete object, never a delta —
FE-side diffing, not server-side, is responsible for any transition animation. Per-claim
status is deliberately reduced to `pending` / `done` / `failed`; the actual
search/fetch/verify choreography and batching strategy stays a backend-internal
implementation detail, explicitly not part of the API contract, so it can change
(e.g. topic batching in P1) without touching FE.

**v7** — resolves three previously-open implementation questions from v6 into committed
decisions: (1) Grounnel calls Gemini directly for EXTRACT/VERIFY rather than proxying
through Biassemble's `/audit` endpoint, since that endpoint requires `sources[]` up
front and Grounnel doesn't have them until after search; (2) state storage is Neon
Postgres (audit/claim state, FE polling target) + Upstash Redis (cache only, per
existing §4.2 scope) via Vercel Marketplace, both free tier; (3) adds a deterministic
code layer around EXTRACT/VERIFY (contradiction evidence gate, numeric comparison in
code, pre-search opinion filter, passage relevance filter) directly modeled on B2B's
proven bug-fix pattern, explicitly distinct from and not a substitute for the P3
fine-tuned-model idea. Also corrects the Render-migration urgency claimed in v6: Vercel
Fluid Compute's free-tier 5-minute function window already covers the existing 240s
wall-clock budget, so the P1 trigger is redefined as measured need (standing workers,
real WebSockets, concurrency) rather than duration limits alone. Adds a trigger table
for all "show off" infrastructure (Render, WebSockets, broker, Grafana) making explicit
that each requires a concrete need to be hit before adoption, per the stated project
goal of zero-cost MVP first.

**v6** — reverses v5 §0 to open-world web-search evidence. Replaces RETRIEVE with
search+fetch. Adds topic-batching as the core cost strategy, WebSocket streaming with
per-batch graceful degradation, four-color mapping with "No evidence found" for orange,
and `not checked` as a first-class state. Reframes the narrative-EXTRACT failure from
MEDIUM backlog to blocking, since pasted prose is now the primary input.
