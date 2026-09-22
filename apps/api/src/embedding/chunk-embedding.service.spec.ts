import { ChunkEmbeddingService } from './chunk-embedding.service';

const mockPrisma: any = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};
mockPrisma.$transaction.mockImplementation(async (callback: (client: any) => Promise<unknown>) =>
  callback(mockPrisma),
);
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

/** Deterministic UUIDs so formatVectorValues accepts the fixture ids. */
function chunkUuid(i: number): string {
  const hex = i.toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

describe('ChunkEmbeddingService.embedDocumentChunks', () => {
  const embedMock = {
    embed: jest.fn(),
    embedHybrid: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
    isHybridEnabled: jest.fn().mockReturnValue(false),
  };
  let service: ChunkEmbeddingService;

  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: chunkUuid(i),
    ord: i,
    content: `content ${i}`,
  }));

  const batchCalls = () =>
    mockPrisma.$queryRaw.mock.calls.filter((call: any[]) => String(call[0]).includes('ord >'));
  const coverageCalls = () =>
    mockPrisma.$queryRaw.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('FILTER (WHERE embedding IS NULL)'),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    embedMock.isHybridEnabled.mockReturnValue(false);
    service = new ChunkEmbeddingService(embedMock as any);
  });

  it('cursor-paginates past a single batch until the document is exhausted', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = String(strings);
      if (sql.includes('ord >')) {
        const cursor = Number(values[1]);
        return rows.filter((r) => r.ord > cursor).slice(0, 64);
      }
      if (sql.includes('FILTER (WHERE embedding IS NULL)')) {
        return [{ total: BigInt(200), missing: BigInt(0) }];
      }
      return [];
    });
    embedMock.embed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);

    const result = await service.embedDocumentChunks('33333333-3333-4333-8333-333333333333');

    // 200 rows at 64 per batch = 4 page reads, plus one coverage query.
    expect(batchCalls()).toHaveLength(4);
    expect(coverageCalls()).toHaveLength(1);
    // The cursor advanced past the last ord of the previous page.
    const cursors = batchCalls().map((call: any[]) => Number(call[2]));
    expect(cursors).toEqual([-1, 63, 127, 191]);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);
    // formatVectorValues output is UUID-typed and free of raw interpolation.
    const sql = String(mockPrisma.$executeRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('::uuid');
    expect(sql).toContain('::vector');
    expect(sql).not.toContain('chunk-');
    expect(result).toEqual({ requested: 200, embedded: 200, failed: 0, missing: 0 });
  });

  it('retries a failed vector once within the batch, then records it as failed', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = String(strings);
      if (sql.includes('ord >')) return rows.slice(0, 3);
      if (sql.includes('FILTER (WHERE embedding IS NULL)')) {
        return [{ total: BigInt(3), missing: BigInt(1) }];
      }
      return [];
    });
    embedMock.embed.mockImplementation(async (texts: string[]) =>
      texts.map((text) => (text === 'content 1' ? null : [0.1, 0.2])),
    );
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);

    const result = await service.embedDocumentChunks('33333333-3333-4333-8333-333333333333');

    expect(embedMock.embed).toHaveBeenCalledTimes(2); // first pass + one retry
    expect(result.requested).toBe(3);
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.missing).toBe(1);
  });

  it('reports chunks that remain unembedded after the loop as missing', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = String(strings);
      if (sql.includes('ord >')) return rows.slice(0, 2);
      if (sql.includes('FILTER (WHERE embedding IS NULL)')) {
        return [{ total: BigInt(7), missing: BigInt(5) }];
      }
      return [];
    });
    embedMock.embed.mockResolvedValue([null, null]);

    const result = await service.embedDocumentChunks('33333333-3333-4333-8333-333333333333');

    expect(result).toEqual({ requested: 2, embedded: 0, failed: 2, missing: 5 });
  });

  it('returns zeroes for a document without pending chunks', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = String(strings);
      if (sql.includes('ord >')) return [];
      if (sql.includes('FILTER (WHERE embedding IS NULL)')) {
        return [{ total: BigInt(0), missing: BigInt(0) }];
      }
      return [];
    });

    const result = await service.embedDocumentChunks('33333333-3333-4333-8333-333333333333');

    expect(batchCalls()).toHaveLength(1);
    expect(result).toEqual({ requested: 0, embedded: 0, failed: 0, missing: 0 });
  });

  it('documentCoverage counts required chunks still missing vectors', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ total: BigInt(10), missing: BigInt(3) }]);

    await expect(service.documentCoverage('33333333-3333-4333-8333-333333333333')).resolves.toEqual({
      total: 10,
      missing: 3,
    });
  });

  it('uses $executeRawUnsafe for high-performance batch vector updates when available', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = String(strings);
      if (sql.includes('ord >')) return rows.slice(0, 5);
      if (sql.includes('FILTER (WHERE embedding IS NULL)')) {
        return [{ total: BigInt(5), missing: BigInt(0) }];
      }
      return [];
    });
    embedMock.embed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
    mockPrisma.$executeRawUnsafe.mockResolvedValue(5);

    const result = await service.embedDocumentChunks('33333333-3333-4333-8333-333333333333');

    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "Chunk" AS c'),
    );
    // Injected payloads are rejected by formatVectorValues before they reach SQL.
    const sql = String(mockPrisma.$executeRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain(`('${chunkUuid(0)}'::uuid`);
    expect(result).toEqual({ requested: 5, embedded: 5, failed: 0, missing: 0 });
  });

  it('rejects a batch whose chunk ids are not UUIDs instead of interpolating them', async () => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = String(strings);
      if (sql.includes('ord >')) {
        return [{ id: "x') ; DROP TABLE \"Chunk\"; --", ord: 0, content: 'content 0' }];
      }
      if (sql.includes('FILTER (WHERE embedding IS NULL)')) {
        return [{ total: BigInt(1), missing: BigInt(0) }];
      }
      return [];
    });
    embedMock.embed.mockResolvedValue([[0.1, 0.2]]);
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    mockPrisma.$executeRaw.mockResolvedValue(1);

    const result = await service.embedDocumentChunks('33333333-3333-4333-8333-333333333333');

    // formatVectorValues throws on the non-uuid id, so the unsafe batch path is
    // never taken — no interpolated payload can reach SQL.
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    // Per-row fallback keeps the id as a bound parameter (not string-built).
    expect(result.requested).toBe(1);
  });

  it('stores sparse and multi-vector representations with provider-native late chunking', async () => {
    embedMock.isHybridEnabled.mockReturnValue(true);
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { id: '11111111-1111-4111-8111-111111111111', ord: 0, content: 'hybrid content' },
    ]);
    embedMock.embedHybrid.mockResolvedValueOnce([{
      dense: [0.1, 0.2],
      sparse: { indices: [7, 9], values: [0.8, 0.3] },
      multiVector: [[1, 0], [0, 1]],
    }]);
    mockPrisma.$executeRaw.mockResolvedValue(1);

    await expect(service.indexHybridDocument('22222222-2222-4222-8222-222222222222'))
      .resolves.toEqual({ requested: 1, indexed: 1 });
    expect(embedMock.embedHybrid).toHaveBeenCalledWith(
      ['hybrid content'],
      'document',
      { lateChunking: true },
    );
    // withServiceContext wraps the multi-statement write in one transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});
