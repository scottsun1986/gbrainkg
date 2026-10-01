import { instanceIdentity } from '../observability/instance-identity';
import { randomUUID } from 'node:crypto';
import { getRequestContext, runWithRequestContext } from '../observability/request-context';
import { getPrismaClient } from '../prisma';

/** The worker boundary supplies identity. HTTP request handlers cannot promote themselves. */
export function runAsService<T>(purpose: string, work: () => Promise<T>, kbId?: string): Promise<T> {
  const previous = getRequestContext();
  if (previous && !previous.servicePrincipal) throw new Error('Cannot promote request identity to service');
  return runWithRequestContext({ requestId: previous?.requestId || randomUUID(),
    instanceId: instanceIdentity(), servicePrincipal: purpose,
    artifactInputs: previous?.artifactInputs }, async () => {
    if (kbId && (process.env.RLS_ENFORCE === '1' || process.env.CORE_AUTH_ENFORCE === '1')) {
      const rows = await getPrismaClient().$queryRaw<Array<{ documentId: string; versionId: string | null; sourceHash: string }>>`
        SELECT id::text AS "documentId", "activeVersionId"::text AS "versionId",
          COALESCE("contentHash",'') || ':' || version::text AS "sourceHash"
        FROM "Document" WHERE "kbId"=${kbId}::uuid AND status='published'
      `;
      getRequestContext()!.artifactInputs = JSON.stringify(rows);
    }
    return work();
  });
}
