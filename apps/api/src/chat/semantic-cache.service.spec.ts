import { SemanticCacheService } from './semantic-cache.service';

const prisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
  semanticCache: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => prisma }));

describe('SemanticCacheService exact cache', () => {
  const embeddings = { isEnabled: () => true, embedOne: jest.fn().mockResolvedValue([1, 0]) };
  let service: SemanticCacheService;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    service = new SemanticCacheService({} as any, embeddings as any);
    prisma.$queryRaw.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  it('does not collapse symbols, case or internal whitespace into an exact hit', async () => {
    await service.store('C++', [1, 0], 'scope', 1, 'C++ answer', [], null);
    expect(await service.lookup('C', 'scope', 1)).toBeNull();
    expect(await service.lookup('C++', 'scope', 1)).toMatchObject({ responseContent: 'C++ answer' });
    expect(SemanticCacheService.normalizeQuery('US')).not.toBe(SemanticCacheService.normalizeQuery('us'));
    expect(SemanticCacheService.normalizeQuery('a  b')).not.toBe(SemanticCacheService.normalizeQuery('a b'));
  });

  it('does not extend a database entry expiry when promoting it to memory', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'hit', responseContent: 'answer', expiresAt: new Date(Date.now() + 100) }]);
    expect(await service.lookup('q', 'scope', 1)).not.toBeNull();
    jest.advanceTimersByTime(101);
    expect(await service.lookup('q', 'scope', 1)).toBeNull();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('bounds entries promoted from database hits', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'hit', responseContent: 'answer' }]);
    for (let index = 0; index < 2001; index++) await service.lookup(`q${index}`, 'scope', 1);
    prisma.$queryRaw.mockResolvedValue([]);
    expect(await service.lookup('q0', 'scope', 1)).toBeNull();
    expect(await service.lookup('q2000', 'scope', 1)).not.toBeNull();
  });
});

describe('exact cache storage cost', () => {
  it('stores an exact entry without asking a model for an unused vector', async () => {
    const embeddings = { isEnabled: () => true,embedOne:jest.fn() };
    const service = new SemanticCacheService({} as any,embeddings as any);
    await service.store('q',null,'scope',1,'answer',[],null);
    expect(embeddings.embedOne).not.toHaveBeenCalled();
    expect(await service.lookup('q','scope',1)).toMatchObject({ responseContent:'answer' });
  });
});
