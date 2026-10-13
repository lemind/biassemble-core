# Feature Specification: Choice of AI Provider and Bring-Your-Own Key

**Feature Branch**: `020-multi-provider-keys`

**Created**: 2026-10-12

**Status**: Draft

**Input**: Grounnel runs every check on Gemini today. Add DeepSeek and Qwen. The default stays
Gemini. A user without their own key does not choose a provider. A user with their own key selects
Gemini, and Qwen or DeepSeek only after a small manual check of that provider. No comparison
feature in this slice.

## Order of work

Build the two providers and own-key first. The site account stays on Gemini, with no picker.
Qwen and DeepSeek can run on the evaluation job as soon as the plumbing works. They stay off the
public form until a small manual check of that provider looks acceptable. That check is not new
software. It uses the evaluation job the project already has, which marks those runs so they are
not production. The public check is not that path: a public check is always a production run.
The operator reads the results by hand. The Stats page is unchanged in this slice.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The operator reads a check by hand, later (Priority: later, not this slice)

When DeepSeek and Qwen work, the operator runs the existing deployed evaluation job once per
provider and reads the results by hand. There is no comparison script, no generated table, and no
Stats section in this slice. Those runs are marked as evaluation, the same way today's evaluation
runs are, so they do not count as production.

**Why this priority**: It is last, and it is not a feature to build. The bars in FR-010 are what
the operator looks at then. They do not block building the providers. They do block listing that
provider on the public form.

---

### User Story 2 - A check without an own key stays on Gemini (Priority: P1)

A visitor who does not enter their own key sees no provider choice. The check runs on Gemini. The
result and its share link say that Gemini produced it.

**Why this priority**: The default does not change. DeepSeek and Qwen are the two providers being
added, and a visitor reaches them only with an own key.

**Independent Test**: Run a check without entering a key. It completes on Gemini, and the form
shows no provider picker.

**Acceptance Scenarios**:

1. **Given** a visitor who does not enter an own key, **When** they run a check, **Then** it runs on
   Gemini.
2. **Given** a visitor who does not enter an own key, **When** they look at the check form, **Then**
   there is no provider choice.
3. **Given** a share link to a site-account check, **When** anyone opens it, **Then** it shows that
   Gemini produced it.

---

### User Story 3 - A user runs checks with their own key (Priority: P3)

A user who has a key for Gemini, DeepSeek, or Qwen turns on own-key, selects that provider, enters
the key, and runs checks that are paid by their own account. The key is used only for their own
checks and is never stored by the site.

**Why this priority**: It is the only place a user chooses a provider. Gemini, Qwen, and DeepSeek
are all selectable here, and it is the only way to use DeepSeek or Qwen. It needs careful key
handling, so it comes after the unchanged site path in Story 2.

**Independent Test**: Enter a valid key for each provider in turn and run a check; then enter an
invalid key and confirm a clear error.

**Acceptance Scenarios**:

1. **Given** a valid key for DeepSeek, **When** the user runs a check, **Then** the model calls are
   charged to the user's DeepSeek account and the result names DeepSeek.
2. **Given** an invalid, expired or empty-balance key, **When** the user runs a check, **Then** they
   see an error naming the problem, and the check does not fall back to the site's account.
3. **Given** a check run with an own key, **When** its share link is opened by anyone, **Then** the
   result is visible and the key appears nowhere in it.
4. **Given** a user about to run the first own-key check, **When** they look at the notice, **Then**
   it names the model company, says Grounnel's server uses the key for that check and does not save
   it, says Google still discovers web sources, and says anyone with the share link can open the
   result.
5. **Given** a user who turns on own-key, **When** they look at the provider choice, **Then**
   Gemini is selectable. Qwen is selectable only after its manual check. DeepSeek is selectable
   only after its own manual check. A provider that has not had that check is absent from the form.

---

### User Story 4 - Stats comparison (not this slice)

No Stats change now. A public comparison section waits until the hand comparison has been done.

---

### Edge Cases

- A provider fails or times out in the middle of a check: claims already verified keep their
  verdicts; the rest are marked as not checked; the user sees which provider failed.
- A user's own key runs out of balance in the middle of a check: same as above, and the message
  says the user's balance ran out, not that the site failed.
- A provider is slower than Gemini and cannot verify 40 claims within the hosting time limit: that
  provider's claim limit is set from measurement and shown to the user, instead of failing late.
- A provider returns output in an unexpected shape, or returns empty content: the existing repair
  and retry rules apply; if they fail, the claim is not checked rather than guessed.
- A provider is removed later: older results and share links still show the provider that produced
  them.
- A user pastes a key for one provider while another provider is selected: the key is rejected
  before any check runs, with a message naming the mismatch.

