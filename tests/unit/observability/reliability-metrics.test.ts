import { describe, it, expect, vi } from 'vitest';
import { computeReliabilityMetrics } from '../../../src/observability/reliability-metrics';
import type { LlmCallRecord } from '../../../src/persistence/types';
import type { LlmCallStore } from '../../../src/persistence/ports';

function createMockStore(allCalls: LlmCallRecord[]): LlmCallStore {
  return {
    recordCall: vi.fn(),
    updateParsedOutput: vi.fn(),
    updateFailure: vi.fn(),
    getCallsForMetrics: vi.fn().mockImplementation(async (filter) => {
      // Simulate DB filtering
      return allCalls.filter(call => {
        if (filter?.timeRange) {
          const callTime = new Date(call.createdAt);
          if (callTime < filter.timeRange.start || callTime > filter.timeRange.end) {
            return false;
          }
        }
        if (filter?.provider && call.provider !== filter.provider) {
          return false;
        }
        if (filter?.model && call.model !== filter.model) {
          return false;
        }
        if (filter?.stage && call.stage !== filter.stage) {
          return false;
        }
        return true;
      });
    }),
  } as unknown as LlmCallStore;
}

describe('computeReliabilityMetrics', () => {
  it('should return zero metrics for empty dataset', async () => {
    const store = createMockStore([]);
    const metrics = await computeReliabilityMetrics({}, store);

    expect(metrics.totalCallCount).toBe(0);
    expect(metrics.primaryCallCount).toBe(0);
    expect(metrics.avgLatencyMs).toBe(0);
    expect(metrics.p50LatencyMs).toBe(0);
    expect(metrics.p95LatencyMs).toBe(0);
    expect(metrics.p99LatencyMs).toBe(0);
    expect(metrics.callSuccessRate).toBe(0);
    expect(metrics.timeoutRate).toBe(0);
    expect(metrics.fallbackRate).toBe(0);
    expect(metrics.schemaValidationFailureRate).toBe(0);
    expect(metrics.providerErrorRate).toBe(0);
    expect(metrics.parseErrorRate).toBe(0);
  });

  it('should compute metrics for single successful call', async () => {
    const calls: LlmCallRecord[] = [
      {
        id: '1',
        sessionId: 's1',
        stage: 'assessment',
        callType: 'primary',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        promptVersion: 'v1',
        rawResponse: '{}',
        parsedOutput: null,
        status: 'success',
        failureType: null,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        startedAt: '2024-01-01T00:00:00Z',
        endedAt: '2024-01-01T00:00:01Z',
        durationMs: 1000,
        errorMessage: null,
        createdAt: '2024-01-01T00:00:01Z',
      },
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({}, store);

    expect(metrics.totalCallCount).toBe(1);
    expect(metrics.primaryCallCount).toBe(1);
    expect(metrics.avgLatencyMs).toBe(1000);
    expect(metrics.p50LatencyMs).toBe(1000);
    expect(metrics.p95LatencyMs).toBe(1000);
    expect(metrics.p99LatencyMs).toBe(1000);
    expect(metrics.callSuccessRate).toBe(1);
    expect(metrics.timeoutRate).toBe(0);
    expect(metrics.fallbackRate).toBe(0);
    expect(metrics.schemaValidationFailureRate).toBe(0);
    expect(metrics.providerErrorRate).toBe(0);
    expect(metrics.parseErrorRate).toBe(0);
  });

  it('should compute correct rates for mixed statuses', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100),
      createCall('2', 'success', null, 'primary', 200),
      createCall('3', 'timeout', 'timeout', 'primary', 5000),
      createCall('4', 'error', 'schema_validation', 'primary', 50),
      createCall('5', 'success', null, 'fallback', 150),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({}, store);

    expect(metrics.totalCallCount).toBe(5);
    expect(metrics.primaryCallCount).toBe(4);
    expect(metrics.callSuccessRate).toBe(0.6); // 3 success / 5 total
    expect(metrics.timeoutRate).toBe(0.2); // 1 timeout / 5 total
    expect(metrics.fallbackRate).toBe(0.25); // 1 fallback / 4 primary
    expect(metrics.schemaValidationFailureRate).toBe(0.2); // 1 schema_validation / 5 total
    expect(metrics.providerErrorRate).toBe(0); // 0 provider_error / 5 total
    expect(metrics.parseErrorRate).toBe(0); // 0 parse_error / 5 total
  });

  it('should compute percentiles correctly', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100),
      createCall('2', 'success', null, 'primary', 200),
      createCall('3', 'success', null, 'primary', 300),
      createCall('4', 'success', null, 'primary', 400),
      createCall('5', 'success', null, 'primary', 500),
      createCall('6', 'success', null, 'primary', 600),
      createCall('7', 'success', null, 'primary', 700),
      createCall('8', 'success', null, 'primary', 800),
      createCall('9', 'success', null, 'primary', 900),
      createCall('10', 'success', null, 'primary', 1000),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({}, store);

    expect(metrics.avgLatencyMs).toBe(550);
    expect(metrics.p50LatencyMs).toBe(550); // median of 10 values
    expect(metrics.p95LatencyMs).toBe(955); // 95th percentile (linear interpolation)
    expect(metrics.p99LatencyMs).toBe(991); // 99th percentile (linear interpolation)
  });

  it('should filter by provider', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100, 'gemini'),
      createCall('2', 'success', null, 'primary', 200, 'openai'),
      createCall('3', 'success', null, 'primary', 300, 'gemini'),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({ provider: 'gemini' }, store);

    expect(metrics.totalCallCount).toBe(2);
    expect(metrics.avgLatencyMs).toBe(200);
  });

  it('should filter by model', async () => {
    const calls: LlmCallRecord[] = [
      { ...createCall('1', 'success', null, 'primary', 100), model: 'gemini-2.5-flash' },
      { ...createCall('2', 'success', null, 'primary', 200), model: 'gemini-2.0-flash' },
      { ...createCall('3', 'success', null, 'primary', 300), model: 'gemini-2.5-flash' },
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({ model: 'gemini-2.5-flash' }, store);

    expect(metrics.totalCallCount).toBe(2);
    expect(metrics.avgLatencyMs).toBe(200);
  });

  it('should filter by stage', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100, 'gemini', 'assessment'),
      createCall('2', 'success', null, 'primary', 200, 'gemini', 'question'),
      createCall('3', 'success', null, 'primary', 300, 'gemini', 'assessment'),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({ stage: 'assessment' }, store);

    expect(metrics.totalCallCount).toBe(2);
    expect(metrics.avgLatencyMs).toBe(200);
  });

  it('should filter by time range', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100, 'gemini', 'assessment', '2024-01-01T10:00:00Z'),
      createCall('2', 'success', null, 'primary', 200, 'gemini', 'assessment', '2024-01-02T10:00:00Z'),
      createCall('3', 'success', null, 'primary', 300, 'gemini', 'assessment', '2024-01-03T10:00:00Z'),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics(
      { timeRange: { start: new Date('2024-01-02T00:00:00Z'), end: new Date('2024-01-02T23:59:59Z') } },
      store
    );

    expect(metrics.totalCallCount).toBe(1);
    expect(metrics.avgLatencyMs).toBe(200);
  });

  it('should handle null durationMs values', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100),
      { ...createCall('2', 'success', null, 'primary', 200), durationMs: null as any },
      createCall('3', 'success', null, 'primary', 300),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({}, store);

    expect(metrics.totalCallCount).toBe(3);
    expect(metrics.avgLatencyMs).toBe(200); // (100 + 300) / 2, ignoring null
    expect(metrics.p50LatencyMs).toBe(200); // median of [100, 300]
  });

  it('should compute provider and parse error rates', async () => {
    const calls: LlmCallRecord[] = [
      createCall('1', 'success', null, 'primary', 100),
      createCall('2', 'error', 'provider_error', 'primary', 50),
      createCall('3', 'error', 'parse_error', 'primary', 75),
      createCall('4', 'error', 'provider_error', 'primary', 60),
    ];
    const store = createMockStore(calls);

    const metrics = await computeReliabilityMetrics({}, store);

    expect(metrics.totalCallCount).toBe(4);
    expect(metrics.providerErrorRate).toBe(0.5); // 2 provider_error / 4 total
    expect(metrics.parseErrorRate).toBe(0.25); // 1 parse_error / 4 total
    expect(metrics.schemaValidationFailureRate).toBe(0); // 0 schema_validation / 4 total
  });
});

function createCall(
  id: string,
  status: 'success' | 'timeout' | 'error',
  failureType: 'schema_validation' | 'parse_error' | 'provider_error' | 'timeout' | 'other' | null,
  callType: 'primary' | 'fallback',
  durationMs: number,
  provider: string = 'gemini',
  stage: 'assessment' | 'question' = 'assessment',
  createdAt: string = '2024-01-01T00:00:01Z'
): LlmCallRecord {
  return {
    id,
    sessionId: 's1',
    stage,
    callType,
    provider,
    model: 'gemini-2.0-flash',
    promptVersion: 'v1',
    rawResponse: '{}',
    parsedOutput: null,
    status,
    failureType,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: '2024-01-01T00:00:01Z',
    durationMs,
    errorMessage: null,
    createdAt,
  };
}
