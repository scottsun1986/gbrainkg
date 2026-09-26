import { metricsRegistry } from './metrics.service';
import {
  incLlmError,
  recordFailopen,
  setIngestionQueueDepth,
  FailChannel,
} from './failopen';

describe('observability failopen helpers', () => {
  it('records retrieval_failopen_total per channel without throwing', () => {
    const before = metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'graph' });
    recordFailopen('graph');
    recordFailopen('graph');
    expect(metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'graph' })).toBe(before + 2);
  });

  it('accepts every declared FailChannel and falls back to the raw string', () => {
    const channels: FailChannel[] = [
      'vector', 'lexical', 'sparse', 'late_interaction', 'graph', 'rerank',
      'hybrid', 'weknora', 'shadow', 'section_rescue', 'embedding', 'ingestion',
      'semantic_cache', 'other',
    ];
    for (const channel of channels) {
      recordFailopen(channel);
      expect(metricsRegistry.getCounterValue('retrieval_failopen_total', { channel })).toBeGreaterThanOrEqual(1);
    }
    recordFailopen('custom-channel' as FailChannel);
    expect(
      metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'custom-channel' }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('never throws even when channel is empty', () => {
    expect(() => recordFailopen('' as FailChannel)).not.toThrow();
  });

  it('setIngestionQueueDepth publishes a gauge sample (0 is a valid sample)', () => {
    setIngestionQueueDepth(0);
    const text = metricsRegistry.render();
    expect(text).toContain('ingestion_queue_depth 0');
    setIngestionQueueDepth(12);
    expect(metricsRegistry.render()).toContain('ingestion_queue_depth 12');
  });

  it('incLlmError forwards to llm_errors_total', () => {
    const before = metricsRegistry.getCounterValue('llm_errors_total', { provider: 'probe' });
    incLlmError('probe');
    expect(metricsRegistry.getCounterValue('llm_errors_total', { provider: 'probe' })).toBe(before + 1);
  });
});
