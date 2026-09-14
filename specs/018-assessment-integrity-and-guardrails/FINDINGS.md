# Findings — 2026-09-08/09 (parked, not scheduled)

Not a spec. Measured facts worth keeping, so they don't have to be rediscovered. Nothing here blocks
shipping the Grounnel site; the pipeline goes out as-is.

## Entity collisions on personal/biographical text

Same build (EXTRACT 1.7.0 / VERIFY 4.6.0), two real user documents.

`2a701ffa` — 26 claims. One **false accusation**: *"The SCA community is not often talked about"* →
`contradicted` @0.9, on evidence merging the Society for Creative Anachronism with Sexual
Compulsives Anonymous (*"...desire to recover from sexual compulsion..."*). Verified present in
`grounnel_claims.evidence`. One false support: *"Leo Johnston had an interest in fencing"* →
`supported` @0.9 from `leofencingclub.com` and fence rental in Johnston, IA.

`3e487d7f` — 39 claims, 0 contradicted, but **4 of 9 affirmations are collisions**: Victor Hugo's
*Les Misérables*; another person's `age 19` infobox; *The Punisher War Journal* #1; "sources mention
2025".

**The model already detects this when it rejects.** Its own `unsupported` reasons name the collision
exactly — *"mentions 'Hong Xie' multiple times, but not 'Hugo Xie'"*. It is never asked when
affirming or refuting. The golden set can't catch the class: every golden claim is a famous
unambiguous entity.

## Wall clock is not a function of claim count

30-day production `done` runs: a **4-claim run took 286s**; 29 claims 281s; 30 claims avg 264s / max
295s — against Vercel's 300s. Meanwhile 35 claims avg 86s, 44 claims 215s, 52 claims 169s.

A claim cap cannot bound runtime. If runs need bounding, it has to be a run deadline with per-stage
remaining-time checks. Runs stuck in `extracting`/`verifying` include `ec65cd67`, `9a0e0e8d`,
`5031c439` (100 claims), plus `6d7c7ef2`, `fe2d821e`, `55d6e232` (44), `2b79f2c4` (41) and ~15 at 2–3
claims on 84-char inputs — so hitting the cap is not what makes a run hang.

## One unbounded quantity

`instance_attribution` input tokens: p50 4,573, p99 76,168, **max 808,498** — one call, 73.5% of run
`5b8005cc`'s cost, on a 6,040-char article. `passage_rerank` max 293,334. Nothing caps a single
call's payload. At 800k the next increment is a hard failure against the 1M context ceiling, not a
bill.

## Cost shape

$0.0362/run, $0.0014/claim. 14-day LLM spend $10.39 — **eval $8.72 (84% of spend, ~96.5% of runs)**,
production $1.67. Input is 94% of tokens. Per-user cost is not a problem; unbounded exposure is.

A spend ceiling checked at `POST /extract` would miss evals entirely — `src/evaluation/
run-grounnel-eval.ts` constructs the services directly and never calls the route. Any real ceiling
belongs at the provider client, as an atomic reserve against a **USD** budget (input and output
price differ 4x).

## Highlight anchors already work

`source_excerpt` is verbatim: 227 of 232 exact substrings, 0 paraphrases, 5 null. Many-to-one is
normal (26 claims / 13 distinct excerpts). 2 of 39 excerpts occur twice in-text, so any offset work
must state which occurrence wins. The frontend already computes offsets in `matchClaimSpans.ts`.

## Assessment read path

`GET /status/:id` is Redis-backed, `AUDIT_TTL_SECONDS = 7 days`, behind `authHook`. The durable
Postgres copy has no reader. A shared link would 404 after a week. Note the browser has never called
core directly — it goes through the app-backend proxy, so any public read needs a proxy route too.

## Open questions if this is ever picked up

- Entity gate on `supported` **and** `contradicted`, as a post-verdict gate — never a pre-VERIFY
  relevance filter (reverted twice in spec 017: a refuting page disagrees, and relevance reads
  disagreement as irrelevance).
- What happens when one citation is right-entity and another is wrong.
- Whether anything downstream can restore `contradicted` after a downgrade — in `2a701ffa`,
  `escalation_replacement` demonstrably preserved a contradicted verdict.
- No large *varied* document has ever been measured. The 219,600-char run was one paragraph repeated
  20×, so its 3-claim output is correct dedup, not evidence about long documents.
