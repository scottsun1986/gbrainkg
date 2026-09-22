import type { NextFunction, Request, Response } from 'express';
import { JsonLogger } from './json-logger';
import { metricsService } from './metrics.service';
import { getRequestContext } from './request-context';

/**
 * Collapse volatile path segments so metric label cardinality stays bounded.
 * `/docs/123` and `/docs/9f9c…` both map to `/docs/:id`.
 */
export function normalizeRoute(input: string | undefined): string {
  const path = (input || 'unknown').split('?')[0] || '/';
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

let accessLogger = new JsonLogger();

/** Test hook: silence/replace the access-log sink. */
export function setAccessLogger(logger: JsonLogger): void {
  accessLogger = logger;
}

/**
 * Record HTTP RED metrics and emit one structured access log line per request.
 * Mount after the request-id middleware so correlation fields are available.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const extendedReq = req as Request & { requestId?: string; requestStartedAt?: number; user?: { id?: string } };
  const startedAt = extendedReq.requestStartedAt ?? Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const route = normalizeRoute(req.path || req.originalUrl || req.url);
    const status = res.statusCode;
    const requestId = extendedReq.requestId ?? getRequestContext()?.requestId;
    const userId = extendedReq.user?.id ?? getRequestContext()?.userId;

    metricsService.observeHttpRequest(req.method, route, status, durationMs);
    accessLogger.logHttpAccess({
      requestId,
      userId,
      method: req.method,
      route,
      status,
      durationMs,
    });
  });

  next();
}
