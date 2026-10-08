import { Prisma } from '@prisma/client';
import { getRequestContext } from '../observability/request-context';
import { authorizationEnforced } from '../permission/authorization-revision';

/** Scope must already contain only KBs visible to the caller. Alias: d. */
export function readableDocumentSql(): Prisma.Sql {
  const ctx = getRequestContext();
  const at = new Date(ctx?.asOf ?? Date.now());
  const userId = ctx?.userId;
  const access = userId ? Prisma.sql`(
    EXISTS (SELECT 1 FROM "KnowledgeBase" kb WHERE kb.id=d."kbId" AND kb."ownerUserId"=${userId}::uuid)
    OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId"=d."kbId" AND a."userId"=${userId}::uuid)
    OR (d."aclMode"<>'restricted' AND NOT EXISTS (SELECT 1 FROM "DocumentAcl" a WHERE a."documentId"=d.id))
    OR EXISTS (SELECT 1 FROM "DocumentAcl" a WHERE a."documentId"=d.id AND (
      (a."subjectType"='user' AND a."subjectId"=${userId}::uuid)
      OR (a."subjectType"='role' AND EXISTS (SELECT 1 FROM "UserRole" r WHERE r."userId"=${userId}::uuid AND r."roleId"=a."subjectId"))
      OR (a."subjectType"='org' AND EXISTS (SELECT 1 FROM "UserOrg" o WHERE o."userId"=${userId}::uuid AND o."orgNodeId"=a."subjectId"))
    )))` : Prisma.sql`${!authorizationEnforced()}`;
  return Prisma.sql`${access}
    AND (d."effectiveFrom" IS NULL OR d."effectiveFrom"<=${at})
    AND (d."effectiveTo" IS NULL OR d."effectiveTo">${at})
    AND (d."lifecycleStatus"<>'repealed' OR d."effectiveTo" IS NOT NULL)`;
}

export async function readableDocumentWhere(db: any, userId = getRequestContext()?.userId): Promise<any> {
  const at = new Date(getRequestContext()?.asOf ?? Date.now());
  const temporal = { AND: [
    { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: at } }] },
    { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    { OR: [{ lifecycleStatus: { not: 'repealed' } }, { effectiveTo: { not: null } }] },
  ] };
  if (!userId) return authorizationEnforced() ? { id: { in: [] } } : temporal;
  const [roles, orgs] = await Promise.all([
    db.userRole?.findMany({ where: { userId }, select: { roleId: true } }) ?? [],
    db.userOrg?.findMany({ where: { userId }, select: { orgNodeId: true } }) ?? [],
  ]);
  return { AND: [temporal, { OR: [
    { kb: { ownerUserId: userId } },
    { kb: { admins: { some: { userId } } } },
    { aclMode: { not: 'restricted' }, aclEntries: { none: {} } },
    { aclEntries: { some: { OR: [
      { subjectType: 'user', subjectId: userId },
      { subjectType: 'role', subjectId: { in: roles.map((r: any) => r.roleId) } },
      { subjectType: 'org', subjectId: { in: orgs.map((o: any) => o.orgNodeId) } },
    ] } } },
  ] }] };
}

/** The connection is retained until PostgreSQL finishes or cancels the query. */
export async function boundedRead(db: any, work: (tx: any) => Promise<any>, timeoutMs = 2500): Promise<any> {
  const execution = getRequestContext()?.execution;
  const remaining = execution?.deadline.remainingMs();
  if (getRequestContext()?.cancellation?.aborted || (remaining !== undefined && remaining <= 0)) return [];
  const safeTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30000, Math.ceil(timeoutMs))) : 2500;
  const budget = remaining === undefined ? safeTimeout : Math.max(1, Math.min(safeTimeout, Math.ceil(remaining)));
  return db.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(budget)}, true)`;
    return work(tx);
  }, { maxWait: budget, timeout: budget + 1000 });
}

export async function boundedReadSql(db: any, query: Prisma.Sql, timeoutMs = 2500): Promise<any> {
  return boundedRead(db, tx => tx.$queryRaw(query), timeoutMs);
}
