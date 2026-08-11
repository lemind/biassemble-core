import type { GrounnelGateEventStore } from "../../src/persistence/grounnel-gate-event-store.js";

/** Test double for the Postgres-backed gate-event store (D023 §5 — best-effort, never on the critical path). */
export class NoopGrounnelGateEventStore implements GrounnelGateEventStore {
  recordGateEvents(): void {}
}
