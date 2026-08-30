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
  
  app.use(helmet());
  app.use(express.json({ limit: '10mb' }));

  const configuredOrigins = process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);
  app.enableCors({
    origin: configuredOrigins?.length ? configuredOrigins : ['http://localhost:3001'],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, process.env.HOST || '0.0.0.0');
  Logger.log(`Application is running on port ${port}`, 'Bootstrap');
}
bootstrap();
