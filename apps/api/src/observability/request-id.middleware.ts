import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext, RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 200;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Accept only bounded, header-safe identifiers. Anything else (oversized,
 * control chars, whitespace) is replaced with a fresh UUID so we never echo
 * attacker-controlled content back into logs or response headers.
 */
export function sanitizeRequestId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_REQUEST_ID_LENGTH) return undefined;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Assign every request an x-request-id (propagated from the inbound header when
 * valid), echo it on the response, stash it on `req`, and expose it through
 * AsyncLocalStorage for structured logging.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.headers[REQUEST_ID_HEADER];
  const incoming = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const requestId = sanitizeRequestId(incoming) ?? randomUUID();

  const startedAt = Date.now();
  const extendedReq = req as Request & { requestId?: string; requestStartedAt?: number };
  extendedReq.requestId = requestId;
  extendedReq.requestStartedAt = startedAt;

  try {
    res.setHeader(REQUEST_ID_HEADER, requestId);
  } catch {
    // Headers may already be sent on exotic stacks; logging still gets the id.
  }

  const ctx: RequestContext = {
    requestId,
    method: req.method,
    route: req.path,
    startedAt,
  };
  runWithRequestContext(ctx, () => next());
}
