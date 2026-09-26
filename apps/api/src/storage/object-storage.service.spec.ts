import { formatVectorValues } from '../db/tenant-context.service';
import { ObjectStorageService } from './object-storage.service';

type HttpReq = {
  on: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  captured?: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer[] };
};

/**
 * Fake node:http.request that records the outgoing S3 call and replays a
 * canned status/body through the response callback.
 */
async function installHttpMock(statusCode: number, responseBody: Buffer = Buffer.alloc(0)) {
  const requests: HttpReq[] = [];
  const request = jest.fn((opts: any, cb: (res: any) => void) => {
    const bodyChunks: Buffer[] = [];
    const req: HttpReq = {
      on: jest.fn(),
      write: jest.fn((chunk: Buffer) => bodyChunks.push(chunk)),
      end: jest.fn(() => {
        req.captured = {
          method: opts.method,
          path: opts.path,
          headers: opts.headers,
          body: bodyChunks,
        };
        const res = {
          statusCode,
          on: jest.fn((event: string, handler: (arg?: any) => void) => {
            if (event === 'data') {
              if (responseBody.length) setImmediate(() => handler(responseBody));
            } else if (event === 'end') {
              setImmediate(() => handler());
            }
          }),
        };
        setImmediate(() => cb(res));
      }),
      captured: undefined,
    };
    requests.push(req);
    return req;
  });
  jest.spyOn(await import('node:http'), 'request').mockImplementation(request as any);
  return { request, requests };
}

function withMinioEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY,
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY,
    MINIO_BUCKET: process.env.MINIO_BUCKET,
    MINIO_REGION: process.env.MINIO_REGION,
    UPLOAD_ROOT: process.env.UPLOAD_ROOT,
  };
  process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
  process.env.MINIO_ACCESS_KEY = 'test-access-key';
  process.env.MINIO_SECRET_KEY = 'test-secret-key';
  process.env.MINIO_BUCKET = 'llmwiki-raw';
  process.env.MINIO_REGION = 'us-east-1';
  process.env.UPLOAD_ROOT = '/tmp/gbrainkg-storage-spec';
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function withoutMinioEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY,
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY,
    UPLOAD_ROOT: process.env.UPLOAD_ROOT,
  };
  delete process.env.MINIO_ENDPOINT;
  delete process.env.MINIO_ACCESS_KEY;
  delete process.env.MINIO_SECRET_KEY;
  process.env.UPLOAD_ROOT = '/tmp/gbrainkg-storage-spec';
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe('ObjectStorageService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    ObjectStorageService.resetFallbackWarning();
  });

  describe('path safety', () => {
    it('rejects path traversal in object keys (via resolveLocal semantics)', async () => {
      const svc = new ObjectStorageService();
      const anySvc = svc as any;
      expect(() => anySvc.resolveLocal('../etc/passwd')).toThrow(/escapes storage root/);
      expect(() => anySvc.resolveLocal('raw/../..//secret')).toThrow();
      const ok = anySvc.resolveLocal('raw/doc-1/abc');
      expect(ok).toContain('raw');
    });
  });

  describe('local fallback when MinIO env is missing', () => {
    it('reports provider=local and warns exactly once', async () => {
      const loggerWarn = jest.fn();
      // Nest Logger is constructed inside the service; capture via prototype.
      const { Logger } = await import('@nestjs/common');
      const nestWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(loggerWarn);

      await withoutMinioEnv(async () => {
        ObjectStorageService.resetFallbackWarning();
        const a = new ObjectStorageService();
        const b = new ObjectStorageService();
        expect(a.provider).toBe('local');
        expect(b.provider).toBe('local');
        // warn-once latch: only the first construction logs.
        expect(nestWarn).toHaveBeenCalledTimes(1);
        expect(String(nestWarn.mock.calls[0][0])).toMatch(/falling back to local disk/);
        expect(String(nestWarn.mock.calls[0][0])).toMatch(/MINIO_ENDPOINT/);

        // put/get/delete round-trip on local disk
        const stored = await a.put('raw/local-doc', Buffer.from('hello local'));
        expect(stored.provider).toBe('local');
        expect(stored.objectKey).toMatch(/^raw\/local-doc\//);
        expect(stored.size).toBe(11);
        expect(stored.sha256).toHaveLength(64);

        const buf = await a.getBuffer(stored.objectKey, 'local');
        expect(buf.toString()).toBe('hello local');

        await a.delete(stored.objectKey, 'local');
        await expect(a.getBuffer(stored.objectKey, 'local')).rejects.toThrow();
      });

      nestWarn.mockRestore();
    });

    it('falls back to local when only some MinIO vars are set', async () => {
      const { Logger } = await import('@nestjs/common');
      const nestWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const saved = { ...process.env };
      try {
        ObjectStorageService.resetFallbackWarning();
        process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
        delete process.env.MINIO_ACCESS_KEY;
        delete process.env.MINIO_SECRET_KEY;
        process.env.UPLOAD_ROOT = '/tmp/gbrainkg-storage-spec';
        const svc = new ObjectStorageService();
        expect(svc.provider).toBe('local');
        expect(String(nestWarn.mock.calls[0][0])).toMatch(/MINIO_ACCESS_KEY/);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else (process.env as any)[k] = v;
        }
        nestWarn.mockRestore();
      }
    });
  });

  describe('MinIO S3 v4 put/get/delete (mocked HTTP)', () => {
    it('PUT signs with SigV4 and stores an object', async () => {
      await withMinioEnv(async () => {
        // First PUT = create bucket, second PUT = object.
        const http = await installHttpMock(200);
        http.request
          .mockImplementationOnce((opts: any, cb: any) => {
            const req = {
              on: jest.fn(),
              write: jest.fn(),
              end: jest.fn(() => {
                const res = { statusCode: 200, on: jest.fn((e: string, h: any) => e === 'end' && setImmediate(h)) };
                setImmediate(() => cb(res));
              }),
            };
            return req;
          });
        // Reinstall a uniform mock that handles both bucket + object PUT.
        jest.spyOn(await import('node:http'), 'request').mockImplementation((opts: any, cb: any) => {
          const bodyChunks: Buffer[] = [];
          const req: any = {
            on: jest.fn(),
            write: (c: Buffer) => bodyChunks.push(c),
            end: () => {
              req.captured = { method: opts.method, path: opts.path, headers: opts.headers, body: bodyChunks };
              const res = { statusCode: 200, on: (e: string, h: any) => e === 'end' && setImmediate(h) };
              setImmediate(() => cb(res));
            },
          };
          http.requests.push(req);
          return req;
        });

        const svc = new ObjectStorageService();
        expect(svc.provider).toBe('minio');
        const stored = await svc.put('raw/doc-9', Buffer.from('payload-bytes'), 'text/plain');

        expect(stored.provider).toBe('minio');
        expect(stored.objectKey).toMatch(/^raw\/doc-9\//);
        expect(stored.size).toBe('payload-bytes'.length);
        expect(stored.sha256).toHaveLength(64);

        // 2 requests: create-bucket + object PUT
        expect(http.requests.length).toBe(2);
        const objectPut = http.requests[1].captured!;
        expect(objectPut.method).toBe('PUT');
        expect(objectPut.path).toBe(`/llmwiki-raw/${stored.objectKey}`);
        const auth = objectPut.headers!.Authorization;
        expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
        expect(objectPut.headers!['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
        expect(objectPut.headers!['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
        expect(objectPut.headers!['Content-Type']).toBe('text/plain');
        expect(Buffer.concat(objectPut.body!).toString()).toBe('payload-bytes');
      });
    });

    it('GET returns the object bytes through getStream/getBuffer', async () => {
      await withMinioEnv(async () => {
        const { requests } = await installHttpMock(200, Buffer.from('fetched-body'));
        const svc = new ObjectStorageService();
        const key = 'raw/doc-1/aaaaaaaa-bbbb-4ccc-8ddd-000000000001';

        const buf = await svc.getBuffer(key, 'minio');
        expect(buf.toString()).toBe('fetched-body');
        expect(requests[0].captured!.method).toBe('GET');
        expect(requests[0].captured!.path).toBe(`/llmwiki-raw/${key}`);
        expect(requests[0].captured!.headers!.Authorization).toMatch(/AWS4-HMAC-SHA256/);

        const stream = await svc.getStream(key, 'minio');
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
        expect(Buffer.concat(chunks).toString()).toBe('fetched-body');
        expect(requests.length).toBe(2);
      });
    });

    it('DELETE issues a signed DELETE against the object key', async () => {
      await withMinioEnv(async () => {
        const { requests } = await installHttpMock(204);
        const svc = new ObjectStorageService();
        const key = 'raw/doc-2/aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
        await svc.delete(key, 'minio');
        expect(requests[0].captured!.method).toBe('DELETE');
        expect(requests[0].captured!.path).toBe(`/llmwiki-raw/${key}`);
        expect(requests[0].captured!.headers!.Authorization).toMatch(/AWS4-HMAC-SHA256/);
      });
    });

    it('propagates S3 error status as a rejection', async () => {
      await withMinioEnv(async () => {
        await installHttpMock(403, Buffer.from('AccessDenied'));
        const svc = new ObjectStorageService();
        // Skip ensureBucket noise by stubbing it away.
        (svc as any).ensureBucket = async () => undefined;
        await expect(svc.put('raw/x', Buffer.from('z'))).rejects.toThrow(/403/);
      });
    });
  });
});

describe('formatVectorValues (batch SQL helper shared with embedding writes)', () => {
  it('produces UUID-typed, vector-typed tuples free of raw interpolation', () => {
    const out = formatVectorValues([
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', vec: '[0.5,-0.25]' },
    ]);
    expect(out).toContain('::uuid');
    expect(out).toContain('::vector');
    expect(out).not.toContain('DROP');
  });
});
