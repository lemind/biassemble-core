# Feature Specification: Choice of AI Provider and Bring-Your-Own Key

**Feature Branch**: `020-multi-provider-keys`

**Created**: 2026-10-12

**Status**: Draft

**Input**: Grounnel runs every check on Gemini today. Make it work with three providers — Gemini,
DeepSeek and Qwen. Compare them during development by running the golden set once or twice and a
few real texts on each. A user without their own key does not choose a provider; the check stays on
Gemini. A user with their own key selects Gemini, Qwen, or DeepSeek. Publish the comparison of all
three on the Stats page, broken down by type of case.

## Order of work

The comparison comes first. Qwen and DeepSeek cannot appear in the own-key list before we know how
they behave on the same tests, and the comparison is also the content of the Stats publication.
Own-key selection depends on a provider working end to end, which the comparison proves. The site
account has no provider picker.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The operator compares three providers on the same tests (Priority: P1)

The operator runs the golden set, once or twice, plus a small fixed set of real texts, on each of the
three providers. The result is one side-by-side table: how many claims each provider got right, how
many true claims it marked false, how many it left unresolved, how long a claim took, and what a run
cost.

**Why this priority**: Everything else depends on it. Every gate and prompt rule was tuned on one
model, and a model change can silently break them (a prompt wording change once dropped a detection
from 6 of 12 runs to 0 of 6). Offering a provider without this measurement would put untested
verdicts in front of users.

**Independent Test**: Run the comparison for all three providers and open the resulting table. It
can be done and used before any user-facing change exists.

**Acceptance Scenarios**:

1. **Given** the golden set and the fixed real texts, **When** the operator runs the comparison for
   one provider, **Then** every case completes and the provider's row appears in the table.
2. **Given** results for all three providers, **When** the table is opened, **Then** each provider
   shows correct rate, false accusations, unresolved rate, average time per claim and cost per run,
   for the same cases.
3. **Given** a comparison run, **When** production statistics are computed, **Then** the comparison
   runs are not counted as production runs.

---

### User Story 2 - A check without an own key stays on Gemini (Priority: P2)

A visitor who does not enter their own key sees no provider choice. The check runs on Gemini, the
same way it does today. The result and its share link say that Gemini produced it.

**Why this priority**: It keeps today's path unchanged. Qwen and DeepSeek are not available on the
site's account.

**Independent Test**: Run a check without entering a key. It completes on Gemini, and the form
shows no provider picker.

**Acceptance Scenarios**:

1. **Given** a visitor who does not enter an own key, **When** they run a check, **Then** it runs on
   Gemini, exactly as today.
2. **Given** a visitor who does not enter an own key, **When** they look at the check form, **Then**
   Gemini, Qwen, and DeepSeek are not offered as a choice.
3. **Given** a share link to a site-account check, **When** anyone opens it, **Then** it shows that
   Gemini produced it.

---

### User Story 3 - A user runs checks with their own key (Priority: P3)

A user who has a key for Gemini, DeepSeek, or Qwen turns on own-key, selects that provider, enters
the key, and runs checks that are paid by their own account. The key is used only for their own
checks and is never stored by the site.

**Why this priority**: It is the only place a user chooses a provider. Gemini, Qwen, and DeepSeek
are all selectable here, and it is the only way to use Qwen or DeepSeek. It needs careful key
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
4. **Given** a user who chooses DeepSeek for the first time, **When** they enter the key, **Then**
   they are told which company processes their text before the first check runs.
5. **Given** a user who turns on own-key, **When** they look at the provider choice, **Then**
   Gemini, Qwen, and DeepSeek are all selectable.

---

### User Story 4 - Readers see the comparison on the Stats page (Priority: P4)

A reader opens the Stats page and finds a section comparing the three providers on the same tests,
broken down by type of case, with the date, the number of passes and an honest note on how small
the test set is.

**Why this priority**: It is the public record of Story 1 and it explains why the site offers what
it offers. It needs Story 1's data and nothing else.

**Independent Test**: Open the Stats page after a comparison run and check that every number in the
section matches the comparison table.

**Acceptance Scenarios**:

