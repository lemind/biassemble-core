# Spec: Grounnel API Surface (`POST /extract` + `GET /status/:id`)

Written via the `spec-driven-development` skill. Source of truth for scope: `initial-context.md` (SPEC-GROUNNEL v10) + `docs/decisions/019-grounnel-pipeline-trust-boundary.md` + `docs/decisions/020-grounnel-routes-through-biassemble-backend.md`. This spec covers **only what's buildable in this repo** — the new API surface, pipeline, gates, and state. Grounnel's own frontend is out of scope here regardless of where it ends up hosted (see Open Questions) — but per D020, it does **not** call this repo directly; see below.

## Objective

Add a second, self-contained API surface to biassemble-core — `POST /extract` and `GET /status/:id` — that lets a caller paste arbitrary text and get every factual claim in it checked against the open web, independently of the existing `/audit` endpoint (which requires `sources[]` up front and stays unchanged for its B2B callers).

**User:** `biassemble/backend`, proxying on behalf of Grounnel's frontend — **not** the frontend directly. D020 reverses SPEC-GROUNNEL v10 §3a's "no intermediary" call: `biassemble/backend` already exists, already holds `AI_CORE_API_KEY` server-side for its other calls into this repo, and Grounnel's frontend calling it directly would require exposing that secret client-side. `/extract` therefore requires `AI_CORE_API_KEY` via `authHook`, same as `/audit` — it is **not** a public, unauthenticated endpoint (this supersedes v10 §3c's original framing; see Boundaries and D020 §4).

**Success looks like:** a caller can `POST /extract` with pasted text, get a claim list back within ~3 seconds (before any verification), then poll `GET /status/:id` every 10s and watch claims resolve to `supported` / `partially_supported` / `unsupported` / `contradicted` / `unverifiable`, each with a verbatim passage and real source URLs, with a score computed server-side on every poll.

## Assumptions

Stated up front, per the `spec-driven-development` skill's Phase 1 — the numbered citations elsewhere in this document (`Assumption N`) resolve to this list, which previously existed only in conversation and not as a written section (found during a consistency review).

