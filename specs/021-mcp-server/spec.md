# Feature Specification: Grounnel as an MCP Server

**Feature Branch**: `021-mcp-server`

**Created**: 2026-11-01

**Status**: Draft (two external reviews applied; rate-limit decision made, see FR-014)

**Input**: Let people use Grounnel from their own AI assistant (Claude, Claude Code, Cursor, and
other MCP clients). The assistant sends a text to Grounnel and gets the claims and verdicts back as
structured data, with the sources behind each verdict. Grounnel's pipeline and gates stay exactly
as they are. The assistant only starts checks and reads their results.

## Order of work

Own key first, and only own key. An MCP client can call Grounnel in a loop, and search runs on the
site account, so a site-paid MCP check needs a way to know who is calling. That needs accounts,
which are a separate decision. This slice ships two tools, own-key only, with the same public share
page as a website check.

## How it works

The user adds Grounnel's MCP address to their assistant once, with their provider choice and their
own API key as request headers in the client's connection settings. For Claude, that is a custom
connector set to "No sign-in" with request headers; for Claude Code and Cursor, a few lines of
config.

When the user asks the assistant to fact-check something, the assistant calls the start tool. The
server checks the key, pulls the claims out of the text (a few seconds), and answers with a share
token, a share link and "running". The server then finishes the check in the same process, with the
key still only in memory. This is the path website own-key checks already use (spec 020): no
background job queue is involved, so the key is never written into a job payload.

A check takes from under a minute to a few minutes. The assistant calls the result tool until the
check is done, and gets every claim with its verdict, confidence, reason, sources and cited
sentences. The result is exactly what the public share page shows.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Check a text from an assistant (Priority: P1)

A user has Grounnel connected in their assistant with their own key. They paste an article and ask
"fact-check this". The assistant starts a check, waits for it, and answers with the claims that
hold up, the ones that don't, and the sources, using Grounnel's verdicts rather than its own.

**Why this priority**: This is the whole feature.

**Independent Test**: Connect the server in one supported client with a valid key, ask it to check a
short paragraph with one true and one false claim, and confirm the answer carries Grounnel's
verdicts and a share link that opens the same check on the website.

**Acceptance Scenarios**:

1. **Given** a connected client with a valid own key, **When** the assistant starts a check, **Then**
   it gets a share token, a share link, the status "running", and when to read first.
2. **Given** a running check, **When** the assistant reads it, **Then** it gets the status, the
   current phase, progress, every claim finished so far, and when to read next.
3. **Given** a finished check, **When** the assistant reads it, **Then** it gets every claim with
   verdict, confidence, reason, sources and citations, plus the verdict counts, the provider and
   model, the token usage on the user's key, and whether the claim cap was hit.
4. **Given** a finished check, **When** anyone opens its share link, **Then** the website shows the
   same claims and verdicts.

---

### User Story 2 - Clear failures the assistant can explain (Priority: P1)

Something goes wrong: the key is wrong, the account has no balance, the text is empty or too large,
the rate limit is hit, or the provider fails mid-check. The assistant gets a specific reason it can
pass on, never a generic failure and never any part of the key.

**Why this priority**: An assistant that gets "error" will guess or retry in a loop. A clear reason
stops both.

**Independent Test**: Produce each error in FR-017 on purpose. Each returns its own code and one
sentence, and none echoes the key.

**Acceptance Scenarios**:

1. **Given** an invalid key, **When** the assistant starts a check, **Then** it gets "preflight
   failed: invalid key" before any text reaches search or the provider.
2. **Given** a DeepSeek account with no balance, **When** the assistant starts a check, **Then** it
   gets "preflight failed: no balance".
3. **Given** the hourly limit is used up, **When** the assistant starts a check, **Then** it gets
   "rate limited" and when it can try again.
4. **Given** a provider that fails partway through a check, **When** the assistant reads it, **Then**
   the status is "failed" with the provider reason (quota, rate limit, outage, unreadable answer),
   and claims finished before the failure are still returned.

