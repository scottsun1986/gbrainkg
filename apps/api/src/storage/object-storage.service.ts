import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export type StorageProvider = 'local' | 'minio';

export interface StoredObject {
  provider: StorageProvider;
  objectKey: string;
  size: number;
  sha256: string;
}

interface MinioConfig {
  endpoint: string;
  port: number;
  useSsl: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

/**
 * 原始文件对象存储。优先 MinIO（S3 v4 签名，无 SDK 依赖），否则本地目录。
 * 路径穿越防护：objectKey 生成自 UUID，解析时 normalize + root 前缀校验。
 *
 * 缺 MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY 时明确 fallback
 * local 并 warn 一次（按进程），避免生产静默落盘却以为已进对象存储。
 */
@Injectable()
export class ObjectStorageService {
  private static warnedLocalFallback = false;
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly localRoot: string;
  private readonly minio: MinioConfig | null;

  constructor() {
    this.localRoot = resolve(
      process.env.UPLOAD_ROOT || join(process.cwd(), 'uploads'),
    );
    const endpoint = process.env.MINIO_ENDPOINT || '';
    const accessKey = process.env.MINIO_ACCESS_KEY || '';
    const secretKey = process.env.MINIO_SECRET_KEY || '';
    const missing = [
      !endpoint && 'MINIO_ENDPOINT',
      !accessKey && 'MINIO_ACCESS_KEY',
      !secretKey && 'MINIO_SECRET_KEY',
    ].filter(Boolean) as string[];
    if (missing.length === 0) {
      const url = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
      const useSsl = url.protocol === 'https:';
      const port = Number(url.port || (useSsl ? 443 : 80));
      this.minio = {
        endpoint: url.hostname,
        port,
        useSsl,
        accessKey,
        secretKey,
        bucket: process.env.MINIO_BUCKET || 'llmwiki-raw',
        region: process.env.MINIO_REGION || 'us-east-1',
      };
    } else {
      this.minio = null;
      if (!ObjectStorageService.warnedLocalFallback) {
        ObjectStorageService.warnedLocalFallback = true;
        this.logger.warn(
          `Object storage is falling back to local disk (${this.localRoot}); ` +
            `missing ${missing.join(', ')}. ` +
            'Set MINIO_ENDPOINT + MINIO_ACCESS_KEY + MINIO_SECRET_KEY to enable MinIO/S3.',
        );
      }
    }
  }

  /** Test hook: clear the one-shot fallback warning latch. */
  static resetFallbackWarning(): void {
    ObjectStorageService.warnedLocalFallback = false;
  }

  get provider(): StorageProvider {
    return this.minio ? 'minio' : 'local';
  }

