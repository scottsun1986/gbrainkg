import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
jest.mock('node:fs/promises', () => ({ readFile: jest.fn(), stat: jest.fn() }));
import { KnowledgeOperationsService } from './knowledge-operations.service';
jest.mock('../permission/evidence-dependencies', () => ({ validateEvidenceDependenciesInClient: jest.fn() }));
import { validateEvidenceDependenciesInClient } from '../permission/evidence-dependencies';
const user = 'user'; const kb = 'kb'; const doc = 'doc';
describe('KnowledgeOperationsService boundaries', () => {
  let permission: any; let db: any; let service: KnowledgeOperationsService;
  beforeEach(() => {
    permission = { getVisibleKnowledgeBases: jest.fn().mockResolvedValue([kb]), canManageKnowledgeBase: jest.fn().mockResolvedValue(true) };
    db = { document: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      knowledgeBase: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      documentVersion: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      conversation: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      message: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn() };
    service = new KnowledgeOperationsService(permission);
    (validateEvidenceDependenciesInClient as jest.Mock).mockResolvedValue(false);
  });
  it('applies the same ACL and temporal predicates before list pagination and total', async () => {
    await service.readResource(user, { kind: 'documents', args: { kb_id: kb, limit: 2, offset: 20 } }, db);
    const query = db.document.findMany.mock.calls[0][0];
    expect(query.take).toBe(2); expect(query.skip).toBe(20);
    expect(query.where).toEqual(db.document.count.mock.calls[0][0].where);
    const serialized = JSON.stringify(query.where);
    expect(serialized).toContain('aclEntries'); expect(serialized).toContain('restricted');
    expect(serialized).toContain('effectiveTo'); expect(serialized).toContain(kb);
    expect(permission.getVisibleKnowledgeBases).toHaveBeenCalledWith(user, db);
  });
  it('denies invisible KB before document queries', async () => {
    await expect(service.readResource(user, { kind: 'documents', args: { kb_id: 'forbidden' } }, db)).rejects.toThrow();
    expect(db.document.findMany).not.toHaveBeenCalled(); expect(db.document.count).not.toHaveBeenCalled();
  });
  it('counts only readable published documents within visible KB inventory', async () => {
    await service.readResource(user, { kind: 'knowledge_bases', args: {} }, db);
    const query = db.knowledgeBase.findMany.mock.calls[0][0];
    expect(query.where.id.in).toEqual([kb]);
    expect(query.select._count.select.documents.where.status).toBe('published');
    expect(JSON.stringify(query.select._count.select.documents.where)).toContain('aclEntries');
  });
  it('reads immutable active artifacts with bounded range and source manifest', async () => {
    db.document.findFirst.mockResolvedValueOnce({ id: doc, kbId: kb, status: 'published', activeVersionId: 'active', mdPath: 'mutable/secret.md' }).mockResolvedValueOnce({ id: doc });
    db.documentVersion.findFirst.mockResolvedValue({ sourceHash: 'source', manifestHash: 'manifest', number: 2 });
    db.$queryRaw.mockResolvedValue([{ id: 'block', ord: 1, total: 12n, fragment: 'tail', charStart: 3, charEnd: 7 }]);
    const result = await service.readResource(user, { kind: 'document', args: { doc_id: doc, offset: 8, limit: 4 } }, db);
    expect(result.markdown_content).toBe('tail'); expect(result.total_chars).toBe(12); expect(result.next_offset).toBeNull();
    expect(result.active_version_id).toBe('active'); expect(result.manifest_hash).toBe('manifest');
    expect(result.document.mdPath).toBeUndefined();
    const [strings, ...values] = db.$queryRaw.mock.calls[0];
    expect(strings.join('')).toContain('"BlockArtifact"'); expect(strings.join('')).toContain('"rawContent"');
    expect(values).toContain('active'); expect(values).toContain(8); expect(values).toContain(12);
  });
  it('rejects active publication changing during artifact read', async () => {
    db.document.findFirst.mockResolvedValueOnce({ id: doc, status: 'published', activeVersionId: 'active' }).mockResolvedValueOnce(null);
    db.documentVersion.findFirst.mockResolvedValue({}); db.$queryRaw.mockResolvedValue([]);
    await expect(service.readResource(user, { kind: 'document', args: { doc_id: doc } }, db)).rejects.toThrow('Published version changed');
  });
  it('pages the legacy source by Unicode characters without losing the tail', async () => {
    const markdown = 'a😀tail'; const hash = createHash('sha256').update(markdown).digest('hex');
    (stat as jest.Mock).mockResolvedValue({ size: 9 }); (readFile as jest.Mock).mockResolvedValue(markdown);
    db.document.findFirst.mockResolvedValueOnce({ id: doc, status: 'published', version: 3, activeVersionId: null, contentHash: hash, mdPath: 'doc/content.md' }).mockResolvedValueOnce({ id: doc });
    const result = await service.readResource(user, { kind: 'document', args: { doc_id: doc, offset: 1, limit: 2 } }, db);
    expect(result.markdown_content).toBe('😀t'); expect(result.total_chars).toBe(6); expect(result.next_offset).toBe(3);
    expect(db.document.findFirst.mock.calls[1][0].where).toEqual(expect.objectContaining({ version: 3, contentHash: hash, activeVersionId: null }));
  });
  it.each(['hash', 'revision'])('rejects a mutable legacy source %s race', async reason => {
    (stat as jest.Mock).mockResolvedValue({ size: 4 }); (readFile as jest.Mock).mockResolvedValue('tail');
    const hash = createHash('sha256').update('tail').digest('hex');
    db.document.findFirst.mockResolvedValueOnce({ id: doc, status: 'published', version: 3, activeVersionId: null, contentHash: reason === 'hash' ? 'wrong' : hash, mdPath: 'doc/content.md' }).mockResolvedValueOnce(reason === 'revision' ? null : { id: doc });
    await expect(service.readResource(user, { kind: 'document', args: { doc_id: doc } }, db)).rejects.toThrow('Document source changed');
  });
  it('lists versions without server paths and records the current active version', async () => {
    db.document.findFirst.mockResolvedValue({ id: doc, status: 'published', activeVersionId: 'active', version: 2 });
    const result = await service.readResource(user, { kind: 'versions', args: { doc_id: doc } }, db);
    expect(result.active_version_id).toBe('active');
    expect(db.documentVersion.findMany.mock.calls[0][0].select).not.toHaveProperty('mdPath');
    expect(db.documentVersion.findMany.mock.calls[0][0].select).not.toHaveProperty('publicationData');
  });
  it('rechecks current manager permissions and keeps mutation confirmations minimal', async () => {
    db.document.findFirst.mockResolvedValue({ id: doc, kbId: kb, title: 'sensitive' });
    const result = await service.readResource(user, { kind: 'mutation_receipt', args: { kb_id: kb, doc_id: doc, action: 'retry_document' } }, db);
    expect(permission.canManageKnowledgeBase).toHaveBeenCalledWith(user, kb, db);
    expect(result).toEqual({ document_id: doc, kb_id: kb, status: 'accepted' });
    permission.canManageKnowledgeBase.mockResolvedValue(false); db.document.findFirst.mockClear();
    await expect(service.readResource(user, { kind: 'mutation_receipt', args: { kb_id: kb, doc_id: doc, action: 'delete_document' } }, db)).rejects.toThrow();
    expect(db.document.findFirst).not.toHaveBeenCalled();
  });
  it('owner-scopes cursors before querying another user conversation', async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(service.readResource(user, { kind: 'conversations', args: { before: 'other-cursor' } }, db)).rejects.toThrow();
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: 'other-cursor', userId: user });
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });
  it('revalidates history dependencies and removes inaccessible content and citations', async () => {
    const original = process.env.CORE_AUTH_ENFORCE;
    process.env.CORE_AUTH_ENFORCE = '1';
    try {
      db.conversation.findFirst.mockResolvedValue({ id: 'conversation' });
      db.message.findMany.mockResolvedValue([{ id: 'message', role: 'assistant', content: 'secret', citationsSummary: ['secret'], dependencyManifest: { old: true } }]);
      const result = await service.readResource(user, { kind: 'conversation', args: { conversation_id: 'conversation' } }, db);
      expect(validateEvidenceDependenciesInClient).toHaveBeenCalledWith(user, { old: true }, db);
      expect(result.messages[0].content).not.toContain('secret'); expect(result.messages[0].citationsSummary).toBeNull();
      expect(result.messages[0]).not.toHaveProperty('dependencyManifest');
    } finally {
      if (original === undefined) delete process.env.CORE_AUTH_ENFORCE; else process.env.CORE_AUTH_ENFORCE = original;
    }
  });
  it('returns history content unchanged when authorization is not enforced (no manifests are persisted)', async () => {
    const original = process.env.CORE_AUTH_ENFORCE;
    delete process.env.CORE_AUTH_ENFORCE;
    (validateEvidenceDependenciesInClient as jest.Mock).mockClear();
    try {
      db.conversation.findFirst.mockResolvedValue({ id: 'conversation' });
      db.message.findMany.mockResolvedValue([{ id: 'message', role: 'assistant', content: 'answer', citationsSummary: null, dependencyManifest: null }]);
      const result = await service.readResource(user, { kind: 'conversation', args: { conversation_id: 'conversation' } }, db);
      expect(validateEvidenceDependenciesInClient).not.toHaveBeenCalled();
      expect(result.messages[0].content).toBe('answer');
      expect(result.messages[0]).not.toHaveProperty('dependencyManifest');
    } finally {
      if (original === undefined) delete process.env.CORE_AUTH_ENFORCE; else process.env.CORE_AUTH_ENFORCE = original;
    }
  });
});
