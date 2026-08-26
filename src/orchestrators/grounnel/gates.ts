// Public barrel for the gate chain, split by theme across gates-*.ts siblings (D031, pure move). Import from here, not the siblings — see docs/decisions/026-verify-retrieval-first-grounding.md.

export * from "./gates-shared.js";
export * from "./gates-text-grounding.js";
export * from "./gates-numeric-and-year.js";
export * from "./gates-reason-grounded.js";
