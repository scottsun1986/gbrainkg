import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import helmet from 'helmet';
import * as express from 'express';
import { requestIdMiddleware } from './observability/request-id.middleware';
import { metricsMiddleware } from './observability/metrics.middleware';
import { createLogger, resolveLogFormat } from './observability/json-logger';
// compression 是旧式 CJS 导出（无 default），tsconfig 未开启 esModuleInterop，
// 默认导入在编译后会变成 undefined，这里显式按 require 语义引入。
const compression = require('compression');

function loadLocalEnv() {
  try {
    const envFile = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*))\s*$/);
      const value = match?.[2] ?? match?.[3] ?? match?.[4]?.trim();
      if (match?.[1] && value !== undefined && process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch {
    // Container deployments provide env vars directly.
  }
}

async function bootstrap() {
  loadLocalEnv();
  // LOG_FORMAT=json（默认）输出结构化 JSON 日志；pretty 保留 Nest 默认着色日志。
  const logFormat = resolveLogFormat(process.env.LOG_FORMAT);
  const logger = createLogger(logFormat);
  const app = await NestFactory.create(AppModule, {
    ...(logger ? { logger } : {}),
  });
  if (logger) {
    // 同步替换静态 Logger.* 调用，保证 request-id 可关联。
    Logger.overrideLogger(logger as unknown as Parameters<typeof Logger.overrideLogger>[0]);
  }
  app.enableShutdownHooks();

  // 为每个请求生成/透传 x-request-id，并挂到 AsyncLocalStorage 供日志关联。
  app.use(requestIdMiddleware);
  app.use(metricsMiddleware);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          objectSrc: ["'self'", 'blob:', 'data:'],
          frameSrc: ["'self'", 'blob:', 'data:'],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
          connectSrc: ["'self'", 'http:', 'https:', 'ws:', 'wss:'],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(express.json({ limit: '250mb' }));
  app.use(express.urlencoded({ limit: '250mb', extended: true }));
  // 列表/管理后台 JSON 响应普遍在数百 KB 到 MB 级，gzip 可压缩 70%+，
  // 显著缩短弱网/跨地域下页面与列表的首屏等待。
  app.use(compression({ threshold: 1024 }));

  const configuredOrigins = [
    ...(process.env.WEB_ORIGIN || '').split(','),
    ...(process.env.CORS_ORIGINS || '').split(','),
  ].map((origin) => origin.trim()).filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin header.
      if (!origin) return callback(null, true);

      // Whitelist-based CORS: explicit origins from env or safe localhost defaults
      const allowed = configuredOrigins?.length ? configuredOrigins : ['http://localhost:3001', 'http://localhost:3200', 'http://127.0.0.1:3200'];

      // Only allow exact matches against the whitelist OR localhost/127.0.0.1
      // Previously, any IPv4 literal was allowed (security risk with credentials:true)
      const isLocalhost = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

      if (allowed.includes(origin) || isLocalhost) {
        return callback(null, true);
      }
      // Reject without throwing: browsers block it when Access-Control-Allow-Origin is missing
      return callback(null, false);
    },
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));

  const port = Number(process.env.PORT || 3000);
  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = Number(process.env.REDIS_PORT || 6379);
  const redisDb = Number(process.env.REDIS_DB || 0);

  if (port !== 3000 && (!process.env.REDIS_DB || process.env.REDIS_DB === '0')) {
    Logger.warn(
      `[MultiInstanceSafeguard] PORT is ${port} but REDIS_DB is ${redisDb}. ` +
      `Ensure REDIS_DB is isolated per instance to prevent cross-queue interference!`,
      'Bootstrap',
    );
  }

  await app.listen(port, '0.0.0.0');
  Logger.log(
    `Application is running on port ${port} (Redis Queue: ${redisHost}:${redisPort} db=${redisDb}, logFormat=${logFormat})`,
    'Bootstrap',
  );
}
bootstrap();
