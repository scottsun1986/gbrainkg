import { ForbiddenException } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from '../observability/request-context';
import type { AuthorizationSnapshot } from './authorization-revision';

/** Mutation commits serialize with buffered transport acceptance. This does not recall bytes already sent. */
export async function withStrictOutputPermit(userId: string, snapshot: AuthorizationSnapshot, emitAndDrain: () => Promise<void>) {
  if (snapshot.revision === 'disabled') throw new ForbiddenException('Strict output requires authorization enforcement');
  return runWithRequestContext({ requestId: randomUUID(), userId }, () => getPrismaClient().$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(current_database() || ':core-auth-output',0))`;
    const rows = await tx.$queryRaw<Array<{ revision: bigint; policyVersion: string; active: boolean }>>`
      SELECT revision,"policyVersion",EXISTS(SELECT 1 FROM "User" WHERE id=${userId}::uuid AND status='active') AS active
      FROM "AuthorizationState" WHERE id=1
    `;
    if (!rows[0]?.active || String(rows[0].revision) !== snapshot.revision || rows[0].policyVersion !== snapshot.policyVersion || Date.now() >= snapshot.expiresAt) {
      throw new ForbiddenException('Authorization changed; buffered answer discarded');
    }
    await emitAndDrain();
  }, { maxWait: 2000, timeout: 8000 }));
}
