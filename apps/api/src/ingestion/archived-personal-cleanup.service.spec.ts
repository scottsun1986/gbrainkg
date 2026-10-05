import { ArchivedPersonalCleanupService } from './archived-personal-cleanup.service';
import { access, lstat, realpath, rm } from 'node:fs/promises';
import { runWithRequestContext } from '../observability/request-context';
const actor = '00000000-0000-4000-8000-000000000001';
const kbId = '00000000-0000-4000-8000-000000000002';
const docId = '00000000-0000-4000-8000-000000000003';
const readyId = '00000000-0000-4000-8000-000000000004';
const date = new Date('2026-10-05T00:00:00Z');
const doc = { id: docId, kbId, status: 'indexing', indexReadiness: 'pending', version: 1, updatedAt: date,
  rawFileOid: null, pendingRawFileOid: null, objectKey: 'raw/test', storageProvider: 'local' };
const db: any = { knowledgeBase: { findUnique: jest.fn(), update: jest.fn() }, document: { findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  documentVersion: { findMany: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() }, brainChangeEvent: { deleteMany: jest.fn() },
  $queryRaw: jest.fn(), $executeRaw: jest.fn(), $transaction: jest.fn() };
jest.mock('../prisma', () => ({ getPrismaClient: () => db }));
jest.mock('node:fs/promises', () => ({ rm: jest.fn().mockResolvedValue(undefined), realpath: jest.fn(), access: jest.fn(), lstat: jest.fn() }));
const context = <T>(fn: () => T): T => runWithRequestContext({ requestId: 'cleanup-test', servicePrincipal: 'maintenance' }, fn);

describe('ArchivedPersonalCleanupService', () => {
  const environment = { uploadRoot: process.env.UPLOAD_ROOT, brainRepoBasePath: process.env.BRAIN_REPO_BASE_PATH };
  let service: ArchivedPersonalCleanupService;
  let permission: any, compiler: any, graph: any, raptor: any, lexical: any, storage: any, queue: any;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ARCHIVED_CLEANUP_ENABLE = '1';
    process.env.UPLOAD_ROOT = '/tmp/cleanup-uploads';
    process.env.BRAIN_REPO_BASE_PATH = '/tmp/cleanup-brains';
    (realpath as jest.Mock).mockImplementation(async (path: string) => path);
    permission = { isSystemAdmin: jest.fn().mockResolvedValue(true) };
    compiler = { onKnowledgeDeleted: jest.fn().mockResolvedValue([]), queueScopeSynthesis: jest.fn().mockResolvedValue(undefined) };
    graph = { removeDocumentFromGraph: jest.fn().mockResolvedValue({}) };
    raptor = { removeDocument: jest.fn().mockResolvedValue(undefined) };
    lexical = { removeDocument: jest.fn().mockResolvedValue({}) };
    storage = { delete: jest.fn().mockResolvedValue(undefined), exists: jest.fn().mockResolvedValue(false) };
    queue = { getJob: jest.fn().mockResolvedValue(null) };
    db.knowledgeBase.findUnique.mockResolvedValue({ id: kbId, name: 'test', type: 'personal', status: 'archived', ownerUserId: actor });
    db.document.findMany.mockResolvedValue([doc, { ...doc, id: readyId, status: 'published', indexReadiness: 'ready' }]);
    db.document.findUnique.mockResolvedValue(doc);
    db.document.count = jest.fn().mockResolvedValue(0);
    db.documentVersion.findMany = jest.fn().mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
    service = new ArchivedPersonalCleanupService(permission, compiler, graph, raptor, lexical, storage, queue, queue, queue, queue);
  });
  afterEach(() => {
    delete process.env.ARCHIVED_CLEANUP_ENABLE;
    for (const [key, value] of [['UPLOAD_ROOT', environment.uploadRoot], ['BRAIN_REPO_BASE_PATH', environment.brainRepoBasePath]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  const makePlan = () => context(() => service.plan(actor, kbId, 'test'));
  it('dry-run preserves published+ready and performs no cleanup', async () => {
    const plan = await makePlan();
    expect(plan.documents.map(d => d.id)).toEqual([docId]); expect(plan.retainedReady).toBe(1);
    expect(plan.documents[0].objectKey).toBe('raw/test');
    expect(db.document.delete).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
  });
  it.each(['status', 'type', 'ownerUserId', 'name'])('rejects wrong KB %s', async field => {
    db.knowledgeBase.findUnique.mockResolvedValue({ id: kbId, name: 'test', type: 'personal', status: 'archived', ownerUserId: actor, [field]: 'wrong' });
    await expect(makePlan()).rejects.toThrow('Exact archived');
  });
  it('rejects non-admin and HTTP caller before mutation', async () => {
    permission.isSystemAdmin.mockResolvedValue(false); await expect(makePlan()).rejects.toThrow('administrator');
    await expect(service.plan(actor, kbId, 'test')).rejects.toThrow('service principal');
  });
  it('uses strict lifecycle operations, no rebuild, outbox and transactional audit', async () => {
    const plan = await makePlan(); await context(() => service.executeBatch(actor, plan, 0, 1));
    expect(lexical.removeDocument).toHaveBeenCalledWith(kbId, docId, { strict: true });
    expect(graph.removeDocumentFromGraph).toHaveBeenCalledWith(kbId, docId, { strict: true });
    expect(raptor.removeDocument).toHaveBeenCalledWith(kbId, docId, { rebuild: false });
    expect(storage.delete).toHaveBeenCalledWith('raw/test', 'local', { strictProvider: true });
    expect(db.brainChangeEvent.deleteMany).toHaveBeenCalledWith({ where: { resourceType: 'document', resourceId: docId } });
    expect(db.auditLog.create).toHaveBeenCalled();
    expect(db.knowledgeBase.update).not.toHaveBeenCalled();
  });
  it.each(['published-ready', 'version', 'updatedAt', 'kbId'])('rejects changed document %s', async field => {
    const plan = await makePlan();
    db.document.findUnique.mockResolvedValue(field === 'published-ready' ? { ...doc, status: 'published', indexReadiness: 'ready' } :
      { ...doc, [field]: field === 'updatedAt' ? new Date(date.getTime() + 1) : field === 'version' ? 2 : readyId });
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('scope/state');
    expect(storage.delete).not.toHaveBeenCalled(); expect(db.document.delete).not.toHaveBeenCalled();
  });
  it('refuses live outbox and live queue jobs', async () => {
    const plan = await makePlan(); db.$queryRaw.mockResolvedValue([{ id: docId, status: 'processing' }]);
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('Live outbox');
    db.$queryRaw.mockResolvedValue([]); queue.getJob.mockResolvedValue({ getState: async () => 'active' });
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('Live queue');
    expect(db.document.delete).not.toHaveBeenCalled();
  });
  it('propagates storage failures, leaving document and outbox for retry', async () => {
    const plan = await makePlan(); storage.delete.mockRejectedValue(new Error('storage unavailable'));
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('storage unavailable');
    expect(db.document.delete).not.toHaveBeenCalled(); expect(db.brainChangeEvent.deleteMany).not.toHaveBeenCalled();
  });
  it('only treats audited missing documents as idempotent success', async () => {
    const plan = await makePlan(); db.document.findUnique.mockResolvedValue(null);
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('without successful cleanup audit');
    db.auditLog.findFirst.mockResolvedValue({ id: docId });
    expect(await context(() => service.executeBatch(actor, plan, 0, 1))).toEqual([{ id: docId, outcome: 'already-deleted' }]);
  });
  it('kill-switch, abort and oversized batches refuse mutation', async () => {
    const plan = await makePlan(); delete process.env.ARCHIVED_CLEANUP_ENABLE;
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('kill-switch');
    process.env.ARCHIVED_CLEANUP_ENABLE = '1';
    await expect(context(() => service.executeBatch(actor, plan, 0, 101))).rejects.toThrow('maximum 100');
    const abort = new AbortController(); abort.abort();
    await expect(context(() => service.executeBatch(actor, plan, 0, 1, abort.signal))).rejects.toThrow('stopped');
    expect(db.document.delete).not.toHaveBeenCalled();
  });
  it('never commits a document when object deletion did not remove the object', async () => {
    const plan = await makePlan(); storage.exists.mockResolvedValue(true);
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('Object remained');
    expect(db.document.delete).not.toHaveBeenCalled();
  });
  it('defers mapped-source synthesis once per batch, preserves dirty scopes', async () => {
    const plan = await makePlan(); compiler.onKnowledgeDeleted.mockResolvedValue(['scope-1', 'scope-1']);
    await context(() => service.executeBatch(actor, plan, 0, 1));
    expect(compiler.onKnowledgeDeleted).toHaveBeenCalledWith(kbId, docId, { requireMapping: true, deferSynthesis: true });
    expect(compiler.queueScopeSynthesis).toHaveBeenCalledWith(['scope-1']);
  });
  it('rejects raw paths outside the document namespace before any dependency mutation', async () => {
    db.document.findMany.mockResolvedValue([{ ...doc, rawFileOid: '/etc/passwd' }]);
    db.document.findUnique.mockResolvedValue({ ...doc, rawFileOid: '/etc/passwd' });
    const plan = await makePlan();
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('outside document namespace');
    expect(lexical.removeDocument).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
  });

  it('requires explicit absolute storage roots even when DATABASE_URL is already provided', async () => {
    const plan = await makePlan();
    delete process.env.UPLOAD_ROOT;
    await expect(makePlan()).rejects.toThrow('Explicit absolute');
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('Explicit absolute');
    process.env.UPLOAD_ROOT = 'uploads';
    await expect(makePlan()).rejects.toThrow('Explicit absolute');
    expect(lexical.removeDocument).not.toHaveBeenCalled(); expect(rm).not.toHaveBeenCalled();
  });

  it('preflights all batch raw paths before deleting the first document', async () => {
    db.document.findMany.mockResolvedValue([doc, { ...doc, id: readyId, rawFileOid: '/etc/passwd' }]);
    const plan = await makePlan();
    await expect(context(() => service.executeBatch(actor, plan, 0, 2))).rejects.toThrow('outside document namespace');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(lexical.removeDocument).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled(); expect(db.document.delete).not.toHaveBeenCalled();
  });

  it('accepts an explicit upload-root symlink but rejects a document-directory symlink', async () => {
    const raw = `/tmp/cleanup-uploads/${docId}/raw.txt`;
    db.document.findMany.mockResolvedValue([{ ...doc, rawFileOid: raw }]);
    db.document.findUnique.mockResolvedValue({ ...doc, rawFileOid: raw });
    const plan = await makePlan();
    (realpath as jest.Mock).mockImplementation(async (path: string) => path.replace('/tmp/cleanup-uploads', '/data/uploads'));
    await context(() => service.executeBatch(actor, plan, 0, 1));
    expect(rm).toHaveBeenCalledWith(raw, { force: true });
    jest.clearAllMocks();
    (realpath as jest.Mock).mockImplementation(async (path: string) => path === '/tmp/cleanup-uploads' ? '/data/uploads' : `/data/uploads/${readyId}`);
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('symlink escapes');
    expect(lexical.removeDocument).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('checks symlink ancestors even when the raw file was already removed', async () => {
    const raw = `/tmp/cleanup-uploads/${docId}/nested/missing.txt`;
    db.document.findMany.mockResolvedValue([{ ...doc, rawFileOid: raw }]);
    const plan = await makePlan();
    (realpath as jest.Mock).mockImplementation(async (path: string) => {
      if (path === raw) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return path.endsWith('/nested') ? '/etc' : path;
    });
    (lstat as jest.Mock).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('symlink escapes');
    expect(lexical.removeDocument).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('retries missing raw files safely and rejects dangling raw symlinks before mutations', async () => {
    const raw = `/tmp/cleanup-uploads/${docId}/raw.txt`;
    db.document.findMany.mockResolvedValue([{ ...doc, rawFileOid: raw }]);
    db.document.findUnique.mockResolvedValue({ ...doc, rawFileOid: raw });
    const plan = await makePlan();
    (realpath as jest.Mock).mockImplementation(async (path: string) => {
      if (path === raw) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return path;
    });
    (lstat as jest.Mock).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await context(() => service.executeBatch(actor, plan, 0, 1));
    expect(db.document.delete).toHaveBeenCalled();
    jest.clearAllMocks();
    (lstat as jest.Mock).mockResolvedValue({ isSymbolicLink: () => true });
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('dangling symlink');
    expect(lexical.removeDocument).not.toHaveBeenCalled(); expect(rm).not.toHaveBeenCalled();
  });

  it('verifies cascade/graph/storage absence and exact retained ready IDs', async () => {
    const plan = await makePlan();
    for (const model of ['document', 'chunk', 'documentVersion', 'documentAcl', 'brainSourceDocument', 'raptorNode', 'brainChangeEvent']) {
      db[model] = { ...db[model], count: jest.fn().mockResolvedValue(0) };
    }
    db.document.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    db.$queryRaw.mockResolvedValue([{ count: 0 }]);
    (access as jest.Mock).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await context(() => service.verifyBatch(actor, plan, 0, 1))).toEqual({ verifiedDeleted: 1, retainedReady: 1, kbStatus: 'archived' });
    db.chunk.count.mockResolvedValue(1);
    await expect(context(() => service.verifyBatch(actor, plan, 0, 1))).rejects.toThrow('remaining document dependencies');
  });

  it('rejects a verification plan whose retained set is missing or malformed', async () => {
    const plan = await makePlan();
    const { retainedReadyIds, ...withoutRetained } = plan;
    await expect(context(() => service.verifyBatch(actor, withoutRetained as any, 0, 1)))
      .rejects.toThrow('Invalid exact cleanup plan');
    await expect(context(() => service.verifyBatch(actor, { ...plan, retainedReadyIds: ['not-a-uuid'] } as any, 0, 1)))
      .rejects.toThrow('Invalid exact cleanup plan');
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses to verify an object through an unrecognised storage provider', async () => {
    const plan = await makePlan();
    for (const model of ['document', 'chunk', 'documentVersion', 'documentAcl', 'brainSourceDocument', 'raptorNode', 'brainChangeEvent']) {
      db[model] = { ...db[model], count: jest.fn().mockResolvedValue(0) };
    }
    db.document.count.mockResolvedValue(0);
    (access as jest.Mock).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const offProvider = { ...plan, documents: [{ ...doc, storageProvider: 's3' }] } as any;
    await expect(context(() => service.verifyBatch(actor, offProvider, 0, 1)))
      .rejects.toThrow('Unknown object storage provider');
    expect(storage.exists).not.toHaveBeenCalled();
  });

  it('refuses shared storage and considers previous version queue jobs', async () => {
    const plan = await makePlan(); db.document.count.mockResolvedValue(1);
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('Storage reference shared');
    db.document.count.mockResolvedValue(0); db.documentVersion.findMany.mockResolvedValue([{ number: 2 }]);
    queue.getJob.mockImplementation(async (id: string) => id === `ingest-${docId}-v2` ? { getState: async () => 'active' } : null);
    await expect(context(() => service.executeBatch(actor, plan, 0, 1))).rejects.toThrow('Live queue');
    expect(storage.delete).not.toHaveBeenCalled();
  });

});
