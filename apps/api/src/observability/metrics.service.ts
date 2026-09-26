import { Injectable } from '@nestjs/common';

export type MetricLabels = Record<string, string | number>;

/**
 * Minimal hand-rolled Prometheus text registry.
 *
 * Intentionally avoids `prom-client` so we do not touch pnpm-lock or add a
 * dependency just for a handful of series. Supports counters, gauges and
 * histograms (with cumulative p50/p95/p99 derived from buckets).
 */

const DEFAULT_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const body = keys
    .map((key) => `${key}="${escapeLabelValue(String(labels[key]))}"`)
    .join(',');
  return `{${body}}`;
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${String(labels[key])}`)
    .join(',');
}

interface CounterSeries {
  labels: MetricLabels;
  value: number;
}

interface GaugeSeries {
  labels: MetricLabels;
  value: number | (() => number);
}

interface HistogramSeries {
  labels: MetricLabels;
  /** Exclusive per-bucket counts for finite upper bounds. */
  counts: number[];
  sum: number;
  count: number;
}

interface MetricMeta {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
}

function quantileFromHistogram(series: HistogramSeries, bounds: number[], q: number): number {
  if (series.count <= 0) return 0;
  const target = Math.max(0, Math.min(1, q)) * series.count;
  let cumulative = 0;
  for (let i = 0; i < bounds.length; i += 1) {
    const bucketCount = series.counts[i] || 0;
    const prevCumulative = cumulative;
    cumulative += bucketCount;
    if (cumulative >= target) {
      const lower = i === 0 ? 0 : bounds[i - 1];
      const upper = bounds[i];
      if (bucketCount <= 0) return upper;
      const frac = (target - prevCumulative) / bucketCount;
      return lower + frac * (upper - lower);
    }
  }
  // Observations beyond the last finite bound: fall back to the mean.
  return series.sum / series.count;
}

export class MetricsRegistry {
  private readonly meta = new Map<string, MetricMeta>();
  private readonly counters = new Map<string, Map<string, CounterSeries>>();
  private readonly gauges = new Map<string, Map<string, GaugeSeries>>();
  private readonly histograms = new Map<
    string,
    { meta: MetricMeta; bounds: number[]; series: Map<string, HistogramSeries> }
  >();

  defineCounter(name: string, help: string): void {
    this.meta.set(name, { name, help, type: 'counter' });
    if (!this.counters.has(name)) this.counters.set(name, new Map());
  }

  defineGauge(name: string, help: string): void {
    this.meta.set(name, { name, help, type: 'gauge' });
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
  }

  defineHistogram(name: string, help: string, buckets: number[] = DEFAULT_DURATION_BUCKETS_MS): void {
    const sorted = [...buckets].sort((a, b) => a - b);
    this.meta.set(name, { name, help, type: 'histogram' });
    if (!this.histograms.has(name)) {
      this.histograms.set(name, { meta: { name, help, type: 'histogram' }, bounds: sorted, series: new Map() });
    }
  }

  incCounter(name: string, labels: MetricLabels = {}, delta = 1): void {
    this.defineCounter(name, name);
    const table = this.counters.get(name)!;
    const key = labelKey(labels);
    const existing = table.get(key);
    if (existing) existing.value += delta;
    else table.set(key, { labels: { ...labels }, value: delta });
  }

  setGauge(name: string, value: number | (() => number), labels: MetricLabels = {}): void {
    this.defineGauge(name, name);
    const table = this.gauges.get(name)!;
    table.set(labelKey(labels), { labels: { ...labels }, value });
  }

  observeHistogram(name: string, value: number, labels: MetricLabels = {}): void {
    if (!this.histograms.has(name)) this.defineHistogram(name, name);
    const hist = this.histograms.get(name)!;
    const key = labelKey(labels);
    let series = hist.series.get(key);
    if (!series) {
      series = { labels: { ...labels }, counts: new Array(hist.bounds.length).fill(0), sum: 0, count: 0 };
      hist.series.set(key, series);
    }
    series.sum += value;
    series.count += 1;
    let placed = false;
    for (let i = 0; i < hist.bounds.length; i += 1) {
      if (value <= hist.bounds[i]) {
        series.counts[i] = (series.counts[i] || 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Above every finite bound: only +Inf counts it (rendered from `count`).
    }
  }

  getCounterValue(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels))?.value ?? 0;
  }

  getHistogramStat(name: string, labels: MetricLabels = {}): { sum: number; count: number } {
    const series = this.histograms.get(name)?.series.get(labelKey(labels));
    return { sum: series?.sum ?? 0, count: series?.count ?? 0 };
  }

  getHistogramQuantile(name: string, q: number, labels: MetricLabels = {}): number {
    const hist = this.histograms.get(name);
    const series = hist?.series.get(labelKey(labels));
    if (!hist || !series) return 0;
    return quantileFromHistogram(series, hist.bounds, q);
  }

  render(): string {
    const lines: string[] = [];

    for (const meta of this.meta.values()) {
      if (meta.type === 'counter') {
        lines.push(`# HELP ${meta.name} ${meta.help}`);
        lines.push(`# TYPE ${meta.name} counter`);
        const table = this.counters.get(meta.name);
        if (!table || table.size === 0) continue;
        for (const series of table.values()) {
          lines.push(`${meta.name}${formatLabels(series.labels)} ${series.value}`);
        }
      } else if (meta.type === 'gauge') {
        lines.push(`# HELP ${meta.name} ${meta.help}`);
        lines.push(`# TYPE ${meta.name} gauge`);
        const table = this.gauges.get(meta.name);
        if (!table || table.size === 0) continue;
        for (const series of table.values()) {
          const raw = typeof series.value === 'function' ? series.value() : series.value;
          lines.push(`${meta.name}${formatLabels(series.labels)} ${raw}`);
        }
      } else if (meta.type === 'histogram') {
        const hist = this.histograms.get(meta.name);
        if (!hist) continue;
        lines.push(`# HELP ${meta.name} ${meta.help}`);
        lines.push(`# TYPE ${meta.name} histogram`);
        for (const series of hist.series.values()) {
          let cumulative = 0;
          for (let i = 0; i < hist.bounds.length; i += 1) {
            cumulative += series.counts[i] || 0;
            lines.push(
              `${meta.name}_bucket${formatLabels({ ...series.labels, le: String(hist.bounds[i]) })} ${cumulative}`,
            );
          }
          lines.push(`${meta.name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
          lines.push(`${meta.name}_sum${formatLabels(series.labels)} ${series.sum}`);
          lines.push(`${meta.name}_count${formatLabels(series.labels)} ${series.count}`);
        }

        // Cumulative quantiles (p50/p95/p99) derived from the same buckets.
        const quantileName = `${meta.name}_quantile`;
        lines.push(`# HELP ${quantileName} Cumulative quantiles derived from ${meta.name} buckets`);
        lines.push(`# TYPE ${quantileName} gauge`);
        for (const series of hist.series.values()) {
          for (const q of [0.5, 0.95, 0.99]) {
            lines.push(
              `${quantileName}${formatLabels({ ...series.labels, quantile: String(q) })} ${quantileFromHistogram(
                series,
                hist.bounds,
                q,
              )}`,
            );
          }
        }
      }
    }

    return lines.join('\n') + '\n';
  }
}

