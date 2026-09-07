import { PrismaClient } from '@prisma/client';

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
