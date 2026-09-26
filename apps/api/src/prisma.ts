import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { withRlsContext } from './db/rls-prisma';

// Prefer the NOBYPASSRLS runtime role (RLS-enforced) when provided.
if (process.env.DATABASE_URL_APP && !process.env.LLMWIKI_FORCE_MIGRATOR_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_APP;
}

if (!process.env.DATABASE_URL) {
  const candidatePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../.env'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq > 0) {
            const k = line.slice(0, eq).trim();
            let v = line.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (!process.env[k]) {
              process.env[k] = v;
            }
          }
        }
        if (process.env.DATABASE_URL) break;
      } catch {
        // ignore
      }
    }
  }
}

// A .env file can supply DATABASE_URL_APP after the initial process-env check.
if (process.env.DATABASE_URL_APP && !process.env.LLMWIKI_FORCE_MIGRATOR_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_APP;
}

// One Prisma pool per API process. This prevents each controller and service
// from silently allocating an independent PostgreSQL connection pool.
//
// Pool sizing is explicit rather than implicit: Prisma's default is
// num_cpus * 2 + 1 per process, which on a 2 vCPU box that also runs the
// enrichment workers produced "Unable to start a transaction in the given
// time" under load (the API shares PostgreSQL with GBrain, the parser worker and
// every BullMQ consumer). ENABLE the bound by setting PRISMA_CONNECTION_LIMIT;
// an explicit value already present in DATABASE_URL always wins.
function withConnectionPoolParams(url: string | undefined): string | undefined {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  const limit = Number(process.env.PRISMA_CONNECTION_LIMIT || 0);
  const poolTimeout = Number(process.env.PRISMA_POOL_TIMEOUT_SECONDS || 0);
  if (!Number.isFinite(limit) || limit <= 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  const params = [`connection_limit=${Math.floor(limit)}`];
  if (Number.isFinite(poolTimeout) && poolTimeout > 0) {
    params.push(`pool_timeout=${Math.floor(poolTimeout)}`);
  }
  return `${url}${separator}${params.join('&')}`;
}

if (process.env.DATABASE_URL) {
  const bounded = withConnectionPoolParams(process.env.DATABASE_URL);
  if (bounded) process.env.DATABASE_URL = bounded;
}

const prismaGlobal = globalThis as typeof globalThis & {
  __llmwikiPrisma?: PrismaClient;
  __llmwikiPrismaRaw?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  if (!prismaGlobal.__llmwikiPrisma) {
    if (process.env.RLS_ENFORCE === '1' && !process.env.LLMWIKI_FORCE_MIGRATOR_URL) {
      if (!process.env.DATABASE_URL_APP) {
        throw new Error('RLS_ENFORCE=1 requires DATABASE_URL_APP (a dedicated NOBYPASSRLS runtime role)');
      }
      process.env.DATABASE_URL = withConnectionPoolParams(process.env.DATABASE_URL_APP);
    }
    const raw = new PrismaClient();
    prismaGlobal.__llmwikiPrismaRaw = raw;
    prismaGlobal.__llmwikiPrisma = process.env.RLS_ENFORCE === '1' && !process.env.LLMWIKI_FORCE_MIGRATOR_URL
      ? withRlsContext(raw)
      : raw;
  }
  return prismaGlobal.__llmwikiPrisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prismaGlobal.__llmwikiPrismaRaw) return;
  await prismaGlobal.__llmwikiPrismaRaw.$disconnect();
  prismaGlobal.__llmwikiPrisma = undefined;
  prismaGlobal.__llmwikiPrismaRaw = undefined;
}
