import { KnowledgeBaseController } from './knowledge-base.controller';

const mockPrisma: any = {
  knowledgeBase: {
    count: jest.fn(), findFirst: jest.fn(), create: jest.fn(),
  },
  document: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn() },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('personal knowledge base creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);
    mockPrisma.knowledgeBase.create.mockResolvedValue({ id: 'kb-new', _count: { documents: 0 } });
  });

  it('allows creating a personal knowledge base without a numeric count limit', async () => {
    const controller = new KnowledgeBaseController(
      {} as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any,
      { queueAccessReconciliation: jest.fn().mockResolvedValue(undefined) } as any,
    );
    await expect(controller.createPersonalKnowledgeBase({} as any, { name: 'extra KB' }))
      .resolves.toMatchObject({ knowledgeBase: { id: 'kb-new', documentCount: 0 } });
    expect(mockPrisma.knowledgeBase.count).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeBase.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'extra KB', ownerUserId: 'user-1' }),
    }));
  });
});

describe('document list pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.document.findMany.mockResolvedValue([]);
    mockPrisma.document.count.mockResolvedValue(300);
    mockPrisma.document.groupBy.mockResolvedValue([
      { status: 'published', _count: { _all: 300 } },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([]);
  });

  it('uses a unique tie-break and whole-KB status counts across pages', async () => {
    const controller = new KnowledgeBaseController(
      { getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1']) } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any,
      {} as any,
    );
    const page = await controller.listDocuments('kb-1', {}, undefined, undefined, undefined, '2', '100');
    expect(mockPrisma.document.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 100,
      take: 100,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    }));
    expect(page.statusCounts).toMatchObject({ total: 300, published: 300, processing: 0 });
  });
});
