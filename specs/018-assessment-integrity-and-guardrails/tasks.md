# Tasks — 018 entity collisions

Source: FINDINGS.md §Entity collisions, plus run `fe3ddf20` (2026-09-25): "BMNL connects nail
technicians…" came back `supported` @0.9, citing mnbgo.com (Millennial Nail Bar). "BMNL" appears in
none of the passages VERIFY saw. Tier 1 answered `unverifiable` (correct); escalation replaced it.

- [x] **T001** Acronym-presence gate: a `supported`/`partially_supported` verdict whose claim acronym
  (4+ chars) appears in no passage, spelled or expanded in any case ("World War II" for WWII), is
  downgraded to `unsupported` with a namesake reason. Pure and downgrade-only. `contradicted` is out of
  scope (Cardinal Rule). It doesn't touch `sameEntity`/`subject_entity` (refuted, 013 T30).
  It checks only the pages VERIFY cited: live run `54f84737` escaped a whole-pool check because an
  uncited "BMNL Lab" page was pooled. Known limit: 3-char and word-shaped acronyms (CEO, WHO) never fire.
- [x] **T002** Simulation over stored VERIFY answers (sentence slices, so an upper bound): 97
  affirmations with a 4+ char acronym; 5 firings, all BMNL namesakes, 0 on right-entity claims. The
  cited-only check adds exactly one (run `54f84737`).
- [x] **T003** Unit tests in `gates.test.ts`: the BMNL case fires; the expansion, roman numeral,
  shouting-caps and present-acronym cases do not.
- [~] **T004** Dropped: golden case. A real acronym's verdict depends on what search returns (BMNL
  exists); a made-up one returns nothing and passes without the gate. Unit replay + T002 cover it.

Out of scope: namesakes without an acronym (Leo Johnston, SCA; SCA is spelled in both sources).
Those still need entity resolution, which stays parked.