---

### User Story 3 - The assistant knows where the text goes (Priority: P1)

Before sending anything, the assistant knows the text goes to the chosen model provider and to
Grounnel's own search services, and that the check becomes a public page. It can warn the user and
ask before checking something private.

**Why this priority**: On the website a person reads the warning before every check. Through an
assistant nobody sees the form, so the warning has to reach the assistant itself.

**Independent Test**: Read the start tool's description as a client receives it. It carries the full
data-flow warning in FR-013.

**Acceptance Scenarios**:

1. **Given** a client listing Grounnel's tools, **When** it reads the start tool, **Then** the
   description carries the data-flow and public-page warning and asks the assistant to confirm with
   the user before checking sensitive content.
2. **Given** a started check, **When** the assistant reads the response, **Then** it includes the
   share link, so the user can see what was published.

---

### User Story 4 - Setup takes a couple of minutes (Priority: P2)

A user finds the setup instructions on the About page, follows the steps for their client, adds their
key, and runs a first check.

**Why this priority**: Without instructions nobody connects. It doesn't block building the tools.

**Independent Test**: Follow the published instructions from scratch in each supported client and
reach a finished check.

**Acceptance Scenarios**:

1. **Given** the About page, **When** a user opens the MCP section, **Then** it shows the address,
   step-by-step connector instructions for Claude, config snippets for Claude Code and Cursor, where
   the key goes, and the warnings.

---

### Edge Cases

- **Text with no checkable claims** (an opinion piece, a poem): the check finishes with zero claims
  or only excluded ones, and says so. Not an error.
- **Text with more claims than a check covers**: same rule as the website. The check stops at 40
  claims and the result says so (FR-006). Not an error.
- **Text over the request size limit**: refused as "text too large" before anything runs.
- **The assistant never reads the result, or disconnects**: the check runs to the end and stays at
  its share link. Disconnecting never cancels a check.
- **The start call times out on the client side after the check was created**: a retry could start
  a second check. The start tool takes an optional request token; a repeat start with the same token
  within an hour returns the first check instead of starting a new one.
- **The key passes preflight but the provider fails later**: the check ends as failed with the
  provider reason; claims finished before it are kept.
- **Unknown share token**: "not found". The result tool returns only what the public share page
  shows, so a token gives no access the link doesn't already give.
- **The assistant reads too often**: reads have their own limit and never count against checks.
  Over the limit, the read returns a retry time; the check itself is unaffected.
- **The client puts the key in a tool argument**: neither tool has a key argument, so there is
  nowhere to put it.
- **Many users behind one address**: Claude's connectors call from Anthropic's cloud, so all Claude
  users arrive from the same few addresses. That is why the check limit is not per address (FR-014).
- **The provider changes model or price**: the result reports the model that actually ran.

## Requirements *(mandatory)*

### Functional Requirements

**Tools and output**

- **FR-001**: The server MUST offer exactly two tools: one that starts a check, and one that reads a
  check's status and results.
- **FR-002**: The start tool MUST take the text and an optional request token, and nothing else.
  Provider and key come from request headers in the connection settings, never from tool arguments.
- **FR-003**: The start tool MUST return once the key has passed preflight and the claims have been
  extracted, without waiting for verification. It returns the share token, the share link, the
  status, and how many seconds to wait before the first read. A repeat call with the same request
  token within an hour returns the first check.
- **FR-004**: The result tool MUST take the share token and return what the public share page shows
  and nothing more: status, current phase, progress (claims finished out of claims found), every
  finished claim, and, while running, how many seconds to wait before the next read. The pipeline's
  "extracting" and "verifying" are reported as status "running" with that phase; "done" and "failed"
  keep their meaning.
- **FR-005**: Each claim MUST carry its text, status, verdict, confidence, reason, sources (title,
  domain, address, fetch status) and citations (source label, sentence number, address, and the exact
  sentence cited), projected from the existing share-page claim shape. Verdict values are the
  website's: supported, partially supported, unsupported, contradicted, unverifiable, excluded.
