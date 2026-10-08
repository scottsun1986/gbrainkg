import { getPrismaClient } from '../prisma';
import { assertRequestAuthorization } from './authorization-revision';
import { DocumentAclService } from './document-acl.service';
import { PermissionService } from './permission.service';
import { getRequestContext } from '../observability/request-context';

export interface EvidenceDependency { documentId: string; versionId: string | null; number: number; sourceHash: string | null; effectiveTo: string | null }
export function nonEvidenceManifest(outcome: 'failure' | 'refusal') {
  return { kind: 'non_evidence', version: 1, outcome };
}
export interface AggregateEvidenceManifest {
  kind: 'aggregate_evidence'; version: 1; documents: EvidenceDependency[];
  inventories: Array<{ kbId: string; documentIds: string[] }>;
  otherEvidenceDocumentIds: string[];
}
export type EvidenceManifest = EvidenceDependency[] | AggregateEvidenceManifest;
export async function captureEvidenceDependencies(citations: any[]): Promise<EvidenceManifest | null> {
  if (!citations.length) return null;
  const ids = new Set<string>();
  const otherEvidenceDocumentIds = new Set<string>();
  const inventories: AggregateEvidenceManifest['inventories'] = [];
  for (const citation of citations) {
    const documentId = citation?.docId || citation?.documentId;
    if (documentId) { ids.add(String(documentId)); otherEvidenceDocumentIds.add(String(documentId)); }
    else {
      if (!Array.isArray(citation?.sourceDocumentIds) || citation.sourceDocumentIds.some((id: unknown) => typeof id !== 'string' || !id)) return null;
      if (!citation.sourceDocumentIds.length && !citation.inventory) return null;
      for (const id of citation.sourceDocumentIds) {
        ids.add(id);
        if (!citation.inventory) otherEvidenceDocumentIds.add(id);
      }
      if (citation.inventory) {
        if (typeof citation.kbId !== 'string' || !citation.kbId) return null;
        const scope = citation.inventoryScope || [citation.kbId];
        if (!Array.isArray(scope) || !scope.length || scope.some((id: unknown) => typeof id !== 'string' || !id)
          || (scope.length > 1 && citation.sourceDocumentIds.length)) return null;
        for (const kbId of scope) inventories.push({ kbId, documentIds: [...new Set<string>(citation.sourceDocumentIds)].sort() });
      }
    }
  }
  const rows = ids.size ? await getPrismaClient().document.findMany({ where: { id: { in: [...ids] }, status: 'published' },
    select: { id: true, kbId: true, activeVersionId: true, version: true, contentHash: true, effectiveTo: true } }) : [];
  if (rows.length !== ids.size) return null;
  const byId = new Map(rows.map(row => [row.id, row]));
  if (citations.some(c => {
    const row = byId.get(String(c.docId || c.documentId));
    if (!c.docId && !c.documentId && (c.inventory || c.raptor) && c.kbId
      && c.sourceDocumentIds.some((id: string) => byId.get(id)?.kbId !== c.kbId)) return true;
    const version = c.documentVersionId ?? c.document_version_id;
    if (row && ((version != null && version !== row.activeVersionId) || (c.version != null && Number(c.version) !== row.version)
      || (c.evidenceRefs || c.evidence_refs || []).some((ref: any) => ref.versionId !== row.activeVersionId))) return true;
    return (c.sourceManifest || []).some((ref: any) => {
      const source = byId.get(ref.docId || ref.documentId);
      return !source || (ref.version != null && ref.version !== source.version)
        || (ref.documentVersionId != null && ref.documentVersionId !== source.activeVersionId)
        || (ref.sourceHash != null && ref.sourceHash !== source.contentHash);
    });
  })) return null;
  const documents = rows.map(row => ({ documentId: row.id, versionId: row.activeVersionId, number: row.version,
    sourceHash: row.contentHash, effectiveTo: row.effectiveTo?.toISOString() ?? null }));
  return inventories.length ? { kind: 'aggregate_evidence', version: 1, documents, inventories, otherEvidenceDocumentIds: [...otherEvidenceDocumentIds].sort() } : documents;
}
export async function validateEvidenceDependencies(userId: string, manifest: unknown): Promise<boolean> {
  await assertRequestAuthorization();
  return validateEvidenceDependenciesInClient(userId, manifest, getPrismaClient());
}