## Requirements *(mandatory)*

### Functional Requirements

**Providers**

- **FR-001**: The system MUST be able to run a complete check — extraction, eligibility, verification
  and the gate chain — with each of three providers: Gemini, DeepSeek and Qwen. A successful
  authentication call is not that check. DeepSeek and Qwen use JSON-object mode. Every prompt sent
  in that mode MUST contain the word JSON and an example of the expected object. Zod validation and
  the existing repair path stay. Output that still cannot be used is a failed claim, not a guessed
  verdict. Gemini's schema-enforced prompts are left unchanged; the JSON word and example are added
  on the DeepSeek and Qwen request only when the shared prompt does not already contain them.
- **FR-002**: Each provider MUST use one fixed model chosen by the operator; users choose a
  provider, not a model.
- **FR-003**: Web search, the evidence sources, and the gate chain MUST stay the same whichever
  provider judges the text. A later reading compares each model together with that provider's own
  integration: structured-output mode, token limits, response handling, and repair. It does not
  isolate the model from those differences.
- **FR-004**: Every run MUST record which provider and model produced it, and whether it ran on the
  site's account or a user's own key (`key_source`). The result page and the share link MUST NOT
  show `key_source`. The key itself MUST never be recorded.

**Comparison (deferred operational reading, not this slice)**

- **FR-005**: This slice does not add a comparison action, script, or report. The shapes in the
  comparison-result note and the $10 ceiling in SC-002 are limits for that later reading. This
  slice does not produce them.
- **FR-006**: The later reading uses the existing deployed evaluation job, once per provider, and
  the operator reads the job output and the gate events. No second scorer is built. Unlabeled real
  texts are not an accuracy score. The public check is not this path.
- **FR-007**: That job already marks its runs as evaluation, so they stay out of production
  statistics. Giving the job a provider argument is in this slice, so the reading can run. A report
  is not.

**Choice on the site's account**

- **FR-008**: A user without their own key MUST NOT be offered a provider choice. The check MUST run
  on Gemini.
- **FR-009**: Qwen and DeepSeek MUST NOT run on the site's account for a visitor. They run on that
  visitor's own key, and only after that provider is listed.
- **FR-010**: Building a provider is not blocked by a comparison. Listing it on the form is. Qwen
  and DeepSeek stay off the form, and the public check rejects them, until a small manual reading
  of the existing evaluation job shows that provider's known gate-trigger cases still fire. Gemini
  with an own key does not wait: it is the model those gates were tuned on. The reading looks for
  zero false accusations on true claims, each known gate-trigger case still firing, known false
  claims meeting the floor already on that case, an unresolved rate no higher than Gemini's on the
  same pass, and output that still parses, finishes, and keeps citations. Those bars are not
  software, and they are not a ship gate for the plumbing. There is no experimental label on the
  form. A provider is either listed or absent.
- **FR-011**: The result page and the share link MUST show which provider produced the result.
- **FR-012**: The existing limits (claims per run, runs per period) MUST apply to every provider. A
  provider that cannot finish 40 claims within the hosting time limit MUST get a lower claim limit
  set from measurement, shown to the user.

**Own key**

- **FR-013**: A user who turns on own-key MUST be able to select every provider that is listed,
  enter their own key for it, and run checks with it. Gemini is listed. Qwen and DeepSeek are
  listed only under FR-010.
- **FR-014**: An own key pays the selected model provider only. The browser sends it over HTTPS to
  Grounnel for that check. The server MAY hold it in memory only while it makes that provider's
  calls. It MUST NOT be persisted, logged, hashed, prefixed, put in telemetry or traces, or placed
  in a queue or retry payload. If the run cannot continue without saving the key, the run fails and
  the user starts a new one. A provider error body that echoes the key is scrubbed before any log,
  stored error, or message the user sees.
- **FR-015**: For this release the key MUST stay in memory for the current page session only. The
  browser MUST NOT be asked to remember it on the device.
- **FR-016**: An invalid, expired, empty-balance, or model-access key MUST produce a clear error
  naming the problem, and the check MUST NOT silently fall back to the site's account. Each adapter
  classifies from the HTTP status and the provider's structured error code, not from the status
  alone. The user sees a category and a short message. The raw body is never shown. The categories
  are `invalid_key`, `no_balance`, `rate_limited`, `unavailable`, and `model_access_denied`.
  Model access denied is its own category: a model the account has not purchased is not reported as
  a bad key. For Qwen, a 429 is `rate_limited` only when the code says throttling, and `no_balance`
  when the code says quota, arrears, or an exhausted balance. An empty balance, a rate limit, and
  an outage are three different errors. A rate limit stops the rest of that check instead of
  spending the remaining claims against the same limit. A preflight that succeeded does not promise
  the rest of the run will: balance and rate limits can change, and this rule still applies then.