- **FR-006**: A finished result MUST also carry the verdict counts, the provider and model that ran,
  the token usage on the user's key, and whether the claim cap was hit. The cap flag is new: it is set
  by extraction, true only when the 40-claim limit actually left claims out, and stored with the run.
  A result with exactly 40 claims does not by itself mean the cap was hit.
- **FR-007**: Both tools MUST declare an output schema and return their result as structured content,
  plus the same result as JSON text for clients that only read text. Errors use the same shape.
- **FR-008**: Tool descriptions MUST tell the assistant that a check takes up to a few minutes and to
  read at the advised interval, so it waits instead of giving up after the first read.
- **FR-009**: The start tool MUST be marked not read-only, not idempotent, and reaching the open web.
  The result tool MUST be marked read-only and idempotent. These marks are hints, not a privacy
  control.

**Keys and providers**

- **FR-010**: Every MCP check MUST use the caller's own key. A request without a key MUST be refused
  as "key required". There are no site-paid MCP checks in this slice.
- **FR-011**: The caller MUST choose the provider (Gemini, DeepSeek or Qwen) in a request header. A
  missing provider is refused as "provider not chosen", any other value as "unsupported provider".
  There is no default provider over MCP.
- **FR-012**: The key MUST reach the check only through the existing own-key execution path: held in
  memory by the request that starts the check, which finishes the check in the same process after
  replying. It MUST NOT appear in any job queue payload, database record, cache, log line, trace or
  stored error. If an implementation needs a background job for MCP checks, that design must be
  settled before implementation, without putting the key in the job.

**Same rules as the website**

- **FR-013**: An MCP check MUST run the same pipeline and gates as a website check, get the same
  public share page, and keep search and page fetching on the site account. The start tool's
  description MUST say: the text is sent to the chosen model provider for extraction and
  verification; Grounnel also uses its own Google (Gemini) and Tavily accounts to search for and fetch
  sources; the text and results are published at a permanent link anyone with it can open; and the
  assistant should confirm with the user before checking anything sensitive.

**Limits**

- **FR-014**: MCP checks MUST be limited to 30 an hour per key. The limit is counted against a
  salted one-way fingerprint of the key that expires within an hour and is never written to the
  database. Per address doesn't work, because Claude's connectors all call from Anthropic's
  addresses. Decided 2026-11-01 (option a), over a per-user MCP token (extra setup step) and a
  shared bucket for connector addresses (one heavy user blocks everyone). Website own-key checks
  keep their per-address limit and no fingerprint, so the website's "never stored, not even hashed"
  promise stays true; the About page's MCP section states the fingerprint for MCP checks.
- **FR-015**: Result reads MUST have their own limit and window, sized so that 5 concurrent checks
  read at the advised interval to completion never hit it. The 120-an-hour shared-link limit is too
  tight. Over the limit, a read returns a retry time and never affects the check. Exact numbers go
  in the plan.
- **FR-016**: Where a client address is used, it MUST come only from the hosting platform's edge. A
  forwarding header sent by the caller never changes it.

**Errors**

- **FR-017**: Every failure MUST come back as a tool error result, not a protocol error, with a short
  code and one plain sentence. Start errors: key required, provider not chosen, unsupported provider,
  empty text, text too large, preflight failed (invalid key, or no balance), rate limited (with a
  retry time when known). Read errors: not found, rate limited. A failed check reports one reason:
  provider quota or balance used up, provider rate limit, provider unavailable, unreadable provider
  answer, or pipeline failure.
- **FR-018**: No part of the key MAY appear anywhere Grounnel writes or emits: errors, tool results,
  logs, traces, metrics or stored records. Redaction happens at the request's entry, before any
  logging or tracing, and covers every request, including tool listing, discovery, rejected requests
  and reads. The key MUST never be mapped from a tool parameter into a header.

**Records**