1. **Given** a completed comparison, **When** the Stats page is opened, **Then** it shows each
   provider's results per case type, with the date and number of passes.
2. **Given** that the comparison used one or two passes over a small set, **When** a reader looks at
   the section, **Then** it states that limit plainly next to the numbers.

---

### Edge Cases

- A provider fails or times out in the middle of a check: claims already verified keep their
  verdicts; the rest are marked as not checked; the user sees which provider failed.
- A user's own key runs out of balance in the middle of a check: same as above, and the message
  says the user's balance ran out, not that the site failed.
- A provider is slower than Gemini and cannot verify 40 claims within the hosting time limit: that
  provider's claim limit is set from measurement and shown to the user, instead of failing late.
- A provider returns output in an unexpected shape: the existing repair and retry rules apply; if
  they fail, the claim is not checked rather than guessed.
- A provider is removed later: older results and share links still show the provider that produced
  them.
- A user pastes a key for one provider while another provider is selected: the key is rejected
  before any check runs, with a message naming the mismatch.

## Requirements *(mandatory)*

### Functional Requirements

**Providers**

- **FR-001**: The system MUST be able to run a complete check — extraction, eligibility, verification
  and the gate chain — with each of three providers: Gemini, DeepSeek and Qwen.
- **FR-002**: Each provider MUST use one fixed model chosen by the operator; users choose a
  provider, not a model.
- **FR-003**: Searching the web for sources MUST work the same way whichever provider runs the
  check, so that differences between providers come only from the model.
- **FR-004**: Every run MUST record which provider and model produced it, and whether it ran on the
  site's account or a user's own key (`key_source`). The comparison cost report MUST read
  `key_source`. The result page and the share link MUST NOT. The key itself MUST never be recorded.

**Comparison (operator)**

- **FR-005**: The operator MUST be able to run the golden set and a fixed set of real texts on a
  chosen provider, for one or two passes, with a single action.
- **FR-006**: The comparison MUST report, per provider and per case type: correct rate, false
  accusations (true claims marked `contradicted`), unresolved rate, average time per claim and cost
  per run. Cost per run is the judging calls only, priced as the run's provider. Web-search calls
  stay on the site's Gemini account and are a separate line, not mixed into another provider's cost.
  The same report MUST include, per provider, how often each reason-reading gate overrode a verdict
  (`reason_consistency`, `implicit_negation`, `reason_year`, `reason_ordinal`), taken from the gate
  events already stored per run. Scoring MUST use the existing golden-set scorer, not a second one.
- **FR-007**: Comparison runs MUST be marked as evaluation runs and MUST NOT count toward production
  statistics.

**Choice on the site's account**

- **FR-008**: A user without their own key MUST NOT be offered a provider choice. The check MUST run
  on Gemini, so a user who changes nothing gets today's behaviour.
- **FR-009**: A visitor's check without an own key MUST run on Gemini. Qwen and DeepSeek MUST NOT
  run on the site's account for a visitor. The operator comparison is the exception: it MAY call
  Qwen and DeepSeek with keys in the core deployment, from the eval job in-process, and that path
  MUST NOT be rejected as a visitor missing an own key.
- **FR-010**: Qwen and DeepSeek are judged separately. One enters the own-key list only after its own
  golden-set comparison is recorded, it produced zero false accusations, and the reason-reading
  gates in FR-006 still override on the cases where they override Gemini. A provider whose false
  accusations fall to zero because those gates stopped matching has failed, not passed. A case whose
  detection floor is 0 is still counted in those gate totals. Gemini is already the production
  provider and is selectable with an own key without a new comparison.
- **FR-011**: The result page and the share link MUST show which provider produced the result.
- **FR-012**: The existing limits (claims per run, runs per period) MUST apply to every provider. A
  provider that cannot finish 40 claims within the hosting time limit MUST get a lower claim limit
  set from measurement, shown to the user.

**Own key**

- **FR-013**: A user who turns on own-key MUST be able to select Gemini, DeepSeek, or Qwen, enter
  their own key for that provider, and run checks with it.
