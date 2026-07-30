<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
specs/008-b2b/plan.md

Supporting artifacts:
- specs/008-b2b/spec.md — feature specification (3 user stories, 21 functional requirements)
- specs/008-b2b/research.md — technical decisions: retrieval stub, ID strategy, prompt registry reuse, numeric fact shape, score computation, VERIFY batching, injection hard-stop
- specs/008-b2b/data-model.md — new `audit` pg schema entities: Audit, Claim, Verdict, SourcePassage, ScoreSummary
- specs/008-b2b/contracts/audit-endpoint.md — POST /audit request/result contract
- specs/008-b2b/quickstart.md — golden-set validation commands, pass bars, "done" definition
- docs/decisions/018-audit-mode-flag.md — ADR (authoritative decision record)
<!-- SPECKIT END -->

## Conventions

**Commit messages**: one line, `feat|fix|chore(T0XX): <short desc>`. Never commit without explicit user request.

**Code comments**: max ~200 chars per comment. State what/why in one line; point to the decision doc (`docs/decisions/0NN-*.md` §X) for rationale, incident history, or design tradeoffs — never restate them inline. If a comment needs more than one line to justify itself, that justification belongs in the ADR, not the code.