1. **Scope is biassemble-core only.** Grounnel's frontend doesn't exist as a repo yet; this spec covers the new API surface in this repo only. *(Still holds — D020 additionally establishes that the frontend never calls this repo directly regardless of where it's hosted.)*
2. **Same codebase, same deploy.** New routes/orchestrators/persistence live in `biassemble-core/src/`, following the existing `routes/ → orchestrators/ → prompts/` pattern. *(Still holds.)*
3. **`SearchProvider`'s first concrete implementation is Tavily**, not Exa — cited at Tech Stack and Open Questions. Not yet confirmed; see Open Questions.
4. **Redis client: `@upstash/redis`** (official SDK, REST-based). *(Still holds, no open question attached.)*
5. **Rate-limit default: 5 `/extract` submissions per IP per hour**, env-configurable — cited at Boundaries and Success Criteria. Placeholder, not yet confirmed; see Open Questions. *(D020 demoted this from primary control to defense-in-depth, but didn't change the placeholder number itself.)*
6. **Caps: `maxClaims` default 100, search cap tied to it 1:1** (one search per claim, §4.3) — cited at Boundaries and Success Criteria. Placeholder, not yet confirmed; see Open Questions.

## Tech Stack

Same stack as the rest of this repo — no new runtime, no new deploy target:

- TypeScript, Node (ESM), Fastify 5 for routing
- Zod 4 for request/response contracts
- `@google/generative-ai` for EXTRACT/VERIFY (Gemini, `GEMINI_MODEL` — currently `gemini-2.5-flash-lite`)
- **New dependency:** `@upstash/redis` — Redis client for audit state + search/fetch cache (D019 §4)
- **Planned dependency, not yet confirmed:** Tavily REST API via plain `fetch` (no SDK needed) — `SearchProvider`'s current planned first implementation (Assumption 3); switching to Exa remains an open decision, see Open Questions
- Deploy: Vercel, Fluid Compute, no change to `vercel.json`'s `maxDuration: 300` (v10 §11 — 240s budget already fits)

## Commands

Same as this repo's existing commands — nothing new to invoke:

```
Dev:       pnpm dev
Build:     pnpm build
Test:      pnpm test           # vitest watch
Test once: pnpm test:run
Typecheck: pnpm typecheck
```

## Project Structure

New files, following the existing `routes/ → orchestrators/ → prompts/` split (`audit.ts` is the template):

```
src/routes/grounnel.ts                    → registerGrounnelRoutes(server, services): POST /extract, GET /status/:id
src/contracts/grounnel.schemas.ts         → Zod: ExtractRequest, StatusResponse, ClaimSchema (grounnel variant), ScoreSchema
src/orchestrators/grounnel/
  extract.service.ts                      → runs EXTRACT + pre-search opinion filter, writes initial claim list
  pipeline.service.ts                     → per-claim orchestration: search → fetch → passage filter → VERIFY → gates → write
  gates.ts                                → gate #1 (contradiction evidence), gate #2 (numeric normalization) — reuse B2B reconcilers where the shape matches, D018 §5
  opinion-filter.ts                       → gate #3, rule-based first
  passage-filter.ts                       → gate #4, rule-based, lexical-presence only (known gap, D019 §2)
src/providers/search/
  search-provider.ts                      → SearchProvider interface (D019 §2 "provider abstraction scope")
  tavily-provider.ts                      → first implementation
src/persistence/grounnel-store.ts         → Redis hash-per-audit read/write (D019 §4): HSET per claim, one HGETALL per poll
src/lib/rate-limit.ts                     → IP-based limiter for /extract — now defense-in-depth, not the primary control (D020 §4)
tests/unit/orchestrators/grounnel/        → gate logic, opinion filter, passage filter — pure functions, no network
tests/integration/grounnel-extract.test.ts, grounnel-status.test.ts, grounnel-rate-limit.test.ts
```

Reused as-is, not duplicated: EXTRACT/VERIFY prompt logic and batching convention (`src/prompts/audit/`), evidence-binding discipline (D002), repair pipeline (D004).

## Code Style

Match `src/routes/audit.ts`'s real pattern — typed service interfaces injected into `register*Routes`, `Schema.parse()` inside a try/catch (not `.safeParse()` with an inline early return — that's a different idiom this codebase doesn't use), `reply.status()` (not `.code()`), a `{ error, details }` shape on `ZodError`, one `MODULE` constant per file for logging:

```ts
const MODULE = "routes-grounnel";

export interface GrounnelStore {
  createAudit(data: { text: string; maxClaims: number; claims: Array<Pick<Claim, "id" | "text">>; truncated: boolean }): Promise<{ id: string }>;
  writeClaimResult(auditId: string, claimId: string, result: ClaimResult): Promise<void>;
  getStatus(id: string): Promise<StatusResponse | null>;
}

export function registerGrounnelRoutes(
  server: FastifyInstance,
  services: { grounnelStore: GrounnelStore; pipeline: GrounnelPipeline; rateLimiter: RateLimiter }
) {
  server.post("/extract", { preHandler: [authHook] }, async (request, reply) => {
    try {
      const body = ExtractRequestSchema.parse(request.body);
      // ...
      return reply.status(202).send({ id: auditId });
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "Invalid request body", details: error.issues });
      }
      logger.error({ module: MODULE, operation: "POST /extract", error, requestId: request.id }, "Extract submission failed");
      return reply.status(502).send({ error: "Extract submission failed" });
    }
  });
}
```

`authHook` — same one `/audit` already uses (`src/lib/auth.js`) — gates `/extract` on `AI_CORE_API_KEY` (D020 §3, §4). This is the one deviation from `audit.ts`'s pattern: `/audit`'s route registration doesn't need a separate rate limiter in front of it since it's already behind auth; `/extract` keeps `rateLimiter` too, now as defense-in-depth rather than the primary control. `writeClaimResult` is the third `GrounnelStore` method (plan.md §1, tasks.md T007) — the one that actually persists a verdict as each VERIFY batch completes; omitting it here (an earlier draft did) would leave `pipeline.service.ts` with nothing to call. `createAudit`'s `claims` param was added during T007's implementation — the earlier signature had no way for any method to ever receive a claim's `text`, a required, non-nullable field on every claim. `RedisGrounnelStore` (T007) also derives top-level `status`/`progress`/`score` from claim state on every `getStatus` read rather than storing them as mutable fields — deviates from D019 §4's illustrative `HSET ... meta '{"status":"verifying",...}'` example, but removes any chance of `meta` drifting out of sync with the claims that are the actual source of truth. `createAudit`'s `truncated` param was added post-review (`/code-review medium`, finding #2) — `caps_hit` was originally derived as `total >= maxClaims`, which false-positives whenever EXTRACT genuinely returns exactly the cap with nothing cut; the caller now passes its own real truncation signal instead.

No `mode`-style branching needed here (D018 §1's invariant doesn't apply — this is a separate route tree, not a shared orchestrator with `/audit`). Nullable fields use `field: Type | null`, never `field?: Type | null` (AGENTS.md rule 9).

## Testing Strategy

- **Unit** (`tests/unit/orchestrators/grounnel/`): gate #1–#4 and the opinion/passage filters as pure functions — no network, no Redis, no Gemini. This is where most of the actual logic coverage lives, since D019 §2's whole premise is that these gates are deterministic code.
- **Integration** (`tests/integration/`): real Fastify instance, `MockProvider` standing in for Gemini (existing pattern), an in-memory fake for `SearchProvider` and `GrounnelStore` — assert the full `POST /extract` → `GET /status/:id` contract shape, including `not_checked` on a forced batch failure and `caps_hit` on an exceeded cap.
- **Not covered by automated tests at P0:** real Tavily calls, real Redis — those are the one manual/live check before shipping (mirrors D019 §3's benchmark methodology: a small hand-run set, not a golden set, promoted to one once the harness exists per v10 §9).
- **Post-P0 addition (D022 §1):** the "promoted to one once the harness exists" line above has happened — `evaluations/golden/grounnel/live-eval-golden-set.json` (11 real cases) + `src/evaluation/run-grounnel-eval.ts` run real, non-mocked Gemini/Tavily calls via a local CLI (`pnpm eval:grounnel`) or an Inngest job (`pnpm eval:grounnel:trigger`). Deliberately not wired into `.github/workflows/test.yml` (real API cost/latency) — stays a manually/Inngest-triggered gate, run before shipping prompt or gate changes to this surface (D022 §4's validation criterion).

## Boundaries

- **Always:** run `pnpm typecheck` + `pnpm test:run` before any commit touching this surface; every `contradicted` verdict passes through gate #1 before reaching a response; `not_checked` stays its own field, never folded into a verdict bucket (§13 non-negotiable, carried into this spec); `/extract` requires `authHook` — it is not reachable without `AI_CORE_API_KEY` (D020 §3).
- **Ask first:** adding `@upstash/redis` and any Tavily client as new dependencies (AGENTS.md — deps require explicit approval); the exact rate-limit number (Assumption 5, currently a placeholder); `maxClaims`/search-cap defaults (Assumption 6); any change to the `/status/:id` response shape once a frontend depends on it; anything in `biassemble/backend` beyond the two thin proxy functions D020 scopes (new routes/services there beyond `extractClaims`/`getGrounnelStatus` are a new decision, not covered by D020).
- **Never:** call Gemini's native `google_search` tool for retrieval (D019 §3 — structurally disqualified, not a quality question); read-modify-write a single Redis JSON blob for audit state (D019 §4 — use per-claim hash fields); net contradictions into the score (§13); let the passage-relevance filter's coreference gap get "fixed" with a hedged rule that doesn't actually resolve it (D019 §2 — leave it named, not papered over); add session/user tables, Inngest wiring, or any state to `biassemble/backend` for Grounnel — it is a stateless pass-through only, D019's Redis remains the sole state store (D020 §5, explicit "Do not").

## Success Criteria

- `POST /extract` runs EXTRACT **synchronously within the request** — the claim list is written to Redis and returned as `202 { id }` before the handler returns, not "accepted, EXTRACT will run shortly." This is the guarantee the whole two-call design exists for (v10 §2/§3b); an async-EXTRACT implementation would satisfy the response shape while breaking the "claim list renders immediately" requirement, so it's called out here explicitly rather than left to be inferred from `202`.
- `GET /status/:id` returns full current state every call, matches the v10 §3b shape exactly (`status`, `progress`, `claims[]`, `score`, `caps_hit`).
- A `contradicted` verdict never reaches the client without gate #1 having verified the evidence substring against the actually-fetched passage.
- An opinion-shaped claim (gate #3) routes to `unverifiable` **without a `SearchProvider` call being made for it** — proven by a unit test asserting zero search invocations for such a claim, not just the correct verdict. This is the one gate with a real cost consequence (§4.1's search-quota constraint), not just a correctness one, so it needs its own criterion rather than riding on gate #1/#2's coverage.
- A passage that fails gate #4's relevance check is never sent to VERIFY — proven by a unit test asserting the VERIFY call is never made for a filtered-out passage. Includes one `test.todo(...)` case for the coreference gap named in D019 §2 (plan.md §5, tasks.md T006) — a visible, named pending case in every run's output, not a permanently-red test.
- A failed VERIFY batch marks its claims `not_checked` and the run continues — proven by an integration test that force-fails one batch mid-run.
- Exceeding `maxClaims` or the search cap sets `caps_hit: true` and marks the remainder `not_checked`, never silently drops them from the denominator.
- `/extract` rejects an unauthenticated request with a 401 (`authHook`, D020 §3) and rejects any request exceeding the configured per-IP limit with a 429. The criterion is the mechanism (auth required, limit enforced), not a specific number — the actual threshold lives as a named constant per plan.md §3's mitigation, not hardcoded into this criterion.
- No Postgres dependency anywhere in this surface (D019 §4); no session/user schema added to `biassemble/backend` for Grounnel (D020 §5).

## Not in P0

- **User-attached documents as an additional claim source.** P0 only finds sources via web search/fetch (`ClaimSourceSchema`'s `kind: "web"` variant). `ClaimSourceSchema` is already a discriminated union with a `kind: "attached"` variant (`{ kind, title, documentId }`, no url/domain/status — a caller-supplied document isn't independently fetched, so D019 §2's web-source fields don't apply to it) so this doesn't force a breaking wire-shape change later, but no ingestion, upload, storage, or pipeline handling exists yet. Not decided: how a document reaches `POST /extract` (inline with `text`? a separate upload step?), whether/how D019 §2's trust boundary applies to a source the caller vouches for rather than one independently fetched, or how "attached" sources interact with Success Criteria's "real source URLs" framing (attached sources have none).

## Post-P0

Real, non-mocked golden-set runs (D022) found and fixed three production bugs not caught by mocked unit/integration tests: a bare-array Gemini response silently nulling valid EXTRACT/VERIFY data (`repair.ts`, shared infra), a threshold-claim gap in gate #2 ("surpassed $X" only checked equality, not direction), and a verdict/reason binding mismatch (new `applyReasonConsistencyGate`, reusing audit's proven contradiction-language regex). A VERIFY prompt rewrite (v2.0.0) was also shipped and measured against the golden set — confirmed to fix the binding-mismatch class but **not** a bare "X, not Y" negation case (`g05`) even with a matching worked example in the prompt, an explicitly recorded negative result (D022 §3) so it isn't re-attempted blind. A code-side gate for that remaining gap is planned (D022 §4, tasks.md T021) with a named, deliberate recall/precision tradeoff; a second known gap (multi-date role misclassification, `g04`) is investigate-first, not build-first (D022 §4, tasks.md T022).

## Open Questions

- ~~Grounnel's frontend repo doesn't exist yet — where does it live and how does it reach core?~~ **Resolved by D020**: it calls `biassemble/backend`, which proxies to this repo — it never calls `biassemble-core` directly, so where the frontend itself is hosted no longer affects this repo's contract the way it used to.
- **Tavily vs Exa as the first `SearchProvider`** (Assumption 3) — confirm Tavily, or start with Exa instead.
- **Exact rate-limit number** (Assumption 5) and **`maxClaims`/search-cap defaults** (Assumption 6) — placeholders above, need a real number before P0 ships.
- **Query rewrite** (claim → search query) — v10 §10 leaves this open; this spec doesn't resolve it either, since it needs real pasted-article data first.
- **Real-deployment latency measurement for the added `biassemble/backend` hop** (D020 §6) — judged negligible against the 10s poll interval, not yet measured.