- **FR-014**: An own key MUST be used only for the checks of the user who entered it. It MUST NOT be
  stored by the site, written to any log, included in any result or share link, or used for any
  other purpose. Text written to a log or to a stored error MUST be scrubbed of key material first.
  Hiding a header field is not enough: a provider error body can echo the key.
- **FR-015**: By default the key MUST be kept only for the current browser session. The user MAY
  choose to have their browser remember it on that device.
- **FR-016**: An invalid, expired or empty-balance key MUST produce a clear error naming the
  problem, and the check MUST NOT silently fall back to the site's account. An empty balance, a rate
  limit, and an outage are three different errors. A rate limit stops the rest of that check instead
  of spending the remaining claims against the same limit.
- **FR-017**: Before the first check with a provider, the user MUST be told which company's service
  processes their text.
- **FR-018**: Checks with an own key MUST still count toward the site's run limits, because web
  search runs on the site's account.

**Stats publication**

- **FR-019**: The Stats page MUST include a section comparing the three providers on the same tests,
  per case type: correct rate, false accusations, unresolved rate, time per claim and cost per run,
  plus whether the reason-reading gates still overrode verdicts. Search cost is not folded into a
  provider's judging cost.
- **FR-020**: The section MUST show the date of the comparison, the number of passes, the number of
  cases, and a plain statement that one or two passes over a small set is an early signal, not a
  benchmark.
- **FR-021**: Case types MUST include at least: true claims, false claims, and the real texts. More
  types (dates and numbers, sequence positions, negations) SHOULD be shown where the golden set has
  enough cases of that type to report.

### Key Entities

- **Provider option**: one of Gemini, DeepSeek or Qwen, with its fixed model, whether the site
  account runs it (Gemini only, and not as a user choice), whether it is selectable with an own
  key, and the company that processes the text.
- **Run provider record**: for each run, the provider, the model, and whether it used the site's
  account or an own key. Never the key.
- **Comparison result**: for one provider and one comparison run — date, passes, cases, and per case
  type the correct rate, false accusations, unresolved rate, time per claim and judging cost per
  run, plus per-gate override counts for the reason-reading gates. Search cost is separate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The golden set and the fixed real texts complete on all three providers, and their
  results appear in one side-by-side table.
- **SC-002**: The whole development comparison — golden set at most twice plus the real texts, on
  three providers — costs no more than $10 in model charges.
- **SC-003**: The site account offers no provider choice. Qwen is admitted on Qwen's comparison
  alone, and DeepSeek on DeepSeek's: zero golden-set false accusations, and the reason-reading
  gates still overriding where they override Gemini. One provider failing leaves the other eligible.
- **SC-004**: A user who does not change the provider completes a check in exactly the same steps as
  today.
- **SC-005**: With a valid own key, a user goes from entering the key to a running check in one extra
  step; with an invalid key they see the error within 10 seconds, before any claim is processed.
- **SC-006**: A search of every stored record and log for a test key finds zero occurrences.
- **SC-007**: Every number in the Stats comparison section matches the comparison table it was
  published from.

## Assumptions

- The intended models are the cheapest current model of each provider that suits this workload:
  Gemini 2.5 Flash-Lite (today's model), DeepSeek V4.1 Flash and a Qwen flash model. The operator
  confirms the choice when the comparison runs.
- Qwen is used through its international (Singapore) region. For a visitor, Qwen and DeepSeek are
  selectable only with that visitor's own key. The operator comparison may use deployment keys for
  those two providers (FR-009). DeepSeek processes text on DeepSeek's own service, which is why
  FR-017 exists. A visitor's check always runs on Gemini, with no picker.
- Web search stays on the site's account for all providers, including own-key runs. A user's own
  key pays only for model calls.
- There are no user accounts. A key lives in the user's browser, never on the site.
- Measured cost of the comparison at list prices is about $1–4 per round for all three providers,
  well inside SC-002.
- Evaluation runs execute on the deployed system, because model calls from the operator's machine
  are blocked by region.

## Out of Scope

- More providers than these three, or a choice of models within a provider.
- Using a user's own Gemini key for web search.
- Accounts, payments, or a per-user allowance of free checks.
- A full benchmark with many passes; the comparison is one or two passes by design.