/** Process-wide registry shared by the HTTP middleware and `/metrics`. */
export const metricsRegistry = new MetricsRegistry();

@Injectable()
export class MetricsService {
  constructor() {
    // Reserved / required series are defined up front so `/metrics` always
    // advertises them even before the first sample lands.
    metricsRegistry.defineCounter('http_requests_total', 'Total HTTP requests by method, route and status');
    metricsRegistry.defineHistogram(
      'http_request_duration_ms',
      'HTTP request duration in milliseconds (histogram + cumulative p50/p95/p99)',
      DEFAULT_DURATION_BUCKETS_MS,
    );
    metricsRegistry.defineCounter('retrieval_failopen_total', 'Retrieval fail-open events by channel');
    metricsRegistry.defineGauge('ingestion_queue_depth', 'Ingestion queue backlog');
    // Always publish a sample (0 until a worker reports) so the series is queryable.
    metricsRegistry.setGauge('ingestion_queue_depth', 0);
    metricsRegistry.defineGauge('process_uptime_seconds', 'Process uptime in seconds');
    metricsRegistry.defineCounter('llm_errors_total', 'Upstream LLM/embedding/rerank provider errors');
    metricsRegistry.defineCounter('embedding_failures_total', 'Embedding batch/item failures');
    metricsRegistry.defineGauge('app_build_info', 'Build/runtime descriptor (value is always 1)');
    metricsRegistry.defineGauge('rls_enforce', '1 when RLS_ENFORCE=1 is active');
    metricsRegistry.setGauge('process_uptime_seconds', () => Math.floor(process.uptime()));
    metricsRegistry.setGauge('app_build_info', 1, {
      service: 'llmwiki-api',
      node: process.version,
      rls: String(process.env.RLS_ENFORCE ?? '0'),
    });
    metricsRegistry.setGauge('rls_enforce', () => (String(process.env.RLS_ENFORCE ?? '').toLowerCase() === '1' ? 1 : 0));
  }

  observeHttpRequest(method: string, route: string, status: number, durationMs: number): void {
    metricsRegistry.incCounter('http_requests_total', {
      method: method || 'UNKNOWN',
      route: route || 'unknown',
      status: String(status),
    });
    metricsRegistry.observeHistogram('http_request_duration_ms', durationMs, {
      method: method || 'UNKNOWN',
      route: route || 'unknown',
    });
  }

  /** Reserved hook for retrieval channels that fall open on failure. */
  incRetrievalFailopen(channel: string): void {
    metricsRegistry.incCounter('retrieval_failopen_total', { channel: channel || 'unknown' });
  }

  /** Ingestion pipeline backlog. */
  setIngestionQueueDepth(depth: number): void {
    metricsRegistry.setGauge('ingestion_queue_depth', depth);
  }

  incLlmError(provider: string): void {
    metricsRegistry.incCounter('llm_errors_total', { provider: provider || 'unknown' });
  }

  incEmbeddingFailure(): void {
    metricsRegistry.incCounter('embedding_failures_total', {}, 1);
  }

  render(): string {
    return metricsRegistry.render();
  }
}

/** Default instance used by the HTTP middleware (avoids a DI round-trip). */
export const metricsService = new MetricsService();
