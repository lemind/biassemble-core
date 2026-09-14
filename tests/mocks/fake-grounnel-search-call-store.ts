import type { GrounnelSearchCallStore } from "../../src/persistence/grounnel-search-call-store.js";

type SearchCallData = Parameters<GrounnelSearchCallStore["recordSearchCall"]>[0];
type DiscoveryCallData = Parameters<GrounnelSearchCallStore["recordDiscoveryCall"]>[0];

/** Recording test double — captures every recordSearchCall() invocation. */
export class FakeGrounnelSearchCallStore implements GrounnelSearchCallStore {
  calls: SearchCallData[] = [];
  discoveryCalls: DiscoveryCallData[] = [];
  recordSearchCall(data: SearchCallData): void {
    this.calls.push(data);
  }
  recordDiscoveryCall(data: DiscoveryCallData): void {
    this.discoveryCalls.push(data);
  }
}
