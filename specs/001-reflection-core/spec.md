# Feature Specification: AI Core Reflection MVP

**Feature Branch**: `001-reflection-core`

**Feature Directory**: `specs/001-reflection-core`

**Created**: 2026-05-22

**Status**: Draft

**Input**: User description: "Biassemble AI Core MVP: private reflection orchestration service that returns 2-5 contextual follow-up questions per story and cognitive bias assessments (minimum one bias, no maximum) for the public Biassemble app, with structured JSON outputs and non-clinical guardrails."

## User Scenarios & Testing

### User Story 1 - Question batch for a story (Priority: P1)

The public Biassemble application submits a user's personal story and needs a batch of AI-generated follow-up questions so the user can reflect before assessment.

**Why this priority**: Without question generation, the reflection journey cannot start. This is the first Core capability the public backend calls synchronously on story submit.

**Independent Test**: Given a valid story (50–3000 characters) and session identifier, Core returns 2–5 distinct contextual questions and an completion flag in structured form that the public app can display without further AI calls for that step.

**Acceptance Scenarios**:

1. **Given** a valid story and session id, **When** the public app requests question generation, **Then** Core returns between 2 and 5 non-empty follow-up questions tied to the story
2. **Given** a story at the minimum allowed length, **When** question generation is requested, **Then** Core still returns a valid question batch within the 2–5 range
3. **Given** a story at the maximum allowed length, **When** question generation is requested, **Then** Core returns a valid question batch without truncation errors in the contract
4. **Given** an invalid or missing story (wrong length or empty), **When** the public app requests questions, **Then** Core rejects the request with a clear validation outcome (no partial AI output)

---

### User Story 2 - Bias assessment after Q&A (Priority: P1)

After the user answers all follow-up questions in the public app, the public backend needs a structured cognitive bias assessment and reflection prompt derived from the full story and Q&A context.

**Why this priority**: Assessment is the core product outcome; question batch alone does not deliver user value.

**Independent Test**: Given story text, the question list, and parallel answers, Core returns at least one bias item (each with name, explanation, story connection, alternative perspective) plus a reflection prompt that references the user's situation.

**Acceptance Scenarios**:

1. **Given** story, questions, and answers for a session, **When** assessment is requested, **Then** Core returns at least one bias with all required narrative fields and a reflection prompt
2. **Given** rich Q&A context, **When** assessment is requested, **Then** bias explanations and story connections reference specifics from the user's story (not generic filler)
3. **Given** assessment output, **When** the public app presents results, **Then** wording stays reflective and non-clinical (no diagnosis or therapy framing)
4. **Given** multiple plausible biases in the narrative, **When** assessment completes, **Then** Core may return more than one bias without an upper limit

---

### User Story 3 - Secure service access (Priority: P2)

Only the authorized public backend may call Core; credentials must not be exposed to end users or the public repository.

**Why this priority**: Core holds proprietary prompts and provider access; misuse would leak IP or incur cost.

**Independent Test**: Requests without valid service credentials are rejected; valid credentials allow both reflection endpoints.

**Acceptance Scenarios**:

1. **Given** a request without valid service authentication, **When** any reflection endpoint is called, **Then** access is denied
2. **Given** valid service authentication, **When** reflection endpoints are called with valid payloads, **Then** requests are accepted for processing

---

### Edge Cases

- What happens when the AI provider fails mid-request? — Core signals provider failure so the public app can retry (up to its retry policy) and surface a friendly error without corrupting session data
- What happens when model output is not valid structured data? — Core must not return malformed payloads; failed parses trigger retry or error paths per service policy
- How does Core handle offensive or unsafe story content? — Documented for future content filtering; MVP may pass through with prompt guardrails only
- What happens when question or assessment generation exceeds acceptable latency? — Public app targets first questions within 5 seconds of story submit; Core should be designed to meet that SLA under normal load

## Requirements

### Functional Requirements

- **FR-001**: Core MUST accept a story between 50 and 3000 characters for question generation
- **FR-002**: Core MUST return a batch of **2 to 5** contextual follow-up questions per question-generation request
- **FR-003**: Core MUST return an `isComplete` indicator with the question batch for downstream flow control
- **FR-004**: Core MUST accept story, questions array, and answers array for assessment generation
- **FR-005**: Core MUST return **at least one** cognitive bias item per assessment; there is **no maximum** count
- **FR-006**: Each bias item MUST include: name, explanation, story connection, and alternative perspective with meaningful minimum content length
- **FR-007**: Core MUST return a reflection prompt string with meaningful minimum length
- **FR-008**: Core MUST return all AI outputs as structured JSON matching the agreed public integration contract
- **FR-009**: Core MUST authenticate callers via shared service credentials (bearer token)
- **FR-010**: Core MUST NOT emit clinical diagnoses, therapy recommendations, or psychiatric advice
- **FR-011**: Core MUST keep prompts, model configuration, and provider secrets out of the public repository
- **FR-012**: Core MUST remain stateless per request (session persistence is owned by the public application)

### Key Entities

- **Reflection session reference**: Opaque id supplied by the public app; Core does not own session storage
- **Story**: User's initial personal narrative (50–3000 characters)
- **Question batch**: 2–5 AI-generated follow-up questions returned in one response
- **Q&A context**: Parallel lists of questions and user answers used for assessment input
- **Bias item**: Named bias with explanation, story-specific connection, and alternative perspective
- **Assessment**: Collection of bias items plus a closing reflection prompt

## Success Criteria

### Measurable Outcomes

- **SC-001**: Valid question-generation responses parse successfully in the public app on >99% of successful Core responses
- **SC-002**: Valid assessment responses parse successfully in the public app on >99% of successful Core responses
- **SC-003**: Question batches always contain between 2 and 5 questions when Core returns success
- **SC-004**: Successful assessments always contain at least one bias item
- **SC-005**: At least 90% of sampled assessment outputs include story-specific references in bias explanations or connections (quality review on golden set)
- **SC-006**: Unauthorized requests are rejected 100% of the time in integration tests
- **SC-007**: End-to-end reflection journey (public app + Core) completes without Core exposing secrets or prompts in client-visible channels

## Assumptions

- English is the primary language for MVP stories and outputs
- The public `biassemble` backend orchestrates timing, retries, and session state; Core focuses on AI generation only
- Question and assessment contracts match public `contracts.ts` (2–5 questions; min 1 bias, no max)
- Provider selection, rate limits, and cost controls are decided inside the private Core repository
- Content filtering before AI processing may be added in a later feature; MVP relies on prompt guardrails
- Persuasion analysis, rewrite engine, RAG, and vector storage are out of scope for this feature
