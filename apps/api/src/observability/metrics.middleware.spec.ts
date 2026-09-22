import type { NextFunction, Request, Response } from 'express';
import { metricsMiddleware, normalizeRoute, setAccessLogger } from './metrics.middleware';
import { metricsRegistry } from './metrics.service';
import { JsonLogger } from './json-logger';

beforeAll(() => {
  setAccessLogger(new JsonLogger(() => undefined));
});

describe('normalizeRoute', () => {
  it('collapses UUID and numeric path segments to :id', () => {
    expect(normalizeRoute('/docs/123')).toBe('/docs/:id');
    expect(normalizeRoute('/kb/9f9c2f0e-6f1a-4c3b-9a11-0b1c2d3e4f56/chunks')).toBe('/kb/:id/chunks');
    expect(normalizeRoute('/health')).toBe('/health');
    expect(normalizeRoute('/search?q=abc')).toBe('/search');
    expect(normalizeRoute(undefined)).toBe('unknown');
  });
});

describe('metricsMiddleware', () => {
  function runOnce(overrides: { method?: string; path?: string; status?: number } = {}) {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const req = {
      method: overrides.method || 'GET',
      path: overrides.path || '/metrics-test',
      url: overrides.path || '/metrics-test',
      originalUrl: overrides.path || '/metrics-test',
      headers: {},
    } as unknown as Request & { requestId?: string; requestStartedAt?: number };
    (req as any).requestId = 'req-m1';
    (req as any).requestStartedAt = Date.now() - 15;

    const res = {
      statusCode: overrides.status ?? 200,
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
    } as unknown as Response;

    const next = jest.fn();
    metricsMiddleware(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    for (const cb of listeners['finish'] || []) cb();
  }

  it('records http_requests_total and http_request_duration_ms samples', () => {
    const before = metricsRegistry.getHistogramStat('http_request_duration_ms', {
      method: 'PATCH',
      route: '/metrics-mw-test',
    });

    runOnce({ method: 'PATCH', path: '/metrics-mw-test', status: 201 });

    const counter = metricsRegistry.getCounterValue('http_requests_total', {
      method: 'PATCH',
      route: '/metrics-mw-test',
      status: '201',
    });
    expect(counter).toBeGreaterThanOrEqual(1);

    const after = metricsRegistry.getHistogramStat('http_request_duration_ms', {
      method: 'PATCH',
      route: '/metrics-mw-test',
    });
    expect(after.count).toBeGreaterThanOrEqual(before.count + 1);
  });
});
