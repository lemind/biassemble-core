# Tasks — 018 entity collisions

Source: FINDINGS.md §Entity collisions, plus run `fe3ddf20` (2026-09-25): "BMNL connects nail
technicians…" came back `supported` @0.9, citing mnbgo.com (Millennial Nail Bar). "BMNL" appears in
none of the passages VERIFY saw. Tier 1 answered `unverifiable` (correct); escalation replaced it.

- [x] **T001** Acronym-presence gate: a `supported`/`partially_supported` verdict whose claim acronym
  (4+ chars) appears in no passage, spelled or expanded in any case ("World War II" for WWII), is
  downgraded to `unsupported` with a namesake reason. Pure and downgrade-only. `contradicted` is out of
  scope (Cardinal Rule). It doesn't touch `sameEntity`/`subject_entity` (refuted, 013 T30).
  Known limits: it checks the whole pooled text, not VERIFY's slice, so an acronym on any pooled page
  suppresses it. 3-char and word-shaped acronyms (CEO, WHO) never fire.
- [ ] **T002** Zero-cost simulation over every stored VERIFY answer before wiring: list every
  firing, read each, and confirm none is a right-entity claim (the must-not-fire check, 015).
- [x] **T003** Unit tests in `gates.test.ts`: the BMNL case fires; the expansion, roman numeral,
  shouting-caps and present-acronym cases do not.
- [ ] **T004** Golden case `g30-namesake-acronym` (kind `silence`); deployed eval, that case only,
  `--repeats 5`.

Out of scope: namesakes without an acronym (Leo Johnston, SCA; SCA is spelled in both sources).
Those still need entity resolution, which stays parked.
