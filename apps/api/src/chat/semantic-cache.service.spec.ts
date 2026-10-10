import { SemanticCacheService } from './semantic-cache.service';
import { Prisma } from '@prisma/client';
import { serializeJsonQuery } from '@prisma/client/runtime/library';
import { ChatTraceRecorder } from './chat-trace';

const prisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
  semanticCache: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => prisma }));

describe('SemanticCacheService exact cache', () => {
  let service: SemanticCacheService;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    service = new SemanticCacheService({} as any);
    prisma.$queryRaw.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  it('does not collapse symbols, case or internal whitespace into an exact hit', async () => {
    await service.store('C++', 'scope', 1, 'C++ answer', [], null);
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
    // one exact probe per lookup; no vector probe follows an exact miss
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('keeps Decimal database hits and their L1 replays safe for assistant-message JSON persistence', async () => {
    const serializeTrace = (processingTrace: ReturnType<ChatTraceRecorder['snapshot']>) => serializeJsonQuery({
      modelName: 'Message', action: 'create',
      args: { data: { conversationId: 'conversation', role: 'assistant', content: 'Cached answer', processingTrace: processingTrace as any } },
      runtimeDataModel: { models: { Message: { fields: [] } }, enums: {}, types: {} } as any,
      clientMethod: 'message.create', clientVersion: Prisma.prismaVersion.client,
      errorFormat: 'minimal', previewFeatures: [],
    });
    const rawSimilarity = new Prisma.Decimal('1.0');
    const baseline = new ChatTraceRecorder({ closed: false, next: jest.fn() } as any);
    baseline.finish('semantic_cache', 'success', 'Cached answer', { similarity: rawSimilarity });
    // Reproduce the production failure first: trace sanitization flattens
    // Decimal into an object containing its enumerable constructor function.
    expect(() => serializeTrace(baseline.snapshot())).toThrow(/constructor/);
    prisma.$queryRaw.mockResolvedValueOnce([{
      id: 'database-hit', responseContent: 'Cached answer', similarity: rawSimilarity,
    }]);
    const databaseHit = await service.lookup('Question', 'scope', 1);
    const memoryHit = await service.lookup('Question', 'scope', 1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(String(prisma.$queryRaw.mock.calls[0][0])).toContain('1.0::double precision AS similarity');
    for (const hit of [databaseHit, memoryHit]) {
      expect(hit.similarity).toBe(1);
      const recorder = new ChatTraceRecorder({ closed: false, next: jest.fn() } as any);
      recorder.finish('semantic_cache', 'success', 'Cached answer', { similarity: hit.similarity });
      const processingTrace = recorder.snapshot();
      expect(processingTrace[0].details?.similarity).toBe(1);
      // Exercise Prisma's actual input serializer, without a database write.
      // JSON.stringify alone hides functions and would miss the reported bug.
      expect(() => serializeTrace(processingTrace)).not.toThrow();
    }
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
    const service = new SemanticCacheService({} as any);
    await service.store('q', 'scope', 1, 'answer', [], null);
    expect(await service.lookup('q', 'scope', 1)).toMatchObject({ responseContent: 'answer' });
  });
});

describe('SemanticCacheService exact-only contract (answer reuse)', () => {
  let service: SemanticCacheService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new SemanticCacheService({} as any);
  });

  it('never probes vector similarity on an exact-text miss', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const hit = await service.lookup('a reworded question', 'scope', 1);
    expect(hit).toBeNull();
    // Exactly one SQL statement (the exact-text probe) and it never touches
    // the queryEmbedding column: the previous near-neighbour fallback could
    // reuse a different question's answer.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = String(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).not.toContain('"queryEmbedding" <=>');
    expect(sql).not.toContain('"queryEmbedding" IS NOT NULL');
  });

  it('stores rows without a query embedding so historical rows can never be vector-matched', async () => {
    await service.store('q', 'scope', 1, 'answer', [], null);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const values = prisma.$executeRaw.mock.calls[0];
    // The embedding parameter is bound as NULL (last positional argument of the
    // literal template includes the vector cast; the value itself must be null).
    expect(values.some((value: unknown) => value === null)).toBe(true);
  });
});
