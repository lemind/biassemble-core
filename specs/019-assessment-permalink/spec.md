# Feature Specification: Shareable Assessment Permalink

**Feature Branch**: TBD

**Created**: 2026-09-09

**Status**: Draft

**Input**: A completed check gets a durable share link. Opening it returns the original submitted
text plus every claim verdict and source, read from durable storage with no expiry, so the person
who ran the check can come back to it and anyone they send it to can see the same result.

Supersedes the permalink workstream that was parked in
[018 FINDINGS.md](../018-assessment-integrity-and-guardrails/FINDINGS.md) — permalinks are no longer
part of 018 and are no longer parked.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The person who ran a check can return to it (Priority: P1)

Someone submits an article, waits for the result, then closes the tab. Later — next week, next
month — they open their link and see exactly what they saw before: their text, the claims, the
verdicts, the sources.

**Why this priority**: Today the result exists only in browser memory. A refresh, a new tab, or
clicking any navigation link destroys a run that took minutes to produce. The result is already
stored durably; there is simply no way to reach it.

**Independent Test**: Run a check, note the link, close the browser, reopen the link the next day.

**Acceptance Scenarios**:

1. **Given** a completed check, **When** the run finishes, **Then** a shareable link is presented.
2. **Given** that link, **When** it is opened in a new tab or after a browser restart, **Then** the
   full result renders.
3. **Given** a link to a check older than one week, **When** it is opened, **Then** it still renders
   — durability is not time-limited.

---

### User Story 2 - Anyone with the link sees the same result (Priority: P1)

The person who ran the check sends the link to someone else — a colleague, an editor, the author of
the text. That person opens it and sees the same assessment without an account, a key, or any
credential.

**Why this priority**: Sharing is the point of the feature. A link only the original runner can open
solves half the problem and is barely more useful than browser state.

**Independent Test**: Open the link from a different browser with no prior session.

**Acceptance Scenarios**:

1. **Given** a share link, **When** someone who never ran the check opens it, **Then** they see the
   complete assessment.
2. **Given** a share link, **When** it is opened, **Then** no sign-in or credential is required.
3. **Given** knowledge of a run's internal identifier but not its share link, **When** that
   identifier is used to request an assessment, **Then** access is refused.

---

### User Story 3 - The shared view shows the text, not just verdicts (Priority: P2)

A recipient sees the original submitted text with each checked claim marked in place, exactly as the
person who ran it saw — not a bare list of verdicts detached from what was written.

**Why this priority**: A verdict without its sentence is close to meaningless to someone who wasn't
there. The submitted text is already stored, so this costs nothing extra to return.

**Independent Test**: Open a shared link and confirm every claim can be located in the original text.

**Acceptance Scenarios**:

1. **Given** a shared assessment, **When** it renders, **Then** the original submitted text is shown
   in full.
2. **Given** a claim in that assessment, **When** the reader looks at the text, **Then** the claim's
   own excerpt is identifiable within it.
3. **Given** a claim, **When** the reader inspects it, **Then** its verdict, reason, confidence and
   sources are all available.

---

### Edge Cases

- The link is opened for a run that failed, or one still in progress.
- The link is opened for a run that reached no claims at all.
- A token that has never existed, or has been revoked.
- A claim whose excerpt cannot be located in the stored text, or that has none.
- A very large submitted text, where returning it in full is expensive.
- The same text submitted twice, producing two independent links.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every run MUST be assigned a share identifier at creation.
- **FR-002**: The share identifier MUST be distinct from the run's internal identifier, and MUST be
  unguessable.
- **FR-003**: Knowledge of a run's internal identifier alone MUST NOT grant access to its
  assessment.
- **FR-004**: A shared assessment MUST be readable without any credential.
- **FR-005**: A shared assessment MUST remain readable indefinitely — no expiry.
- **FR-006**: A shared assessment MUST be served from durable storage, not from transient state.
- **FR-007**: A shared assessment MUST include the original submitted text.
- **FR-008**: A shared assessment MUST include every claim with its verdict, reason, confidence,
  source excerpt and sources.
- **FR-009**: A shared assessment MUST NOT expose internal identifiers, session identifiers, or
  operational telemetry.
- **FR-010**: A request for an unknown share identifier MUST be refused without revealing whether
  the run exists.
- **FR-011**: A shared assessment for an incomplete or failed run MUST render what exists and state
  its status rather than appearing complete.

### Key Entities

- **Share identifier**: an unguessable public address for one assessment. Distinct from the run's
  internal identity, which stays private.
- **Shared assessment**: the submitted text, plus every claim with verdict, reason, confidence,
  excerpt and sources, plus the run's status.
- **Claim**: one checked assertion with its location in the submitted text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A link to a check older than one week opens and renders in full.
- **SC-002**: Someone with no prior session and no credential can open a shared link successfully.
- **SC-003**: A run's internal identifier used as a share identifier is refused 100% of the time.
- **SC-004**: A shared assessment contains every claim the original run produced — no truncation.
- **SC-005**: A reader can locate every claim's excerpt within the shown text.
- **SC-006**: No response exposes internal or session identifiers.

## Assumptions

- The submitted text and all claim results are already stored durably; this feature adds a read
  path and an address, not new storage.
- Links are public to anyone holding them, unguessable, and never expire — decided 2026-09-08. The
  accepted risk is that submitted documents may name private individuals, and a leaked link stays
  readable.
- The browser reaches this service through the existing application backend rather than calling it
  directly, since every other route here requires a key.
- Search engines should not index shared assessments; discovery is by link only.
- **Revocation is out of scope, decided 2026-09-09.** An unguessable token is the whole access
  control: links are public, permanent and cannot be withdrawn once shared. Accepted for the MVP
  because discovery is link-only (`robots.txt` Disallow + `X-Robots-Tag: noindex`) and nothing
  enumerates tokens. Revisit if a real person asks for their assessment to be taken down — at which
  point the fix is a `revoked_at` column, not a redesign.