- **FR-017**: Before the first check in a session, the page MUST say which company runs the model
  calls, that Google still discovers web sources on Grounnel's account, and that anyone with the
  share link can open the result. An own-key check MUST also say the key is sent to Grounnel for
  that check and is not saved. Own-key is not a private or local-only mode. The site default stays
  Gemini, so a visitor who does not bring a key is told the model company is Google.
- **FR-018**: Checks with an own key MUST still count toward the site's run limits, because web
  search runs on the site's account.

**Stats publication**

- **FR-019**: Not in this slice. The Stats page is unchanged.
- **FR-020**: Not in this slice.
- **FR-021**: Not in this slice. When a hand comparison is written up later, true claims, false
  claims, and labeled real texts stay separate, and unlabeled real texts are not an accuracy score.

### Key Entities

- **Provider option**: one of Gemini, DeepSeek or Qwen, with its API model id and endpoint, whether
  the site account runs it, whether it is selectable with an own key, and the company that processes
  the model calls.
- **Run provider record**: for each run, the provider, the model, and whether it used the site's
  account or an own key. Never the key.
- **Comparison result** (deferred, not produced by this slice): for one provider and one later
  reading — date, passes, cases, and per case type the correct rate, false accusations, unresolved
  rate, time per claim and judging cost per run, plus per-gate override counts for the
  reason-reading gates. Search cost is separate. Judging cost is the sum of per-call prices, each
  call priced from that call's own input length and token split.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Not in this slice. The later reading is the existing evaluation job, read by hand,
  not a generated table.
- **SC-002**: Deferred operational limit, not a deliverable of this slice. The later reading —
  golden set at most twice plus the real texts, on three providers — costs no more than $10 in
  model charges. No report is generated to enforce it.
- **SC-003**: The site account offers no provider choice and runs on Gemini. Qwen and DeepSeek run
  only with an own key.
- **SC-004**: A user who does not change the provider completes a check in exactly the same steps as
  today.
- **SC-005**: With a valid own key, a user goes from entering the key to a running check in one extra
  step. With an invalid key they see the error within 10 seconds, before any claim is processed.
  That bound is a provider-specific preflight that does not send the user's article or any claim.
  DeepSeek uses the balance request. Gemini and Qwen use one tiny completion with a fixed prompt.
  The deployment key-check script does not satisfy this for a visitor's key. A passed preflight
  does not promise the rest of the run.
- **SC-006**: A test key sent through a successful run is absent from every database table, application
  log, and tracing or error system that can receive request data. A provider error whose body
  contains that key does not appear in the stored error or the message the user sees. Retries,
  timeouts, and rate limits do not put the key in a saved job payload.
- **SC-007**: Not in this slice. The Stats page does not gain a comparison section.

## Assumptions

- The API model ids, checked 2026-10-13, are `gemini-2.5-flash-lite`, `deepseek-flash`
  (DeepSeek-V4.1-Flash; do not send the retired alias `deepseek-v4-flash`), and `qwen3.7-flash` on
  the Singapore international endpoint. The later reading records the id that was sent, the model
  string the provider returned if any, and the endpoint or region. The deployment Gemini key is an
  authorization key. A visitor's Gemini key is not assumed to be one. The preflight accepts or
  rejects the key that was actually sent. A standard key that Google rejects is an authentication
  error, with a clear message, not a pipeline failure.
- Qwen is used through its international (Singapore) region. For a visitor, the default is Gemini,
  with no picker. DeepSeek and Qwen are own-key only. Gemini is also selectable with an own key.
- Web search stays on the site's Gemini account for every provider and every key source. A user's
  own key pays only for model calls. Own-key does not keep the text inside the chosen provider.
- There are no user accounts. The user types the key in the browser. For an own-key run the browser
  sends it to Grounnel, which holds it in memory only for that run (FR-014).
- Measured cost of the later reading at list prices is about $1–4 per round for all three
  providers, well inside the deferred SC-002 ceiling. It is not computed by this slice.
- Evaluation runs execute on the deployed system, because model calls from the operator's machine
  are blocked by region. The public check always stores a production run. The evaluation job stores
  an evaluation run. The later reading uses the job.

## Out of Scope

- More providers than these three, or a choice of models within a provider.
- Using a user's own Gemini key for web search.
- Saving the key in the browser after the page session ends.
- Accounts, payments, or a per-user allowance of free checks.
- A full benchmark with many passes.
- A comparison script, a generated report, or a Stats comparison section.
- Using the public check as the later reading. That path is production.
- Listing Qwen or DeepSeek on the form before that provider's manual check.
- A flat price per provider. When cost is computed later, each call is priced from that call.
