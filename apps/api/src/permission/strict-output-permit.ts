import { ForbiddenException } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext, getRequestContext } from '../observability/request-context';
import type { AuthorizationSnapshot } from './authorization-revision';

/** Mutation commits serialize with buffered transport acceptance. This does not recall bytes already sent. */
export async function withStrictOutputPermit(userId: string, snapshot: AuthorizationSnapshot, emitAndDrain: () => Promise<void>, manifest: unknown = getRequestContext()?.evidenceDependencies) {
  if (snapshot.revision === 'disabled') throw new ForbiddenException('Strict output requires authorization enforcement');
  return runWithRequestContext({ ...getRequestContext(), requestId: randomUUID(), userId, execution: undefined }, () => getPrismaClient().$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(current_database() || ':core-auth-output',0))`;
    const rows = await tx.$queryRaw<Array<{ revision: bigint; policyVersion: string; active: boolean }>>`
      SELECT revision,"policyVersion",EXISTS(SELECT 1 FROM "User" WHERE id=${userId}::uuid AND status='active') AS active
      FROM "AuthorizationState" WHERE id=1
    `;
    if (!rows[0]?.active || String(rows[0].revision) !== snapshot.revision || rows[0].policyVersion !== snapshot.policyVersion || Date.now() >= snapshot.expiresAt) {
      throw new ForbiddenException('Authorization changed; buffered answer discarded');
    }
    const nonEvidence = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      && (manifest as any).kind === 'non_evidence' && (manifest as any).version === 1
      && ['failure', 'refusal'].includes((manifest as any).outcome);
    if (!nonEvidence) {
      const valid = await tx.$queryRaw<Array<{ readable: boolean }>>`
        SELECT app_manifest_documents_readable(${JSON.stringify(manifest ?? null)}::jsonb, true) AS readable
      `;
      if (valid[0]?.readable !== true) throw new ForbiddenException('Source evidence changed; buffered answer discarded');
    }
    if (getRequestContext()?.cancellation?.aborted) throw getRequestContext()!.cancellation!.reason;
    await emitAndDrain();
  }, { maxWait: 2000, timeout: 8000 }));
}
