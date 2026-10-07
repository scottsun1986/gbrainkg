import { getRequestContext } from '../observability/request-context';
import { DocumentAclService } from './document-acl.service';
import { PermissionService } from './permission.service';

/** Caller supplies candidate scope before pagination and owns the read transaction. */
export async function filterReadableArtifacts(userId: string, candidates: Array<{ id: string; kbId: string }>, kind: string, prisma: any): Promise<Set<string>> {
  if (!userId || !candidates.length) return new Set();
  const ids = [...new Set(candidates.map(row => row.id))];
  const kbById = new Map(candidates.map(row => [row.id, row.kbId]));
  const encoded = JSON.stringify(ids);
  const docs: any[] = await prisma.$queryRaw`
    SELECT DISTINCT d.id::text,d."kbId"::text,d."aclMode"
    FROM "ArtifactDependency" dep JOIN "Document" d ON d.id=dep."sourceDocumentId"
    WHERE dep."artifactId" IN (SELECT jsonb_array_elements_text(${encoded}::jsonb))`;
  const readable = await new DocumentAclService(new PermissionService()).filterReadableDocuments(userId, docs.map(row => row.id), { docs, prisma });
  const encodedReadable = JSON.stringify([...readable]);
  const asOf = new Date(getRequestContext()?.asOf ?? Date.now());
  const rows: any[] = await prisma.$queryRaw`
    SELECT dep."artifactId",min(d."kbId"::text) AS "kbId",count(*)::int AS count,
      count(DISTINCT dep."sourceDocumentId")::int AS distinct_count,
      max(m."expectedCount")::int AS expected,
      bool_and(m."artifactKind"=${kind} AND dep."artifactKind"=${kind}
        AND d.id IS NOT NULL AND d.status='published'
        AND d.id::text IN (SELECT jsonb_array_elements_text(${encodedReadable}::jsonb))
        AND d."activeVersionId" IS NOT DISTINCT FROM dep."sourceVersionId"
        AND dep."sourceHash"=COALESCE(d."contentHash",'') || ':' || d.version::text
        AND (d."effectiveFrom" IS NULL OR d."effectiveFrom"<=${asOf})
        AND (d."effectiveTo" IS NULL OR d."effectiveTo">${asOf})
        AND (d."lifecycleStatus"<>'repealed' OR d."effectiveTo" IS NOT NULL)) AS valid,
      count(DISTINCT d."kbId")::int AS kb_count
    FROM "ArtifactDependency" dep LEFT JOIN "Document" d ON d.id=dep."sourceDocumentId"
    LEFT JOIN "ArtifactManifest" m ON m."artifactId"=dep."artifactId"
    WHERE dep."artifactId" IN (SELECT jsonb_array_elements_text(${encoded}::jsonb))
    GROUP BY dep."artifactId"`;
  return new Set(rows.filter(row => row.valid === true && row.expected > 0 && row.count === row.expected
    && row.distinct_count === row.expected && row.kb_count === 1 && kbById.get(row.artifactId) === row.kbId).map(row => row.artifactId));
}
