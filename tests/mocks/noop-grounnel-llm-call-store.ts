import type { GrounnelLlmCallStore } from "../../src/persistence/grounnel-llm-call-store.js";

/** Test double for the Postgres-backed LLM-call store (D023 §4 — best-effort, never on the critical path). */
export class NoopGrounnelLlmCallStore implements GrounnelLlmCallStore {
  recordCall(): () => void {
    return () => {};
  }
}
