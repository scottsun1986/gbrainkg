import { VersionChainService } from './version-chain.service';

const db: any = {
  $executeRaw: jest.fn(), $transaction: jest.fn(async (fn: any) => fn(db)),
  document: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  documentAcl: { findMany: jest.fn().mockResolvedValue([]) },
  documentVersionLink: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => db }));
jest.mock('node:fs/promises', () => ({ mkdir: jest.fn().mockResolvedValue(undefined), copyFile: jest.fn().mockResolvedValue(undefined), rm: jest.fn().mockResolvedValue(undefined) }));

describe('independent document version ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.document.findUnique.mockResolvedValue({ id: 'old', kbId: 'kb', version: 2, status: 'published', lifecycleStatus: 'current', rawFileOid: '/old/source.pdf' });
    db.document.findFirst.mockResolvedValue(null);
    db.document.create.mockImplementation(async ({ data }: any) => data);
    db.document.update.mockResolvedValue({});
    db.document.updateMany.mockResolvedValue({ count: 1 });
    db.documentAcl.findMany.mockResolvedValue([]);
    db.documentVersionLink.findMany.mockResolvedValue([]);
  });
  it('locks before choosing version and durably queues a separate raw copy', async () => {
    const queue = { getJob: jest.fn(), add: jest.fn() };
    const service = new VersionChainService(queue as any);
    const result = await service.createVersion({ kbId: 'kb', documentId: 'old', title: 'title.pdf', mdPath: 'old/content.md', sourceType: 'upload' });
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(result.mdPath).toBe(`${result.id}/content.md`);
    expect(result.rawFileOid).not.toBe('/old/source.pdf');
    expect(queue.add).toHaveBeenCalledWith('parse-document', expect.objectContaining({ documentId: result.id, expectedVersion: 3 }), expect.objectContaining({ attempts: 3 }));
  });
  it('rejects a stale predecessor instead of creating another current version', async () => {
    db.document.findUnique.mockResolvedValue({ id: 'old', lifecycleStatus: 'superseded' });
    await expect(new VersionChainService({ add: jest.fn() } as any).createVersion({ kbId: 'kb', documentId: 'old', title: 'title', mdPath: 'old/content.md', sourceType: 'upload' })).rejects.toThrow(/already been superseded/);
    expect(db.document.create).not.toHaveBeenCalled();
  });

  describe('B02: the predecessor keeps serving until the successor publishes', () => {
    let chainLinks: any[];
    beforeEach(() => {
      chainLinks = [];
      db.documentVersionLink.findMany.mockImplementation(async ({ where }: any) =>
        chainLinks.filter(link => where.relation?.not === 'translation' ? link.relation !== 'translation' : true));
    });
    it('records the link as a pending intent without retiring the predecessor at creation', async () => {
      const service = new VersionChainService({ getJob: jest.fn(), add: jest.fn() } as any);
      await service.createVersion({ kbId: 'kb', documentId: 'old', title: 't', mdPath: 'old/content.md', sourceType: 'upload' });
      expect(db.documentVersionLink.create).toHaveBeenCalledWith({ data: expect.objectContaining({ fromDocumentId: 'old', relation: 'supersedes' }) });
      expect(db.document.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old' } }));
    });
    it('keeps the predecessor available when the parse enqueue fails and marks the candidate failed', async () => {
      const queue = { getJob: jest.fn(), add: jest.fn().mockRejectedValue(new Error('queue unavailable')) };
      const service = new VersionChainService(queue as any);
      await expect(service.createVersion({ kbId: 'kb', documentId: 'old', title: 't', mdPath: 'old/content.md', sourceType: 'upload' })).rejects.toThrow(/queue unavailable/);
      expect(db.document.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old' } }));
      expect(db.document.updateMany).toHaveBeenCalledWith({
        where: { id: expect.any(String), status: 'parsing' },
        data: { status: 'failed' },
      });
      // The in-flight guard no longer blocks the retry after the failed candidate.
      db.documentVersionLink.findMany.mockResolvedValue([{ toDocumentId: 'cand', toDocument: { status: 'failed' } }]);
      await expect(new VersionChainService({ getJob: jest.fn(), add: jest.fn() } as any)
        .createVersion({ kbId: 'kb', documentId: 'old', title: 't', mdPath: 'old/content.md', sourceType: 'upload' })).resolves.toBeTruthy();
    });
    it('rejects a second replacement while one successor is still building', async () => {
      db.documentVersionLink.findMany.mockResolvedValue([{ toDocumentId: 'cand', toDocument: { status: 'parsing' } }]);      await expect(new VersionChainService({ add: jest.fn() } as any).createVersion({ kbId: 'kb', documentId: 'old', title: 't', mdPath: 'old/content.md', sourceType: 'upload' }))
        .rejects.toThrow(/already being built/);
      expect(db.document.create).not.toHaveBeenCalled();
    });
    it('rejects superseding a predecessor that has not published (and is not failed)', async () => {
      db.document.findUnique.mockResolvedValue({ id: 'old', version: 2, status: 'parsing', lifecycleStatus: 'current', rawFileOid: '/old/source.pdf' });
      await expect(new VersionChainService({ add: jest.fn() } as any).createVersion({ kbId: 'kb', documentId: 'old', title: 't', mdPath: 'old/content.md', sourceType: 'upload' }))
        .rejects.toThrow(/cannot be superseded while its status is parsing/);
      expect(db.document.create).not.toHaveBeenCalled();
    });
    it('allows creating a replacement from a failed version (recovery path)', async () => {
      db.document.findUnique.mockResolvedValue({ id: 'failed-mid', version: 3, status: 'failed', lifecycleStatus: 'current', rawFileOid: '/old/source.pdf' });
      const service = new VersionChainService({ getJob: jest.fn(), add: jest.fn() } as any);
      await expect(service.createVersion({ kbId: 'kb', documentId: 'failed-mid', title: 't', mdPath: 'old/content.md', sourceType: 'upload' })).resolves.toMatchObject({ version: 4 });
      // The transitive retirement at publish (see version-chain-retirement) is
      // what retires both this failed link and the original behind it.
    });
    it('lets translation links coexist instead of blocking or replacing the original', async () => {
      // A translation still being built must not block a real supersedes version…
      chainLinks = [{ toDocumentId: 'trans', toDocument: { status: 'parsing' }, relation: 'translation' }];
      const service = new VersionChainService({ getJob: jest.fn(), add: jest.fn() } as any);
      await expect(service.createVersion({ kbId: 'kb', documentId: 'old', title: 't', mdPath: 'old/content.md', sourceType: 'upload' })).resolves.toBeTruthy();
      // …and creating a translation never retires the original at creation time.
      chainLinks = [];
      const result = await service.createVersion({ kbId: 'kb', documentId: 'old', title: 't-en', mdPath: 'old/content.md', sourceType: 'upload', relation: 'translation' });
      expect(db.documentVersionLink.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ relation: 'translation' }) });
      expect(db.document.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old' } }));
      expect(result.lifecycleStatus).toBe('current');
    });
  });
});
