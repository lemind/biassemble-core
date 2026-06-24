import type { LlmCallRecord, LlmCallStage } from '../persistence/types';
import type { LlmCallStore } from '../persistence/ports';

export interface ReliabilityMetricsFilter {
  timeRange?: { start: Date; end: Date };
  provider?: string;
  model?: string;
  stage?: LlmCallStage;
}

export interface ReliabilityMetrics {
  totalCallCount: number;
  primaryCallCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  callSuccessRate: number;
  timeoutRate: number;
  fallbackRate: number;
  schemaValidationFailureRate: number;
  providerErrorRate: number;
  parseErrorRate: number;
}

export async function computeReliabilityMetrics(
  filter: ReliabilityMetricsFilter,
  store: LlmCallStore
): Promise<ReliabilityMetrics> {
  const calls = await store.getCallsForMetrics();
  const filtered = applyFilter(calls, filter);
  return computeMetricsFromCalls(filtered);
}

function applyFilter(calls: LlmCallRecord[], filter: ReliabilityMetricsFilter): LlmCallRecord[] {
  return calls.filter(call => {
    if (filter.timeRange) {
      const callTime = new Date(call.createdAt);
      if (callTime < filter.timeRange.start || callTime > filter.timeRange.end) {
        return false;
      }
    }
    if (filter.provider && call.provider !== filter.provider) {
      return false;
    }
    if (filter.model && call.model !== filter.model) {
      return false;
    }
    if (filter.stage && call.stage !== filter.stage) {
      return false;
    }
    return true;
  });
}

function computeMetricsFromCalls(calls: LlmCallRecord[]): ReliabilityMetrics {
  if (calls.length === 0) {
    return {
      totalCallCount: 0,
      primaryCallCount: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      callSuccessRate: 0,
      timeoutRate: 0,
      fallbackRate: 0,
      schemaValidationFailureRate: 0,
      providerErrorRate: 0,
      parseErrorRate: 0,
    };
  }

  const totalCallCount = calls.length;
  const primaryCallCount = calls.filter(c => c.callType === 'primary').length;

  // Latency metrics - filter out null durations
  const durations = calls
    .map(c => c.durationMs)
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b);
  const avgLatencyMs = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;
  const p50LatencyMs = percentile(durations, 50);
  const p95LatencyMs = percentile(durations, 95);
  const p99LatencyMs = percentile(durations, 99);

  // Status rates
  const successCount = calls.filter(c => c.status === 'success').length;
  const timeoutCount = calls.filter(c => c.status === 'timeout').length;
  const callSuccessRate = successCount / totalCallCount;
  const timeoutRate = timeoutCount / totalCallCount;

  // Call type rate - fallback rate is relative to primary calls
  const fallbackCount = calls.filter(c => c.callType === 'fallback').length;
  const fallbackRate = primaryCallCount > 0 ? fallbackCount / primaryCallCount : 0;

  // Failure type rates
  const schemaValidationCount = calls.filter(c => c.failureType === 'schema_validation').length;
  const providerErrorCount = calls.filter(c => c.failureType === 'provider_error').length;
  const parseErrorCount = calls.filter(c => c.failureType === 'parse_error').length;
  
  const schemaValidationFailureRate = schemaValidationCount / totalCallCount;
  const providerErrorRate = providerErrorCount / totalCallCount;
  const parseErrorRate = parseErrorCount / totalCallCount;

  return {
    totalCallCount,
    primaryCallCount,
    avgLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    callSuccessRate,
    timeoutRate,
    fallbackRate,
    schemaValidationFailureRate,
    providerErrorRate,
    parseErrorRate,
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;

  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower]!;
  }

  const lowerValue = sortedValues[lower]!;
  const upperValue = sortedValues[upper]!;
  const weight = index - lower;
  return lowerValue * (1 - weight) + upperValue * weight;
}
