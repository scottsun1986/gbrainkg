import type { NextFunction, Request, Response } from 'express';
import { requestIdMiddleware, sanitizeRequestId, REQUEST_ID_HEADER } from './request-id.middleware';
import { getRequestId, getRequestContext, runWithRequestContext } from './request-context';

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn((key: string, value: string) => {
      headers[key.toLowerCase()] = value;
    }),
    on: jest.fn(),
    headers,
  } as unknown as Response & { headers: Record<string, string> };
  return res;
}

function mockReq(headers: Record<string, string | string[] | undefined> = {}) {
  return {
    headers,
    method: 'GET',
    path: '/health',
    url: '/health',
    originalUrl: '/health',
  } as unknown as Request;
}

describe('sanitizeRequestId', () => {
  it('accepts a bounded header-safe identifier', () => {
    expect(sanitizeRequestId('abc-123_XYZ:1.0')).toBe('abc-123_XYZ:1.0');
  });

  it('rejects empty, oversized, spaced or control-laden values', () => {
    expect(sanitizeRequestId('')).toBeUndefined();
    expect(sanitizeRequestId('   ')).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
    expect(sanitizeRequestId(123)).toBeUndefined();
    expect(sanitizeRequestId('a'.repeat(201))).toBeUndefined();
    expect(sanitizeRequestId('has space')).toBeUndefined();
    expect(sanitizeRequestId('bad\nheader')).toBeUndefined();
    expect(sanitizeRequestId('<script>')).toBeUndefined();
  });
});

describe('requestIdMiddleware', () => {
  it('generates a request id when the inbound header is missing', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    requestIdMiddleware(req, res, next as NextFunction);

    const id = (req as any).requestId;
    expect(id).toEqual(expect.any(String));
    expect(id.length).toBeGreaterThan(0);
    expect(sanitizeRequestId(id)).toBe(id);
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('propagates a valid inbound x-request-id', () => {
    const req = mockReq({ 'x-request-id': 'client-trace-42' });
    const res = mockRes();
    const next = jest.fn();

    requestIdMiddleware(req, res, next as NextFunction);

    expect((req as any).requestId).toBe('client-trace-42');
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'client-trace-42');
  });

  it('replaces an invalid inbound x-request-id with a fresh UUID', () => {
    const req = mockReq({ 'x-request-id': 'evil id with spaces' });
    const res = mockRes();
    const next = jest.fn();

    requestIdMiddleware(req, res, next as NextFunction);

    const id = (req as any).requestId;
    expect(id).not.toBe('evil id with spaces');
    expect(id).toEqual(expect.any(String));
  });

  it('exposes requestId and route through AsyncLocalStorage during the request', () => {
    const req = mockReq();
    const res = mockRes();
    let seenId: string | undefined;
    let seenCtxRoute: string | undefined;

    requestIdMiddleware(req, res, () => {
      seenId = getRequestId();
      seenCtxRoute = getRequestContext()?.route;
    });

    expect(seenId).toBe((req as any).requestId);
    expect(seenCtxRoute).toBe('/health');
    // Outside run() the store is empty.
    expect(getRequestId()).toBeUndefined();
  });

  it('runWithRequestContext isolates nested contexts', () => {
    runWithRequestContext({ requestId: 'outer' }, () => {
      expect(getRequestId()).toBe('outer');
      runWithRequestContext({ requestId: 'inner' }, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });
});