  async put(
    keyPrefix: string,
    data: Buffer | NodeJS.ReadableStream,
    contentType = 'application/octet-stream',
  ): Promise<StoredObject> {
    const objectKey = `${keyPrefix.replace(/[^a-zA-Z0-9/_-]/g, '_')}/${randomUUID()}`;
    if (this.minio) {
      const body = Buffer.isBuffer(data) ? data : await bufferStream(data);
      const sha256 = createHash('sha256').update(body).digest('hex');
      await this.minioPut(objectKey, body, contentType);
      return { provider: 'minio', objectKey, size: body.length, sha256 };
    }
    const abs = this.resolveLocal(objectKey);
    await fsp.mkdir(dirname(abs), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    if (Buffer.isBuffer(data)) {
      hash.update(data);
      size = data.length;
      await fsp.writeFile(abs, data);
    } else {
      const out = createWriteStream(abs);
      data.on('data', (c: Buffer) => {
        hash.update(c);
        size += c.length;
      });
      await pipeline(data, out);
    }
    return { provider: 'local', objectKey, size, sha256: hash.digest('hex') };
  }

  async getStream(objectKey: string, provider: StorageProvider): Promise<NodeJS.ReadableStream> {
    if (provider === 'minio' && this.minio) {
      const buf = await this.minioGet(objectKey);
      const { Readable } = await import('node:stream');
      return Readable.from(buf);
    }
    return createReadStream(this.resolveLocal(objectKey));
  }

  /** Convenience download path used by callers that need the whole object. */
  async getBuffer(objectKey: string, provider: StorageProvider): Promise<Buffer> {
    if (provider === 'minio' && this.minio) {
      return this.minioGet(objectKey);
    }
    return fsp.readFile(this.resolveLocal(objectKey));
  }

  async delete(objectKey: string, provider: StorageProvider): Promise<void> {
    if (provider === 'minio' && this.minio) {
      await this.minioRequest('DELETE', objectKey);
      return;
    }
    await fsp.rm(this.resolveLocal(objectKey), { force: true });
  }

  private resolveLocal(objectKey: string): string {
    // Reject traversal outright — never silently rewrite caller input.
    if (objectKey.includes('\\') || /(^|\/)\.\.(\/|$)/.test(objectKey)) {
      throw new Error(`object key escapes storage root: ${objectKey}`);
    }
    const cleaned = normalize(objectKey).replace(/^\/+/, '');
    const abs = resolve(this.localRoot, cleaned);
    if (abs !== this.localRoot && !abs.startsWith(this.localRoot + sep)) {
      throw new Error(`object key escapes storage root: ${objectKey}`);
    }
    return abs;
  }

  private async minioPut(key: string, body: Buffer, contentType: string) {
    await this.ensureBucket();
    await this.minioRequest('PUT', key, body, contentType);
  }

  private async minioGet(key: string): Promise<Buffer> {
    return this.minioRequest('GET', key);
  }

  private async ensureBucket() {
    if (!this.minio) return;
    try {
      await this.minioRequest('PUT', '/');
    } catch {
      // BucketAlreadyOwnedByYou / BucketAlreadyExists (409) or a racing
      // create from another instance: object PUT is still valid afterwards.
    }
  }

  /** AWS URI encode (RFC 3986 unreserved only; `!'()*` must be percent-encoded). */
  private static awsUriEncode(value: string): string {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  /** Host header value: omit :port when it is the scheme default (SigV4 rule). */
  private hostHeader(cfg: MinioConfig): string {
    const isDefaultPort =
      (cfg.useSsl && cfg.port === 443) || (!cfg.useSsl && cfg.port === 80);
    return isDefaultPort ? cfg.endpoint : `${cfg.endpoint}:${cfg.port}`;
  }

  /**
   * Minimal S3 v4 signed request (path-style) — no external SDK.
   * Signature chain follows the AWS SigV4 spec:
   *   CanonicalRequest → StringToSign → kDate→kRegion→kService→kSigning → HMAC.
   */
  private minioRequest(
    method: string,
    key: string,
    body?: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<Buffer> {
    const cfg = this.minio!;
    return new Promise((resolvePromise, rejectPromise) => {
      void (async () => {
        try {
          const { createHash: ch, createHmac: hmac } = await import('node:crypto');
          const pathStyle = key === '/' ? `/${cfg.bucket}` : `/${cfg.bucket}/${key}`;
          const now = new Date();
          const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
          const dateStamp = amzDate.slice(0, 8);
          const payloadHash = ch('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
          const region = cfg.region;
          const service = 's3';
          const host = this.hostHeader(cfg);
          const canonicalUri = pathStyle
            .split('/')
            .map((segment) => ObjectStorageService.awsUriEncode(segment))
            .join('/');
          const canonicalHeaders =
            `host:${host}\n` +
            `x-amz-content-sha256:${payloadHash}\n` +
            `x-amz-date:${amzDate}\n`;
          const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
          const canonicalRequest = [
            method,
            canonicalUri,
            '',
            canonicalHeaders,
            signedHeaders,
            payloadHash,
          ].join('\n');
          const scope = `${dateStamp}/${region}/${service}/aws4_request`;
          const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            scope,
            ch('sha256').update(canonicalRequest).digest('hex'),
          ].join('\n');
          const kDate = hmac('sha256', `AWS4${cfg.secretKey}`).update(dateStamp).digest();
          const kRegion = hmac('sha256', kDate).update(region).digest();
          const kService = hmac('sha256', kRegion).update(service).digest();
          const kSigning = hmac('sha256', kService).update('aws4_request').digest();
          const signature = hmac('sha256', kSigning).update(stringToSign).digest('hex');
          const authorization =
            `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`;

          const http = cfg.useSsl ? await import('node:https') : await import('node:http');
          const req = http.request(
            {
              method,
              host: cfg.endpoint,
              port: cfg.port,
              path: canonicalUri,
              headers: {
                Authorization: authorization,
                'x-amz-date': amzDate,
                'x-amz-content-sha256': payloadHash,
                'Content-Type': contentType,
                'Content-Length': body?.length ?? 0,
                Host: host,
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  resolvePromise(buf);
                } else if (method === 'PUT' && key === '/' && res.statusCode === 409) {
                  resolvePromise(buf);
                } else {
                  rejectPromise(
                    new Error(`MinIO ${method} ${key} -> ${res.statusCode}: ${buf.toString().slice(0, 200)}`),
                  );
                }
              });
            },
          );
          req.on('error', rejectPromise);
          if (body) req.write(body);
          req.end();
        } catch (err) {
          rejectPromise(err);
        }
      })();
    });
  }
}

async function bufferStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
