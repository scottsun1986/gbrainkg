import { MetricsRegistry, MetricsService, metricsRegistry } from './metrics.service';

describe('MetricsRegistry', () => {
  it('renders counters with method/route/status labels in Prometheus text format', () => {
    const registry = new MetricsRegistry();
    registry.defineCounter('http_requests_total', 'Total HTTP requests');
    registry.incCounter('http_requests_total', { method: 'GET', route: '/health', status: '200' });
    registry.incCounter('http_requests_total', { method: 'GET', route: '/health', status: '200' });
    registry.incCounter('http_requests_total', { method: 'POST', route: '/docs', status: '500' });

    const text = registry.render();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(text).toContain('http_requests_total{method="POST",route="/docs",status="500"} 1');
  });

  it('renders histogram buckets, sum, count and cumulative p50/p95/p99 quantiles', () => {
    const registry = new MetricsRegistry();
    registry.defineHistogram('http_request_duration_ms', 'duration', [10, 100, 1000]);
    for (const v of [5, 8, 50, 200, 900, 1500]) {
      registry.observeHistogram('http_request_duration_ms', v, { method: 'GET', route: '/x' });
    }

    // Observations: 5, 8, 50, 200, 900, 1500 against bounds [10, 100, 1000]
    const text = registry.render();
    expect(text).toContain('# TYPE http_request_duration_ms histogram');
    expect(text).toContain('http_request_duration_ms_bucket{le="10",method="GET",route="/x"} 2');
    expect(text).toContain('http_request_duration_ms_bucket{le="100",method="GET",route="/x"} 3');
    expect(text).toContain('http_request_duration_ms_bucket{le="1000",method="GET",route="/x"} 5');
    expect(text).toContain('http_request_duration_ms_bucket{le="+Inf",method="GET",route="/x"} 6');
    expect(text).toContain('http_request_duration_ms_count{method="GET",route="/x"} 6');
    expect(text).toContain('http_request_duration_ms_sum{method="GET",route="/x"} 2663');

    expect(text).toContain('# TYPE http_request_duration_ms_quantile gauge');
    expect(text).toContain('quantile="0.5"');
    expect(text).toContain('quantile="0.95"');
    expect(text).toContain('quantile="0.99"');

    const p50 = registry.getHistogramQuantile('http_request_duration_ms', 0.5, { method: 'GET', route: '/x' });
    const p95 = registry.getHistogramQuantile('http_request_duration_ms', 0.95, { method: 'GET', route: '/x' });
    const p99 = registry.getHistogramQuantile('http_request_duration_ms', 0.99, { method: 'GET', route: '/x' });
    expect(p50).toBeGreaterThan(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);
    expect(p99).toBeLessThanOrEqual(1500);
  });

  it('escapes label values so scrape output stays valid', () => {
    const registry = new MetricsRegistry();
    registry.defineCounter('demo_total', 'demo');
    registry.incCounter('demo_total', { route: 'a"b\\c\nd' });
    const text = registry.render();
    expect(text).toContain('route="a\\"b\\\\c\\nd"');
  });
});

describe('MetricsService reserved series', () => {
  it('exposes http metrics, retrieval_failopen_total, ingestion_queue_depth and process_uptime_seconds', () => {
    // Use the module-level registry via a fresh service (re-registers reserved defs).
    const service = new MetricsService();
    service.observeHttpRequest('GET', '/health', 200, 12);
    service.observeHttpRequest('GET', '/health', 200, 30);
    service.incRetrievalFailopen('lexical');
    service.incRetrievalFailopen('lexical');
    service.incRetrievalFailopen('vector');
    service.setIngestionQueueDepth(7);

    const text = service.render();

    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/health",status="200"\} 2/);
    expect(text).toContain('# TYPE http_request_duration_ms histogram');
    expect(text).toContain('http_request_duration_ms_quantile');

    expect(text).toContain('# TYPE retrieval_failopen_total counter');
    expect(text).toContain('retrieval_failopen_total{channel="lexical"} 2');
    expect(text).toContain('retrieval_failopen_total{channel="vector"} 1');

    expect(text).toContain('# TYPE ingestion_queue_depth gauge');
    expect(text).toContain('ingestion_queue_depth 7');

    expect(text).toContain('# TYPE process_uptime_seconds gauge');
    const uptimeMatch = text.match(/process_uptime_seconds (\d+)/);
    expect(uptimeMatch).not.toBeNull();
    expect(Number(uptimeMatch![1])).toBeGreaterThanOrEqual(0);
  });

  it('still advertises reserved series before any samples arrive', () => {
    const registry = new MetricsRegistry();
    registry.defineCounter('retrieval_failopen_total', 'Retrieval fail-open events by channel (reserved)');
    registry.defineGauge('ingestion_queue_depth', 'Ingestion queue depth (reserved)');
    const text = registry.render();
    expect(text).toContain('# TYPE retrieval_failopen_total counter');
    expect(text).toContain('# TYPE ingestion_queue_depth gauge');
    // No samples yet: TYPE/HELP only is valid Prometheus exposition.
    expect(text).not.toContain('retrieval_failopen_total{');
  });

  it('shares state through the process-wide registry singleton', () => {
    metricsRegistry.incCounter('http_requests_total', { method: 'GET', route: '/shared', status: '200' }, 1);
    expect(
      metricsRegistry.getCounterValue('http_requests_total', { method: 'GET', route: '/shared', status: '200' }),
    ).toBeGreaterThanOrEqual(1);
  });
});
