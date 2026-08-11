import type { GrounnelSearchCallStore } from "../../src/persistence/grounnel-search-call-store.js";

/** Test double for the Postgres-backed search-call store (D023 §6 — best-effort, never on the critical path). */
export class NoopGrounnelSearchCallStore implements GrounnelSearchCallStore {
  recordSearchCall(): void {}
}
