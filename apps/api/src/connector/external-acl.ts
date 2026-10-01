import { randomUUID } from 'node:crypto';
import type { ConnectorChange } from './types';
import { normalizeAclEntry } from '../permission/document-acl.service';

/** Only administrator-configured local subjects or mappings may expand access. */
export async function syncExternalAcl(tx: any, documentId: string, config: any, change: ConnectorChange) {
  if (change.externalAcl?.verified === false) return restrictInvalidMapping(tx,documentId,change);
  const mapping = config?.aclMapping;
  const mode = mapping?.mode === 'inherit' ? 'inherit' : 'restricted';
  const entries: any[] = [];
  if (mode === 'restricted') {
    for (const subject of change.externalAcl?.subjects || []) {
      const local = mapping?.subjects?.[`${subject.type}:${subject.id}`];
      if (local) {
        try { entries.push(normalizeAclEntry(local)); }
        catch { return restrictInvalidMapping(tx, documentId, change); }
      }
    }
    for (const local of mapping?.localSubjects || []) {
      try { entries.push(normalizeAclEntry(local)); }
      catch { return restrictInvalidMapping(tx, documentId, change); }
    }
  }
  // Unknown source ACL never implies local inheritance. An external public bit
  // is recorded, while local inheritance requires an explicit admin mapping.
  await tx.document.update({ where: { id: documentId }, data: {
    aclMode: mode, sourceExternalRevision: change.externalRevision || change.externalAcl?.revision || null,
    sourceExternalAcl: change.externalAcl || {}, sourceAclSyncedAt: new Date(),
    sourceAclSyncStatus: mapping ? 'mapped' : 'pending_mapping',
  } });
  await tx.documentAcl.deleteMany({ where: { documentId } });
  if (entries.length) await tx.documentAcl.createMany({ data: entries.map(entry => ({ id: randomUUID(), documentId, ...entry })), skipDuplicates: true });
  await tx.brainChangeEvent.create({ data: { eventType: 'doc_acl_change', resourceType: 'document', resourceId: documentId, status: 'pending', payload: {} } });
}
async function restrictInvalidMapping(tx: any, documentId: string, change: ConnectorChange) {
  await tx.document.update({ where: { id: documentId }, data: { aclMode: 'restricted', sourceAclSyncStatus: change.externalAcl?.verified===false ? 'source_acl_unavailable':'invalid_mapping', sourceExternalAcl: change.externalAcl || {} } });
  await tx.documentAcl.deleteMany({ where: { documentId } });
  await tx.brainChangeEvent.create({ data: { eventType: 'doc_acl_change', resourceType: 'document', resourceId: documentId, status: 'pending', payload: { reason: 'invalid_mapping' } } });
}
