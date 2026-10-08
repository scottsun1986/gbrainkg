const mockPrisma = { document: { findMany: jest.fn() } };
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));
jest.mock('./authorization-revision', () => ({ assertRequestAuthorization: jest.fn().mockResolvedValue(undefined) }));
import { assertRequestAuthorization } from './authorization-revision';
import { captureEvidenceDependencies, nonEvidenceManifest, validateEvidenceDependencies } from './evidence-dependencies';

describe('Evidence dependency manifests', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each(['failure', 'refusal'] as const)('accepts explicit %s status after authorization', async outcome => {
    await expect(validateEvidenceDependencies('u', nonEvidenceManifest(outcome))).resolves.toBe(true);
    expect(assertRequestAuthorization).toHaveBeenCalled();
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { kind: 'non_evidence', version: 2, outcome: 'failure' },
    { kind: 'non_evidence', version: 1, outcome: 'answer' }])('rejects missing or unknown provenance %p', async manifest => {
    await expect(validateEvidenceDependencies('u', manifest)).resolves.toBe(false);
  });
  it('does not permit status output after authorization fails', async () => {
    (assertRequestAuthorization as jest.Mock).mockRejectedValueOnce(new Error('Authorization expired'));
    await expect(validateEvidenceDependencies('u', nonEvidenceManifest('failure'))).rejects.toThrow('Authorization expired');
  });
});


describe('aggregate evidence capture', () => {
  beforeEach(() => jest.clearAllMocks());
  it('captures original and all summary documents', async () => {
    mockPrisma.document.findMany.mockResolvedValue(['a', 'b', 'c'].map(id => ({ id, activeVersionId: 'v', version: 2, contentHash: id })));
    const manifest = await captureEvidenceDependencies([{ docId: 'a' }, { raptor: true, sourceDocumentIds: ['b', 'c'] }]);
    expect((manifest as any[]).map(d => d.documentId)).toEqual(['a', 'b', 'c']);
  });
  it('rejects any untracked derived citation in a mixed answer', async () => {
    await expect(captureEvidenceDependencies([{ docId: 'a' }, { raptor: true }])).resolves.toBeNull();
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
  });
  it('captures explicit empty inventories for every selected KB', async () => {
    await expect(captureEvidenceDependencies([{ inventory: true, kbId: 'a', inventoryScope: ['a', 'b'], sourceDocumentIds: [] }]))
      .resolves.toMatchObject({ kind: 'aggregate_evidence', documents: [], inventories: [{ kbId: 'a', documentIds: [] }, { kbId: 'b', documentIds: [] }] });
  });
  it('rejects changed source versions before persistence', async () => {
    mockPrisma.document.findMany.mockResolvedValue([{ id: 'a', activeVersionId: 'new', version: 2, contentHash: 'new' }]);
    await expect(captureEvidenceDependencies([{ sourceDocumentIds: ['a'], sourceManifest: [{ docId: 'a', documentVersionId: 'old' }] }])).resolves.toBeNull();
  });
});

describe('inventory provenance scope', () => {
  it('rejects cross-KB inventory source association at capture', async () => {
    mockPrisma.document.findMany.mockResolvedValue([{ id: 'doc-b', kbId: 'kb-b', activeVersionId: null, version: 1, contentHash: null }]);
    await expect(captureEvidenceDependencies([{ inventory: true, kbId: 'kb-a', sourceDocumentIds: ['doc-b'] }])).resolves.toBeNull();
  });
  it('records mixed original and inventory sources explicitly', async () => {
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'doc-a', kbId: 'kb-a', activeVersionId: null, version: 1, contentHash: null },
      { id: 'doc-b', kbId: 'kb-b', activeVersionId: null, version: 1, contentHash: null },
    ]);
    await expect(captureEvidenceDependencies([{ docId: 'doc-a' }, { inventory: true, kbId: 'kb-b', sourceDocumentIds: ['doc-b'] }]))
      .resolves.toMatchObject({ inventories: [{ kbId: 'kb-b', documentIds: ['doc-b'] }], otherEvidenceDocumentIds: ['doc-a'] });
  });
  it('rejects undescribed extra dependency before database or ACL reads', async () => {
    mockPrisma.document.findMany.mockClear();
    await expect(validateEvidenceDependencies('user', { kind: 'aggregate_evidence', version: 1,
      documents: [{ documentId: 'extra', number: 1 }], inventories: [{ kbId: 'kb-a', documentIds: [] }], otherEvidenceDocumentIds: [] })).resolves.toBe(false);
    expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
  });
});

describe('inventory read-side scope', () => {
  it('validates legitimate original A plus inventory B and denies cross-KB associations', async () => {
    const { PermissionService } = await import('./permission.service');
    const { DocumentAclService } = await import('./document-acl.service');
    const visible = jest.spyOn(PermissionService.prototype, 'getVisibleKnowledgeBases').mockResolvedValue(['kb-a', 'kb-b']);
    const readable = jest.spyOn(DocumentAclService.prototype, 'filterReadableDocuments').mockImplementation(async (_user, ids) => new Set(ids));
    const docs = ['a', 'b'].map(id => ({ id: `doc-${id}`, kbId: `kb-${id}`, activeVersionId: null, version: 1, contentHash: null }));
    const dependencies = docs.map(doc => ({ documentId: doc.id, versionId: null, number: 1, sourceHash: null, effectiveTo: null }));
    try {
      mockPrisma.document.findMany.mockResolvedValueOnce([docs[1]]).mockResolvedValueOnce(docs);
      await expect(validateEvidenceDependencies('user', { kind: 'aggregate_evidence', version: 1, documents: dependencies,
        inventories: [{ kbId: 'kb-b', documentIds: ['doc-b'] }], otherEvidenceDocumentIds: ['doc-a'] })).resolves.toBe(true);
      mockPrisma.document.findMany.mockResolvedValueOnce([docs[0]]);
      await expect(validateEvidenceDependencies('user', { kind: 'aggregate_evidence', version: 1, documents: [dependencies[1]],
        inventories: [{ kbId: 'kb-a', documentIds: ['doc-b'] }], otherEvidenceDocumentIds: [] })).resolves.toBe(false);
    } finally { visible.mockRestore(); readable.mockRestore(); }
  });
});
