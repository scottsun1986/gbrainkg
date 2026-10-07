import { ExecutionContext } from '@nestjs/common';
import { AppThrottlerGuard } from './app-throttler.guard';

function makeContext(req: Record<string, any>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    getType: () => 'http',
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as any,
    switchToWs: () => ({}) as any,
  } as unknown as ExecutionContext;
}

function makeGuard(): AppThrottlerGuard {
  const reflector: any = { getAllAndOverride: () => false };
  return new AppThrottlerGuard(
    [{ ttl: 60_000, limit: 600 }] as any,
    {} as any,
    reflector,
  );
}

const skip = (guard: AppThrottlerGuard, ctx: ExecutionContext) =>
  (guard as any).shouldSkip(ctx) as Promise<boolean>;

describe('AppThrottlerGuard login bypass', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('does not bypass by default', async () => {
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS;
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS;
    process.env.NODE_ENV = 'test';
    const ctx = makeContext({ url: '/api/v1/auth/login', ip: '127.0.0.1' });
    expect(await skip(makeGuard(), ctx)).toBe(false);
  });

  it('bypasses a whitelisted source IP on the login endpoint', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS;
    process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS = '127.0.0.1,10.0.0.5';
    const ctx = makeContext({ url: '/api/v1/auth/login?x=1', ip: '10.0.0.5' });
    expect(await skip(makeGuard(), ctx)).toBe(true);
  });

  it('does not bypass a non-whitelisted IP', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS;
    process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS = '10.0.0.5';
    const ctx = makeContext({ url: '/api/v1/auth/login', ip: '203.0.113.9' });
    expect(await skip(makeGuard(), ctx)).toBe(false);
  });

  it('never bypasses a non-login route even with a whitelisted IP', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS;
    process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS = '127.0.0.1';
    const ctx = makeContext({ url: '/api/v1/kbs', ip: '127.0.0.1' });
    expect(await skip(makeGuard(), ctx)).toBe(false);
  });

  it.each(['/api/v1/auth/login/admin', '/api/v1/files/auth/login', '/api/v1/kbs?redirect=/auth/login'])('does not bypass a route merely containing login text: %s', async url => {
    process.env.AUTH_LOGIN_THROTTLE_BYPASS = '1';
    expect(await skip(makeGuard(), makeContext({ url, ip: '127.0.0.1' }))).toBe(false);
  });

  it('keeps the per-IP list inert in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS;
    process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS = '127.0.0.1';
    const ctx = makeContext({ url: '/api/v1/auth/login', ip: '127.0.0.1' });
    expect(await skip(makeGuard(), ctx)).toBe(false);
  });

  it('honours the explicit master switch even when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_LOGIN_THROTTLE_BYPASS = '1';
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS;
    const ctx = makeContext({ url: '/api/v1/auth/login', ip: '203.0.113.9' });
    expect(await skip(makeGuard(), ctx)).toBe(true);
  });

  it('honours an explicit bypass-all flag in non-production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_LOGIN_THROTTLE_BYPASS = '1';
    delete process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS;
    const ctx = makeContext({ url: '/api/v1/auth/login', ip: '203.0.113.9' });
    expect(await skip(makeGuard(), ctx)).toBe(true);
  });
});
