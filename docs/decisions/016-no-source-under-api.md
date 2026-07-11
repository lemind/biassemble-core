# D016 — No TypeScript Source Under `/api`

**Decision**: `/api` contains only build artifacts (`index.js`, copied static assets). All TypeScript source, including the serverless entry point, lives under `src/` (`src/handler.ts`). The build script (`esbuild src/handler.ts → api/index.js`) is the only thing that writes into `/api`.

**Why**: Vercel auto-detects every `.ts` file sitting directly under `/api` as a serverless function candidate, independent of `vercel.json`'s explicit `functions` mapping. With `api/handler.ts` present, this meant two separate compilation pipelines ran on every deploy: our own `esbuild` bundle (fast, no type-checking) and a second, undeclared `@vercel/node` type-check of `api/handler.ts` + `../src` through a second `api/tsconfig.json`.

That second pipeline was silently running clean on every deploy for months — until a routine schema change (two new nullable columns on `runs`) tripped a drizzle-orm generic-inference edge case that only manifested under `api/tsconfig.json`'s settings, not the root `tsconfig.json` that `pnpm typecheck` uses. Result: `pnpm typecheck` passed locally, `vercel deploy` failed, with no way to reproduce the failure without dissecting the actual Vercel build log — because the failure wasn't in our code, it was in a type-check we never intentionally configured. Multiple wrong turns (chasing `noImplicitAny`, chasing TypeScript version drift) came from trying to fix that second pipeline's config instead of asking why it existed at all.

**Do not**: Put `.ts` files directly under `/api`, even as "just build input." Any file matching that path becomes a second, independent function/compile target that Vercel discovers on its own — regardless of what `vercel.json` declares explicitly. If a new serverless entry point is needed, write it under `src/` and point the build script at it, same as `handler.ts`.

**Consequences**:
- Single TypeScript configuration (root `tsconfig.json`), single type-check path (`pnpm typecheck`) — what passes locally is what Vercel sees, full stop.
- `api/handler.ts` (as `src/handler.ts`) now gets real type coverage under `pnpm typecheck`, which it never had before (it wasn't in the root config's `include`).
- No `.vercelignore` needed to hide build sources from Vercel's discovery — nothing to hide.

**Source**: spec-005 deploy investigation, 2026-07-10 — `TS2353` on `runs.ragStartedAt`/`ragCompletedAt` traced through 3 wrong diagnoses (schema mismatch, `noImplicitAny`, TS version) before the actual Vercel build log revealed the redundant auto-detected type-check.