/** Caller owns authority/locking; all source and ACL reads use its transaction. */
export async function validateEvidenceDependenciesInClient(userId: string, manifest: unknown, prisma: any): Promise<boolean> {
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const marker = manifest as Record<string, unknown>;
    if (marker.kind === 'non_evidence' && marker.version === 1 && ['failure', 'refusal'].includes(String(marker.outcome))) {
      return true;
    }
  }
  const aggregate = manifest && !Array.isArray(manifest) && typeof manifest === 'object'
    && (manifest as any).kind === 'aggregate_evidence' && (manifest as any).version === 1 ? manifest as AggregateEvidenceManifest : null;
  const inventories = aggregate?.inventories;
  if (aggregate) {
    if (!Array.isArray(inventories) || !inventories.length || inventories.some(i => !i?.kbId || !Array.isArray(i.documentIds)
      || i.documentIds.some(id => typeof id !== 'string' || !id)) || !Array.isArray(aggregate.documents)
      || !Array.isArray(aggregate.otherEvidenceDocumentIds) || aggregate.otherEvidenceDocumentIds.some(id => typeof id !== 'string' || !id)) return false;
    manifest = aggregate.documents;
  }
  if (!Array.isArray(manifest) || (!manifest.length && !aggregate) || manifest.some(d => !d?.documentId || !Number.isInteger(d.number))) return false;
  if (new Set(manifest.map(d => d.documentId)).size !== manifest.length) return false;
  if (aggregate) {
    const describedIds = new Set([...inventories!.flatMap(i => i.documentIds), ...aggregate.otherEvidenceDocumentIds]);
    if (describedIds.size !== manifest.length || manifest.some(d => !describedIds.has(d.documentId))) return false;
  }
  const permission = new PermissionService();
  const acl = new DocumentAclService(permission);
  if (aggregate) {
    const visible = await permission.getVisibleKnowledgeBases(userId);
    if (inventories!.some(i => !visible.includes(i.kbId))) return false;
    const population = await prisma.document.findMany({ where: { kbId: { in: inventories!.map(i => i.kbId) }, status: 'published' },
      select: { id: true, kbId: true, aclMode: true, effectiveFrom: true, effectiveTo: true, lifecycleStatus: true } });
    const asOf = getRequestContext()?.asOf ?? Date.now();
    const effectivePopulation = population.filter((d: any) => (!d.effectiveFrom || asOf >= d.effectiveFrom.getTime())
      && (!d.effectiveTo || asOf < d.effectiveTo.getTime()) && !(d.lifecycleStatus === 'repealed' && !d.effectiveTo));
    const readable = await acl.filterReadableDocuments(userId, effectivePopulation.map((d: any) => d.id), { docs: effectivePopulation, prisma, visibleKbIds: visible });
    for (const inventory of inventories!) {
      const actual = effectivePopulation.filter((d: any) => d.kbId === inventory.kbId && readable.has(d.id)).map((d: any) => d.id).sort();
      const expected = [...new Set(inventory.documentIds)].sort();
      if (actual.length !== expected.length || actual.some((id: string, i: number) => id !== expected[i])) return false;
    }
    if (!manifest.length) return true;
  }
  const rows = await prisma.document.findMany({ where: { id: { in: manifest.map(d => d.documentId) }, status: 'published' },
    select: { id: true, kbId: true, aclMode: true, activeVersionId: true, version: true, contentHash: true, lifecycleStatus: true, effectiveFrom: true, effectiveTo: true } });
  const byId = new Map<string, any>(rows.map((row: any) => [row.id, row]));
  const asOf = getRequestContext()?.asOf ?? Date.now();
  if (manifest.some(d => {
    const row = byId.get(d.documentId);
    return !row || row.activeVersionId !== d.versionId || row.version !== d.number || row.contentHash !== d.sourceHash
      || (row.effectiveFrom && asOf < row.effectiveFrom.getTime()) || (row.effectiveTo && asOf >= row.effectiveTo.getTime())
      || (row.lifecycleStatus === 'repealed' && !row.effectiveTo);
  })) return false;
  const readable = await acl.filterReadableDocuments(userId, [...byId.keys()], { docs: rows, prisma });
  return readable.size === byId.size;
}
