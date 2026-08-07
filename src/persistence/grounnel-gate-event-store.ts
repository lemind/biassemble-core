import { waitUntil } from "@vercel/functions";
import { insertGrounnelGateEvents } from "../db/queries.js";
import { logger } from "../observability/logger.js";
import type { GrounnelVerdictEnum } from "../contracts/grounnel.schemas.js";
import type { z } from "zod";

type Verdict = z.infer<typeof GrounnelVerdictEnum>;

export interface GateEventInput {
  gate: "reason_consistency" | "implicit_negation" | "contradiction_evidence" | "numeric";
  verdictBefore: Verdict | null;
  verdictAfter: Verdict | null;
  overridden: boolean;
}

export interface GrounnelGateEventStore {
  /** Fire-and-forget (D023 §7). Call AFTER the claim's grounnel_claims insert — claimId has a real FK (D023 §5). */
  recordGateEvents(runId: string, claimId: string, events: GateEventInput[]): void;
}

export class DrizzleGrounnelGateEventStore implements GrounnelGateEventStore {
  recordGateEvents(runId: string, claimId: string, events: GateEventInput[]): void {
    if (events.length === 0) return;
    const rows = events.map((e) => ({ runId, claimId, ...e }));
    waitUntil(
      insertGrounnelGateEvents(rows).catch((err) => {
        logger.warn({ module: "grounnel-gate-event-store", operation: "recordGateEvents", runId, claimId, err }, "Failed to write grounnel_gate_events rows — Redis remains authoritative (D023 §7)");
      })
    );
  }
}
