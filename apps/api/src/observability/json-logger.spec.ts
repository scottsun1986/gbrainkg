import {
  JsonLogger,
  redact,
  redactText,
  sanitizeLogFields,
  REDACTED,
  resolveLogFormat,
  createLogger,
} from './json-logger';
import { runWithRequestContext } from './request-context';

describe('redact / sanitizeLogFields', () => {
  it('redacts password, token, authorization and cookie fields (nested)', () => {
    const input = {
      password: 'hunter2',
      token: 'abc.def.ghi',
      authorization: 'Bearer secret-token',
      cookie: 'sid=1; jwt=zzz',
      nested: {
        apiKey: 'sk-123',
        refreshToken: 'rt-1',
        credentials: { password: 'p@ss', client_secret: 'cs' },
      },
      list: [{ password: 'x' }, { authorization: 'Bearer y' }],
      safe: 'ok',
    };

    const out = sanitizeLogFields(input) as any;

    expect(out.password).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.refreshToken).toBe(REDACTED);
    expect(out.nested.credentials).toBe(REDACTED);
    expect(out.list[0].password).toBe(REDACTED);
    expect(out.list[1].authorization).toBe(REDACTED);
    expect(out.safe).toBe('ok');

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('sid=1');
    expect(serialized).not.toContain('sk-123');
    expect(serialized).not.toContain('Bearer y');
  });

  it('scrubs secret-bearing key=value / key: value pairs inside free text', () => {
    const line = 'login failed password=hunter2 authorization: Bearer tok_xyz api_key="sk-live" ok=1';
    const cleaned = redactText(line);
    expect(cleaned).not.toContain('hunter2');
    expect(cleaned).not.toContain('tok_xyz');
    expect(cleaned).not.toContain('sk-live');
    expect(cleaned).toContain('ok=1');
    expect(cleaned).toContain(REDACTED);
  });

  it('redacts Error message/stack text and preserves shape', () => {
    const err = new Error('boom password=leaked');
    const out = redact(err) as any;
    expect(out.name).toBe('Error');
    expect(out.message).not.toContain('leaked');
    expect(typeof out.stack).toBe('string');
  });

  it('handles circular structures without throwing', () => {
    const obj: any = { password: 'x', child: {} };
    obj.child.parent = obj;
    expect(() => redact(obj)).not.toThrow();
  });
});

describe('JsonLogger', () => {
  it('emits one JSON line per record with ts/level/msg and redacted params', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));

    logger.log('hello', 'Ctx', { password: 'hunter2', token: 't', authorization: 'Bearer z', cookie: 'c=d', ok: 1 });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.ts).toEqual(expect.any(String));
    expect(record.level).toBe('info');
    expect(record.msg).toBe('hello');
    expect(record.context).toBe('Ctx');
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(JSON.stringify(record)).not.toContain('Bearer z');
    expect(record.params[0].password).toBe(REDACTED);
    expect(record.params[0].ok).toBe(1);
  });

  it('attaches requestId / route from AsyncLocalStorage', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));

    runWithRequestContext({ requestId: 'req-77', userId: 'u-1', route: '/api/x' }, () => {
      logger.log('in-request');
    });

    const record = JSON.parse(lines[0]);
    expect(record.requestId).toBe('req-77');
    expect(record.userId).toBe('u-1');
    expect(record.route).toBe('/api/x');
  });

  it('records error stack and never leaks authorization text from the stack', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));

    const err = new Error('failed authorization=Bearer supersecret');
    logger.error('boom', err.stack, 'Auth');

    const record = JSON.parse(lines[0]);
    expect(record.level).toBe('error');
    expect(record.msg).toBe('boom');
    expect(record.context).toBe('Auth');
    expect(typeof record.stack).toBe('string');
    expect(record.stack).not.toContain('supersecret');
  });

  it('logHttpAccess writes durationMs / status / requestId fields', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));

    logger.logHttpAccess({ requestId: 'r1', userId: 'u1', method: 'GET', route: '/ready', status: 200, durationMs: 12 });

    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      level: 'info',
      msg: 'http_request',
      requestId: 'r1',
      userId: 'u1',
      route: '/ready',
      durationMs: 12,
      status: 200,
      method: 'GET',
    });
  });
});

describe('resolveLogFormat / createLogger', () => {
  it('defaults to json and builds a JsonLogger', () => {
    expect(resolveLogFormat(undefined)).toBe('json');
    expect(resolveLogFormat('json')).toBe('json');
    expect(createLogger('json')).toBeInstanceOf(JsonLogger);
  });

  it('pretty keeps Nest default logger (undefined)', () => {
    expect(resolveLogFormat('pretty')).toBe('pretty');
    expect(resolveLogFormat('PRETTY')).toBe('pretty');
    expect(createLogger('pretty')).toBeUndefined();
  });
});
