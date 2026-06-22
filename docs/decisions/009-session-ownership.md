# D009 — Session Ownership and API Surface

**Decision**: Core is stateless per request — session persistence is owned by the public app. `stage` and `scope` are DB-only fields stamped by the orchestrator, not exposed in API. Single route `POST /v1/reflection/assessment` with `mode` in body (not separate endpoints).

**Why**: Separation of concerns. The API contract is what the client needs; stage/scope are internal tracking metadata. Unified endpoint is forward-compatible with future modes.

**Do not**: Add stage/scope to API responses. Create separate routes per mode. Core must not own public session state.

**Source**: specs/001-reflection-core/spec.md (FR-012), specs/002-reasoning-infrastructure/plan.md
