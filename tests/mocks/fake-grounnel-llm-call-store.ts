import type { GrounnelLlmCallStore } from "../../src/persistence/grounnel-llm-call-store.js";
import type { LlmCallCompletionInfo } from "../../src/orchestrators/llm-json-call.js";

type RecordCallContext = Parameters<GrounnelLlmCallStore["recordCall"]>[0];

/** Recording test double — captures every recordCall() context and every completion it was later invoked with. */
export class FakeGrounnelLlmCallStore implements GrounnelLlmCallStore {
  recordCallContexts: RecordCallContext[] = [];
  completions: Array<{ context: RecordCallContext; info: LlmCallCompletionInfo }> = [];

  recordCall(context: RecordCallContext): (info: LlmCallCompletionInfo) => void {
    this.recordCallContexts.push(context);
    return (info: LlmCallCompletionInfo) => {
      this.completions.push({ context, info });
    };
  }
}
