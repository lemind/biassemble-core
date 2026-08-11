import type { GrounnelGateEventStore, GateEventInput } from "../../src/persistence/grounnel-gate-event-store.js";

/** Recording test double — captures every recordGateEvents() invocation. */
export class FakeGrounnelGateEventStore implements GrounnelGateEventStore {
  calls: Array<{ runId: string; claimId: string; events: GateEventInput[] }> = [];
  recordGateEvents(runId: string, claimId: string, events: GateEventInput[]): void {
    this.calls.push({ runId, claimId, events });
  }
}
