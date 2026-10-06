import { VersionChainService } from './version-chain.service';

const db: any = {
  $executeRaw: jest.fn(), $transaction: jest.fn(async (fn: any) => fn(db)),
  document: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  documentAcl: { findMany: jest.fn().mockResolvedValue([]) },
  documentVersionLink: { create: jest.fn() },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => db }));
jest.mock('node:fs/promises', () => ({ mkdir: jest.fn().mockResolvedValue(undefined), copyFile: jest.fn().mockResolvedValue(undefined), rm: jest.fn().mockResolvedValue(undefined) }));

describe('independent document version ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.document.findUnique.mockResolvedValue({ id: 'old', kbId: 'kb', version: 2, lifecycleStatus: 'current', rawFileOid: '/old/source.pdf' });
    db.document.create.mockImplementation(async ({ data }: any) => data);
    db.documentAcl.findMany.mockResolvedValue([]);
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
});
