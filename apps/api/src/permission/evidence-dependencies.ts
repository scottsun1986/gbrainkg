import { getPrismaClient } from '../prisma';
import { authorizationEnforced, assertRequestAuthorization } from './authorization-revision';
import { DocumentAclService } from './document-acl.service';
import { PermissionService } from './permission.service';
import { getRequestContext } from '../observability/request-context';

export interface EvidenceDependency { documentId: string; versionId: string | null; number: number; sourceHash: string | null; effectiveTo: string | null }
export function nonEvidenceManifest(outcome: 'failure' | 'refusal') {
  return { kind: 'non_evidence', version: 1, outcome };
}
export async function captureEvidenceDependencies(citations: any[]): Promise<EvidenceDependency[] | null> {
  // 派生页引用（RAPTOR 宏观摘要 / 图谱社区摘要等 compiled-truth 页面）没有
  // 源文档 id，其可读性由 compiled-truth 授权链路自行校验，不进入文档清单。
  // 此前任一引用无 docId 就整体返回 null，导致引用中含派生页的回答在读侧
  // 被整体误判为「来源已失效」（2026-10-06 R3 E2E P0）。
  const documentCitations = citations.filter(c => c?.docId || c?.documentId);
  if (!documentCitations.length) return null;
  const citationsUsed = documentCitations;
  const ids: string[] = [...new Set<string>(citationsUsed.map(c => String(c.docId || c.documentId)))];
  const rows = await getPrismaClient().document.findMany({ where: { id: { in: ids }, status: 'published' },
    select: { id: true, activeVersionId: true, version: true, contentHash: true, effectiveTo: true } });
  if (rows.length !== ids.length) return null;
  const byId = new Map(rows.map(row => [row.id,row]));
  if (citationsUsed.some(c => {
    const row = byId.get(String(c.docId || c.documentId))!;
    const version = c.documentVersionId ?? c.document_version_id;
    return (version != null && version !== row.activeVersionId) || (c.version != null && Number(c.version) !== row.version)
      || (c.evidenceRefs || c.evidence_refs || []).some((ref: any) => ref.versionId !== row.activeVersionId);
  })) return null;
  return rows.map(row => ({ documentId: row.id, versionId: row.activeVersionId, number: row.version, sourceHash: row.contentHash,
    effectiveTo: row.effectiveTo?.toISOString() ?? null }));
}
export async function validateEvidenceDependencies(userId: string, manifest: unknown): Promise<boolean> {
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const marker = manifest as Record<string, unknown>;
    if (marker.kind === 'non_evidence' && marker.version === 1 && ['failure', 'refusal'].includes(String(marker.outcome))) {
      await assertRequestAuthorization();
      return true;
    }
  }
  if (!Array.isArray(manifest) || !manifest.length || manifest.some(d => !d?.documentId || !Number.isInteger(d.number))) return false;
  await assertRequestAuthorization();
  const rows = await getPrismaClient().document.findMany({ where: { id: { in: manifest.map(d => d.documentId) }, status: 'published' },
    select: { id: true, kbId: true, aclMode: true, activeVersionId: true, version: true, contentHash: true, lifecycleStatus: true, effectiveFrom: true, effectiveTo: true } });
  const byId = new Map(rows.map(row => [row.id, row]));
  const asOf = getRequestContext()?.asOf ?? Date.now();
  if (manifest.some(d => {
    const row = byId.get(d.documentId);
    return !row || row.activeVersionId !== d.versionId || row.version !== d.number || row.contentHash !== d.sourceHash
      || (row.effectiveFrom && asOf < row.effectiveFrom.getTime()) || (row.effectiveTo && asOf >= row.effectiveTo.getTime())
      || (row.lifecycleStatus === 'repealed' && !row.effectiveTo);
  })) return false;
  const readable = await new DocumentAclService(new PermissionService()).filterReadableDocuments(userId, [...byId.keys()], { docs: rows });
  return readable.size === byId.size;
}
