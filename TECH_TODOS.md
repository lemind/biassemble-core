# Tech TODOs

- [ ] `LICENSE` — Choose MIT or Apache 2.0 (Apache recommended for AI/LLM patent protection)
- [ ] `SECURITY.md` — Vulnerability reporting process + security contact email
- [ ] `CONTRIBUTING.md` — PR process, code style, tests required
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant standard
- [ ] `.github/ISSUE_TEMPLATE.md` — Bug report / feature request template
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` — PR checklist template
- [ ] Add badges (build status, tests, license)
- [ ] Link to CONTRIBUTING.md once created


## Grounnel operational (2026-09-02)

- [ ] **No back-pressure at the claim cap — medium.** Run `5031c439` extracted exactly `maxClaims: 100`
      claims and was killed by Vercel's `maxDuration: 300` (`status` left at `verifying`,
      `completed_at` null — the T32 diagnostic working as designed). 203 Gemini + 559 search calls.
      All 100 claims finalised first, so D031's Redis self-heal still reported `done` and user impact
      was nil **this time**; a slightly longer document loses claims instead. MVP fix is a boundary
      check (lower `maxClaims`, or reject over-long input at the API) — not a pipeline change.
