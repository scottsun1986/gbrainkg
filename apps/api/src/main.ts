import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import helmet from 'helmet';
import * as express from 'express';

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
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  
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

  const configuredOrigins = [
    ...(process.env.WEB_ORIGIN || '').split(','),
    ...(process.env.CORS_ORIGINS || '').split(','),
  ].map((origin) => origin.trim()).filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin header.
      if (!origin) return callback(null, true);
      const allowed = configuredOrigins?.length ? configuredOrigins : ['http://localhost:3001', 'http://localhost:3200', 'http://127.0.0.1:3200'];
      // Literal IP hosts (LAN/intranet) stay allowed so multi-host deployments
      // keep working, but arbitrary public domains must be explicitly listed
      // in WEB_ORIGIN. Previously every origin was unconditionally accepted.
      const isLocalOrIpHost =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(origin);
      if (allowed.includes(origin) || isLocalOrIpHost) {
        return callback(null, true);
      }
      // Reject without throwing: the response simply carries no
      // Access-Control-Allow-Origin header, so browsers block it while
      // server-to-server callers are unaffected.
      return callback(null, false);
    },
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Application is running on port ${port}`, 'Bootstrap');
}
bootstrap();
