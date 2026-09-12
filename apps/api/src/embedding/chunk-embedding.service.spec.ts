import { ChunkEmbeddingService } from './chunk-embedding.service';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('ChunkEmbeddingService.embedDocumentChunks', () => {
  const embedMock = { embed: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  let service: ChunkEmbeddingService;

  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: `chunk-${i}`,
    ord: i,
    content: `content ${i}`,
  }));

  const batchCalls = () =>
    mockPrisma.$queryRaw.mock.calls.filter(([strings]) => String(strings).includes('ord >'));
  const coverageCalls = () =>
    mockPrisma.$queryRaw.mock.calls.filter(([strings]) => String(strings).includes('FILTER (WHERE embedding IS NULL)'));

  beforeEach(() => {
    jest.clearAllMocks();
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

    const result = await service.embedDocumentChunks('doc-1');

    // 200 rows at 64 per batch = 4 page reads, plus one coverage query.
    expect(batchCalls()).toHaveLength(4);
    expect(coverageCalls()).toHaveLength(1);
    // The cursor advanced past the last ord of the previous page.
    const cursors = batchCalls().map((call) => Number(call[2]));
    expect(cursors).toEqual([-1, 63, 127, 191]);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(200);
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

    const result = await service.embedDocumentChunks('doc-1');

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

    const result = await service.embedDocumentChunks('doc-1');

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

    const result = await service.embedDocumentChunks('doc-1');

    expect(batchCalls()).toHaveLength(1);
    expect(result).toEqual({ requested: 0, embedded: 0, failed: 0, missing: 0 });
  });

  it('documentCoverage counts required chunks still missing vectors', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ total: BigInt(10), missing: BigInt(3) }]);

    await expect(service.documentCoverage('doc-1')).resolves.toEqual({ total: 10, missing: 3 });
  });
});
