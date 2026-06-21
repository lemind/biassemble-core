# D010 — Proprietary Isolation and Safety Guardrails

**Decision**: All prompts, model IDs, provider credentials, bias catalog, and eval datasets live in private `biassemble-core`. Public repo has frontend + session API only. Core MUST NOT emit clinical diagnoses, therapy recommendations, or psychiatric advice.

**Why**: Core holds proprietary prompts and provider access — misuse would leak IP or incur cost. Product is non-clinical by design.

**Do not**: Add prompts, model IDs, or LLM API keys to the public repo. Never emit clinical content regardless of user input.

**Source**: specs/001-reflection-core/architecture.md, specs/001-reflection-core/spec.md (FR-010)
