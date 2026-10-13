---
description: "Task list for adding DeepSeek and Qwen, with Gemini staying the default."
---

# Tasks: Choice of AI Provider and Bring-Your-Own Key

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/provider-selection.md](./contracts/provider-selection.md).

## Overview

The default stays Gemini. Nobody picks a provider unless they bring their own key. DeepSeek and Qwen are the two providers being added, and both are own-key only. Gemini is also selectable with an own key.

An own key pays the chosen model provider. Grounnel still receives the key for that check and does not save it. Google still searches the web. The share link stays public. The page says so before the first own-key check. The key stays in page memory only.

No comparison script, no generated report, and no Stats change. The later reading uses the existing evaluation job, which already marks those runs as evaluation. The public check is production and is not that path. Qwen and DeepSeek stay off the form until that reading looks acceptable for that provider. The claim cap stays 40.

## Format: `[ID] [P?] [Story?] Description`

IDs are `T2001` upward: spec `20` plus the two-digit task.

---

## Phase 1: Keys first

- [ ] T2001 Add `scripts/check-provider-keys.ts`. One authenticated call each for Gemini, DeepSeek, and Qwen, using `gemini-2.5-flash-lite`, `deepseek-flash`, and `qwen3.7-flash` (Singapore). The Gemini key must be an authorization key. Print ok or the error category. No check, no claims.
- [ ] T2002 Run it with the deployment keys. All three must pass before T2003.

## Phase 2: Foundation

- [ ] T2003 Move the shared provider error into `src/providers/types.ts`. Update imports in `src/orchestrators/retry.ts`, `src/orchestrators/llm-json-call.ts`, `src/orchestrators/grounnel/pipeline.service.ts`, `src/orchestrators/grounnel/pipeline-helpers.ts`, `src/routes/grounnel.ts`, `src/jobs/eval-grounnel-run.ts`, `src/orchestrators/audit/extract.service.ts`, and `src/orchestrators/audit/verify.service.ts`. No re-export from `src/providers/gemini.ts`. Audit behaviour does not change.
- [ ] T2004 [P] Add `src/persistence/error-scrub.ts` and run it before any `error_message` write. In `src/providers/search/hybrid-provider.ts`, stop storing `String(err)` from discovery. Assert the stored text in `tests/unit/providers/search/hybrid-provider.test.ts`.
- [ ] T2005 Add `src/providers/openai-compatible.ts` for DeepSeek and Qwen. `max_tokens` is set for DeepSeek and omitted for Qwen. Send JSON-object mode. Classify from the HTTP status and the provider error code: DeepSeek 401, 402, 429, 500, and 503 map straight across; a Qwen 429 is `rate_limited` or `no_balance` from the code; a Qwen 403 for a model that was not purchased is `model_access_denied`, not `invalid_key`. If the shared prompt lacks the word JSON and an example, append both on this request only. Empty content is retried, then the claim is unchecked.
- [ ] T2006 [P] `src/providers/gemini.ts` takes the per-run model and an optional key. The call uses that model. Classify from the response: a rejected key, including a standard key, is `invalid_key`; quota or depleted balance is `no_balance`. Do not assume a visitor's key is an authorization key. The deployment key is.
- [ ] T2007 Add `src/providers/registry.ts`. Every provider's claim cap is 40. Gemini is listed for an own key. Qwen and DeepSeek are implemented and unlisted.
- [ ] T2008 Migration `0018` adds `provider`, `model`, and `key_source` to `grounnel_runs` only, in `src/db/schema.ts`. Do not add those columns to `grounnel_llm_calls`. Needs sign-off before it runs on the shared database.
- [ ] T2009 Pass the per-run provider into `src/orchestrators/grounnel/extract.service.ts`, `src/orchestrators/grounnel/claim-eligibility.ts`, and `src/orchestrators/grounnel/pipeline.service.ts`. Record the model that was called. A structured call that still fails validation is an unchecked claim.
- [ ] T2016 The existing evaluation job takes a provider and uses the deployment key for it. Runs stay `source: "eval"`. It does not call `POST /extract`. It does not write a report.

## Phase 3: Site path stays Gemini (US2)

- [ ] T2010 [US2] In `src/routes/grounnel.ts`, no provider and no key means Gemini on the site key. `deepseek` or `qwen` without a key is rejected. An unlisted provider is rejected on this route even with a key.
- [ ] T2011 [P] [US2] Add `provider` and `model` to the Redis meta in `src/persistence/grounnel-store.ts`, to both schemas in `src/contracts/grounnel.schemas.ts`, and to the select list in `src/db/queries.ts`.
- [ ] T2012 [US2] The result and share page name the provider. No picker. Site repo.

## Phase 4: Own key (US3)

- [ ] T2013 [US3] Preflight the visitor's key before the first claim, and before the article is sent. DeepSeek calls `GET /user/balance`. Gemini and Qwen send one tiny completion with a fixed prompt. Return within 10 seconds, as a category, never the raw body. Do not fall back to the site key. A passed preflight does not skip mid-run handling.
- [ ] T2014 [US3] Site repo: own-key control. List only providers the registry marks as listed, which is Gemini until the later reading. Keep the key in page memory only. Before the first check, show the notice: model company, Grounnel uses the key and does not save it, Google still searches, the share link is public. A visitor Gemini key that Google rejects is an authentication error.
- [ ] T2015 Run the three key checks: a successful run, a provider error whose body contains the test key, and a retry or rate limit. The key is absent from stored rows, logs, traces, the user-visible error, and any job payload.

## Done when

- T2002 passed for all three deployment keys.
- A check with no key runs on Gemini and says so.
- An own-key check can run on Gemini.
- Qwen and DeepSeek are absent from the form and rejected on the public check.
- A bad key errors before any claim, without the article being sent, and does not fall back to the site key.

## Not this slice

Comparison script, Stats section, per-provider claim cap, remembering the key on the device, and `pricing.ts`. The later reading uses the evaluation job from T2016 and is read by hand. When pricing is built, each call is priced from that call's input length, cache split, and time. A flat rate per provider is wrong. Qwen and DeepSeek are listed only after that reading.
