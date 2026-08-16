# D029 — Self-Heal a Run Stuck at "verifying" After a Vercel `maxDuration` Kill

## §1. Trigger

Live-testing found a real run (`checked: 44, total: 44`, every claim individually `status: "done"`)
stuck reporting `status: "verifying"` for over 15 minutes, confirmed against the deployed instance.

## §2. Root cause (verified against real code, not assumed)

`pipeline.service.ts`'s `run()` executes entirely inside one `waitUntil()` background call after
the `202` response (`routes/grounnel.ts` — no external queue, D020 §3), bounded by `vercel.json`'s
`maxDuration: 300`. `run()` sets `escalating: true` before its main loop (D026 §14/§15) and clears
it in a `finally` block specifically so every exit path — success, rate-limit skip, or a thrown
error — clears the flag. That `finally` assumes a JS-level unwind. A hard platform timeout kill is
not a JS exception: Vercel terminates the function outright, and the `finally` block never runs.
A run whose escalation phase runs past 300s is left with `escalating: true` permanently stuck in
Redis (7-day TTL), even though every claim already finished — `getStatus()`'s formula
(`checked === total && !escalating`) then reports `"verifying"` forever.

## §3. Decision

`RedisGrounnelStore.getStatus()` self-heals: if every claim is checked and the audit's
`lastActivityAt` (already tracked, used to freeze `elapsed_seconds`) hasn't moved in over
`STUCK_ESCALATION_TIMEOUT_MS` (8 minutes) while `escalating` is still true, report `"done"`
instead of `"verifying"`.

**Why 8 minutes is safe, not just generous**: `maxDuration` bounds the *entire* background
execution (main pass + escalation together). Anything still genuinely alive cannot have gone
silent longer than ~300s without already being killed by the platform — so a threshold
meaningfully above 300s cannot false-trigger on a real, still-running escalation; it only ever
fires on a run that is provably already dead. 8 minutes = 300s + a ~3-minute buffer for clock
skew between Redis's write timestamp and Vercel's actual kill moment.

A `logger.warn` fires when the self-heal actually triggers, so how often this masks a real
`maxDuration` kill (vs. genuine completions) is observable rather than silent.

## §4. Explicitly not doing

- **Making the pipeline resumable/chunked** (e.g. a real queue/step-function) — would remove the
  underlying `maxDuration` exposure entirely, but reopens D020 §3's deliberate "no external queue"
  call. Left as a separate, larger follow-up if `maxDuration` kills recur often enough to justify it.
- **Resetting `meta.escalating` to `false` in Redis when the self-heal fires** — `getStatus()` is
  read-only by convention elsewhere in this store; re-deriving `"done"` from the stale timestamp on
  every poll is cheap and sufficient. Not reachable in this codebase for a live run to un-kill
  itself afterward and write again (`POST /extract` always mints a fresh `auditId`; no retry path
  resumes an existing one), so there's no actual state to reconcile once the flag is set.

## Consequences

- `src/persistence/grounnel-store.ts`: `STUCK_ESCALATION_TIMEOUT_MS`, `getStatus()`'s status formula.
- New tests in `tests/unit/persistence/grounnel-store.test.ts`: stale-and-stuck → `done`,
  incomplete-and-stale → still `verifying` (never marks a genuinely unfinished run done), and the
  boundary case (stale but under the timeout) → still `verifying`.

**Source**: `biassemble-core` branch `011-gr-upd1`, 2026-08-16.
