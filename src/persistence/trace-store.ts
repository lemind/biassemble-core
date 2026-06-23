import type { TraceStore } from './ports';
import type { TraceRecord } from './types';
import { persistTrace, getTrace } from '../db/queries';

export class DrizzleTraceStore implements TraceStore {
  async persistTrace(runId: string, trace: any): Promise<TraceRecord> {
    return persistTrace(runId, trace);
  }

  async getTrace(runId: string): Promise<TraceRecord | null> {
    return getTrace(runId);
  }
}
