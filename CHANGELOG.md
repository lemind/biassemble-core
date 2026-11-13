# Changelog

The engine behind Grounnel and Biassemble. One release per merged pull request: a feature bumps the
middle number, a fix-only release bumps the last. Pull requests that only changed specs or docs are
not releases. Versions before 0.28.1 were assigned on 2026-11-13 from the merge history.

## 0.28.1 — 2026-11-13

- The service reports its version on its health check and to MCP clients.

## 0.28.0 — 2026-11-13

- Grounnel is an MCP server: an AI assistant can start a fact-check and read back every claim with
  its verdict and sources, on the caller's own Gemini, DeepSeek or Qwen key.
- Checks run as queued steps, so a long check no longer stops at the server time limit. An own key is
  held encrypted for at most 45 minutes while its check runs.
- A check that the provider stops midway still finishes, and records why it stopped.

## 0.27.0 — 2026-10-26

- Own-key checks report the judging token totals they used.

## 0.26.0 — 2026-10-25

- Grounnel runs on Gemini, DeepSeek or Qwen, including on a visitor's own key.
- A visitor key is tested before the article is sent, and own-key checks get their own rate limit.

## 0.25.0 — 2026-10-08

- A "supported" verdict is downgraded when the claim's acronym appears in none of the passages.

## 0.24.0 — 2026-09-14

- Every check gets a public share link, with its verdicts, citations and claim status saved.
- Discovery output is capped and recorded.

## 0.23.0 — 2026-09-07

- The judging step reads the whole ranked pool of passages.
- Searching keeps fetching until it has enough usable pages, and skips pages already known to be bad.
- Pages found in earlier escalation rounds are kept instead of being searched for again.
- Negated claims are judged with the right polarity.

## 0.22.0 — 2026-09-02

- Claims with nothing concrete to check are left out instead of being judged.
- The subject-entity gate is switched off.

## 0.21.0 — 2026-08-26

- Each claim is classified as checkable or not before it is judged.
- Golden-set evals score several repeats per case, with a hard safety gate.
- More telemetry on retries and on gates that disagree.

## 0.20.0 — 2026-08-18

- Every verdict exposes which source and passage it cites.
- Claims carry the exact text they came from, so the site no longer guesses where they are.
- A year mismatch in the judge's own reasoning downgrades the verdict.

## 0.19.0 — 2026-08-11

- Judging pools up to three ranked passages per claim.
- Unresolved claims escalate through wider searches.
- Search results are reranked by meaning before judging.

## 0.18.0 — 2026-08-06

- First working Grounnel check: start a check and poll its status.
- A live eval gate runs real checks against a golden set.

## 0.17.0 — 2026-08-06

- Grounnel foundations: claim extraction, trust-boundary gates, Redis storage and an IP rate limit.

## 0.16.0 — 2026-08-03

- Audit mode: extract claims from a text and verify them, with a deadline across the whole run.

## 0.15.0 — 2026-07-13

- Each detected bias records which engine sources it came from.

## 0.14.0 — 2026-07-11

- Retrieval starts as a background job when a story is submitted, and the assessment waits for it
  only as long as it is useful.

## 0.13.1 — 2026-07-09

- Evals no longer hang on a slow database, and mock mode stores nothing.

## 0.13.0 — 2026-07-06

- Retrieval results are recorded and compared against the model-only answer.

## 0.12.0 — 2026-06-26

- Evals can run over a whole dataset as a background job.

## 0.11.0 — 2026-06-26

- Metrics are computed from recorded model calls.

## 0.10.0 — 2026-06-23

- Every model call is recorded.

## 0.9.0 — 2026-06-20

- Raw model output is saved alongside the parsed result.

## 0.8.1 — 2026-06-18

- Clearer model-call log messages.

## 0.8.0 — 2026-06-15

- Prompts v1.1.0: a stricter evidence check before naming a bias.
- Model-call latency is logged.

## 0.7.0 — 2026-06-11

- Single-story eval jobs, a bundled server build, and assessments that work without questions and
  answers.

## 0.6.0 — 2026-06-08

- Evals run as background jobs, with a determinism check.

## 0.5.0 — 2026-06-08

- Assessments accept reasoning context, always save their trace, and validate the prompt version.

## 0.4.1 — 2026-06-05

- Fixes to evaluation metrics and their storage.

## 0.4.0 — 2026-06-04

- Evaluation metrics.

## 0.3.2 — 2026-06-02

- Small fixes.

## 0.3.1 — 2026-05-29

- A deploy script.

## 0.3.0 — 2026-05-27

- An evaluation framework, a repair step for broken model output, and serverless deployment.

## 0.2.0 — 2026-05-26

- Question and assessment flows on Gemini, with authentication.

## 0.1.0 — 2026-05-25

- First server: request contracts, a 30-bias catalog, request IDs, auth and logging.
