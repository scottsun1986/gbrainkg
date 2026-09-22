import { HttpException } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

const mockQueryRaw = jest.fn();
jest.mock('./prisma', () => ({
  getPrismaClient: jest.fn(() => ({ $queryRaw: (...args: unknown[]) => mockQueryRaw(...args) })),
  disconnectPrismaClient: jest.fn(),
}));

function makeController(redisPing: jest.Mock) {
  const appService = new AppService();
  const redis = { ping: redisPing } as any;
  return new AppController(appService, redis);
}

async function expect503(promise: Promise<unknown>): Promise<any> {
  let caught: unknown;
  let resolved: unknown;
  try {
    resolved = await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const http = caught as HttpException;
  expect(http.getStatus()).toBe(503);
  expect(resolved).toBeUndefined();
  return http.getResponse() as any;
}

describe('GET /health (shallow liveness)', () => {
  it('stays dependency-free and returns ok', () => {
    const controller = makeController(jest.fn());
    const body = controller.getHealth();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api');
    expect(typeof body.timestamp).toBe('string');
  });
});

describe('GET /ready (DB + Redis readiness)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200/ready when PostgreSQL SELECT 1 and Redis ping both succeed', async () => {
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const redisPing = jest.fn().mockResolvedValue(true);
    const controller = makeController(redisPing);

    const body = await controller.getReady();

    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(mockQueryRaw).toHaveBeenCalled();
    expect(redisPing).toHaveBeenCalled();
  });

  it('returns 503 with JSON reason when the database probe fails', async () => {
    mockQueryRaw.mockRejectedValue(new Error('db connection refused'));
    const redisPing = jest.fn().mockResolvedValue(true);
    const controller = makeController(redisPing);

    const body = await expect503(controller.getReady());
    expect(body.status).toBe('error');
    expect(body.checks.database).toContain('db connection refused');
    expect(body.checks.redis).toBe('ok');
  });

  it('returns 503 with JSON reason when Redis ping fails', async () => {
    mockQueryRaw.mockResolvedValue([{ ok: 1 }]);
    const redisPing = jest.fn().mockResolvedValue(false);
    const controller = makeController(redisPing);

    const body = await expect503(controller.getReady());
    expect(body.checks.database).toBe('ok');
    expect(body.checks.redis).toContain('ping failed');
  });

  it('returns 503 when both dependencies fail and reports both reasons', async () => {
    mockQueryRaw.mockRejectedValue(new Error('catalog offline'));
    const redisPing = jest.fn().mockRejectedValue(new Error('redis down'));
    const controller = makeController(redisPing);

    const body = await expect503(controller.getReady());
    expect(body.checks.database).toContain('catalog offline');
    expect(body.checks.redis).toContain('redis down');
  });
});
