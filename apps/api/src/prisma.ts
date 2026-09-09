import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

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

// One Prisma pool per API process. This prevents each controller and service
// from silently allocating an independent PostgreSQL connection pool.
const prismaGlobal = globalThis as typeof globalThis & {
  __llmwikiPrisma?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  prismaGlobal.__llmwikiPrisma ??= new PrismaClient();
  return prismaGlobal.__llmwikiPrisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prismaGlobal.__llmwikiPrisma) return;
  await prismaGlobal.__llmwikiPrisma.$disconnect();
  prismaGlobal.__llmwikiPrisma = undefined;
}
