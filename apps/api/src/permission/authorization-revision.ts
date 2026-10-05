import { ForbiddenException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { getRequestContext } from '../observability/request-context';
import { runWithRequestContext } from '../observability/request-context';
import { randomUUID } from 'node:crypto';

export interface AuthorizationSnapshot {
  revision: string;
  policyVersion: string;
  expiresAt: number;
}

export function authorizationEnforced(): boolean {
  return process.env.CORE_AUTH_ENFORCE === '1' || process.env.RLS_ENFORCE === '1';
}

/** Primary database read: notifications and Scope epochs are not the authority. */
export async function readAuthorizationSnapshot(userId: string): Promise<AuthorizationSnapshot> {
  if (!authorizationEnforced()) return { revision: 'disabled', policyVersion: 'core-auth-v1', expiresAt: Infinity };
  if (!userId) throw new ForbiddenException('Authenticated user required');
  try {
    const rows = await runWithRequestContext({ ...getRequestContext(), requestId: getRequestContext()?.requestId || randomUUID(), userId, execution: undefined }, () => getPrismaClient().$queryRaw<Array<{
      revision: bigint; policyVersion: string; expiresAt: Date | null; active: boolean;
    }>>`
      SELECT s.revision, s."policyVersion",
        EXISTS(SELECT 1 FROM "User" WHERE id=${userId}::uuid AND status='active') AS active,
        (SELECT min(boundary) FROM (
          SELECT min("expiresAt") AS boundary FROM "IndustryGrant" WHERE "expiresAt">statement_timestamp()
          UNION ALL SELECT min("effectiveFrom") FROM "Document" WHERE status='published' AND "effectiveFrom">statement_timestamp()
          UNION ALL SELECT min("effectiveTo") FROM "Document" WHERE status='published' AND "effectiveTo">statement_timestamp()
        ) boundaries) AS "expiresAt"
      FROM "AuthorizationState" s WHERE s.id=1
    `);
    if (!rows.length) throw new Error('Authorization state is not initialized');
    if (!rows[0].active) throw new ForbiddenException('User access was revoked');
    return { revision: String(rows[0].revision), policyVersion: rows[0].policyVersion,
      expiresAt: rows[0].expiresAt ? new Date(rows[0].expiresAt).getTime() : Infinity };
  } catch (error) {
    if (error instanceof ForbiddenException) throw error;
    new Logger('AuthorizationAuthority').error(`Authority read failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new ServiceUnavailableException('Authorization authority unavailable');
  }
}

export async function assertAuthorizationSnapshot(userId: string, snapshot: AuthorizationSnapshot): Promise<void> {
  const current = await readAuthorizationSnapshot(userId);
  if (current.revision !== snapshot.revision || current.policyVersion !== snapshot.policyVersion || Date.now() >= snapshot.expiresAt) {
    throw new ForbiddenException('Authorization changed; retry the request');
  }
}

/** Used immediately before any evidence-bearing model request. */
export async function assertRequestAuthorization(): Promise<void> {
  const ctx = getRequestContext();
  if (ctx?.authorization && ctx.userId) await assertAuthorizationSnapshot(ctx.userId, ctx.authorization);
}

export function withAuthorizedRequest<T>(userId: string, work: (snapshot: AuthorizationSnapshot) => Promise<T>): Promise<T> {
  const previous = getRequestContext();
  return runWithRequestContext({ ...previous, servicePrincipal: undefined, artifactInputs: undefined, requestId: previous?.requestId || randomUUID(), userId }, async () => {
    const snapshot = await readAuthorizationSnapshot(userId);
    getRequestContext()!.authorization = snapshot;
    return work(snapshot);
  });
}

export function rethrowAuthorizationFailure(error: unknown): void {
  const status = (error as any)?.getStatus?.();
  if (status === 403 || status === 503) throw error;
}

/** Mandatory ACL verification has its own bounded RLS query timeout. Exhausting
 * optional retrieval cannot suppress this check or turn it into an unfiltered return.
 * Keep identity, snapshot and caller cancellation; only detach retrieval budget.
 */
export function withAuthorizationVerification<T>(work: () => Promise<T>): Promise<T> {
  const previous = getRequestContext();
  if (!previous) return work();
  return runWithRequestContext({ ...previous, execution: undefined }, async () => {
    if (previous.cancellation?.aborted) throw previous.cancellation.reason;
    const result = await work();
    if (previous.cancellation?.aborted) throw previous.cancellation.reason;
    return result;
  });
}