- **FR-019**: Each run MUST record its entry point (website or MCP) in a new field set by the server.
  It is separate from the existing production/evaluation field: MCP checks are production runs with
  entry point MCP. Existing runs are recorded as website.

**Access**

- **FR-020**: The server MUST be reachable at one public address with nothing to install, over
  Streamable HTTP as defined in MCP revision 2026-07-28: stateless, one POST endpoint, the required
  request metadata headers, server discovery, and Origin validation when an Origin header is sent.
  Support for the earlier 2025-11-25 revision is decided in the plan and tested if kept.
- **FR-021**: The About page MUST explain how to connect: step-by-step connector instructions for
  Claude, config snippets for Claude Code and Cursor, the data-flow and public-page warnings, that
  Claude's connector stores the key on Anthropic's side and calls Grounnel from Anthropic's cloud,
  that MCP checks are rate-limited by a one-way key fingerprint kept for up to an hour,
  and to keep the key out of project config files shared in version control.

### Key Entities

- **Check**: the existing Grounnel run. Gains the entry point (website or MCP) and the cap flag.
  Everything else (claims, verdicts, citations, share token) is unchanged.
- **Connection settings**: the server address, the provider and the key, set once in the user's
  client. For Claude connectors, Anthropic stores them (encrypted, per their documentation). Grounnel
  doesn't store them.
- **Key fingerprint**: a salted one-way value derived from the key, used only as the rate-limit
  bucket name for MCP checks and expiring within an hour. Never written to the database.
- **Request token**: optional, client-chosen, used only to return the same check on a retried
  start; kept for an hour.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For the same 10-claim text and provider, pipeline time from start to done over MCP is
  within 10% of the website's. Delay from the client's read interval is measured separately.
- **SC-002**: For the same check, the MCP result and the share page show the same claims, verdicts
  and citations.
- **SC-003**: The start tool answers within 30 seconds at the 95th percentile, including with several
  starts at once, and the check finishes after the start call has ended.
- **SC-004**: A missing or invalid key causes no claim extraction and no search.
- **SC-005**: After a full test run with a synthetic key, including failed and wrong-key requests,
  the key is absent from the database, logs, traces, stored errors and tool results.
- **SC-006**: 5 concurrent checks read at the advised interval to completion never hit the read
  limit.
- **SC-007**: Every error in FR-017 can be produced on purpose and comes back with its own code.
- **SC-008**: Each supported client sends both headers and completes a check, tested end to end.
- **SC-009**: Website and MCP runs carry the right entry point, and both are production.
- **SC-010**: A first-time user following the About page reaches a finished check in each supported
  client in under 5 minutes.

## Assumptions

- **Supported clients** can set custom request headers on a remote MCP server: Claude (custom
  connectors on desktop and web, "No sign-in" plus request headers; marked beta by Anthropic at the
  time of writing), Claude Code (`--header` or `headers` in config) and Cursor (remote server config).
  Each is listed only after passing SC-008.
- **Claude's connectors call from Anthropic's cloud**, not the user's machine. This drives FR-014.
- **No global spend cutoff exists today**, and MCP adds no new exposure: the website's own-key route
  can already be scripted. A global spend and in-flight limit is separate work, listed below.
- **Two tools, not native MCP tasks.** Tasks are an optional extension in revision 2026-07-28 and
  client support is unverified. Revisit once the supported clients handle them.
- **Result size is bounded** by the 40-claim cap; no paging in this slice.

## Out of Scope

- Site-paid checks over MCP, user accounts, and sign-in (OAuth).
- A global spend ceiling and a global limit on checks in flight (applies to the website too).
- Checking a page by its address instead of pasted text.
- Batch checks of several texts in one call.
- Live progress messages while a check runs.
- Cancelling a running check.
- Listing in public MCP directories.

## Open Questions

- **Which address?** A path on the existing core deployment, or its own subdomain such as
  `mcp.grounnel.n30sk.cc`. Decided in the plan.
