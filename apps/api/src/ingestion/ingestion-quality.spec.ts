import { IngestionService } from './ingestion.service';

const mockPrisma = {
  document: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  chunk: { deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
};
// Interactive-transaction client delegating to the shared mocks so specs keep
// asserting against mockPrisma.
const tx = {
  document: {
    findUnique: (...args: unknown[]) => mockPrisma.document.findUnique(...(args as [])),
    update: (...args: unknown[]) => mockPrisma.document.update(...(args as [])),
  },
  chunk: {
    deleteMany: (...args: unknown[]) => mockPrisma.chunk.deleteMany(...(args as [])),
    createMany: (...args: unknown[]) => mockPrisma.chunk.createMany(...(args as [])),
  },
};
mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
  if (typeof arg === 'function') return (arg as (client: typeof tx) => unknown)(tx);
  return Promise.all(arg as unknown[]);
});
const mockReadFile = jest.fn();
const mockToMarkdown = jest.fn();
const mockWriteFile = jest.fn();
const mockRename = jest.fn();
const mockUnlink = jest.fn();
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));
jest.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));
jest.mock('@firecrawl/anydoc', () => ({ toMarkdown: (...args: unknown[]) => mockToMarkdown(...args) }));

describe('ingestion publication boundary', () => {
  const compiler = { onKnowledgePublished: jest.fn().mockResolvedValue(1) };
  const models = { getOcrConfig: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.document.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  it('does not re-run AnyDoc after a persistent content-hash cache hit', async () => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'duplicate.pdf', status: 'uploaded',
      rawFileOid: '/duplicate.pdf', version: 1,
    });
    mockPrisma.document.findFirst.mockResolvedValue({
      mdPath: 'cached/content.md',
      parserEngine: 'anydoc',
      parserClassification: 'pdf',
      parserMetadata: { contentHash: 'cached' },
    });
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('same binary payload'))
      .mockResolvedValueOnce('正常的缓存文档内容。'.repeat(30));
    const service = new IngestionService({} as any, compiler as any, models as any);

    await expect(service.processDocument('doc-1', 1)).resolves.toMatchObject({
      status: 'indexing',
      parser: 'anydoc-dedup',
    });
    expect(mockToMarkdown).not.toHaveBeenCalled();
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it.each(['encrypted', 'resourceLimit'])('does not bypass AnyDoc %s safety rejection', async code => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'fixture.pdf', status: 'uploaded', rawFileOid: '/fixture.pdf',
    });
    mockReadFile.mockResolvedValue(Buffer.from('fixture'));
    mockToMarkdown.mockRejectedValue(Object.assign(new Error('sensitive detail'), { code }));
    const service = new IngestionService({} as any, compiler as any, models as any);
    await expect(service.processDocument('doc-1')).rejects.toThrow(/^ANYDOC_/);
    expect(models.getOcrConfig).not.toHaveBeenCalled();
    expect(compiler.onKnowledgePublished).not.toHaveBeenCalled();
  });

  it.each(['txt', 'pdf'])('holds corrupt %s fast-path output without compilation', async extension => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: `fixture.${extension}`, status: 'uploaded', rawFileOid: `/fixture.${extension}`,
    });
    const corrupt = '合同条款'.repeat(20) + '\ufffd'.repeat(30);
    mockReadFile.mockResolvedValue(Buffer.from(corrupt));
    mockToMarkdown.mockResolvedValue(corrupt);
    const service = new IngestionService({} as any, compiler as any, models as any);
    const result = await service.processDocument('doc-1');
    expect(result.status).toBe('needs_review');
    expect(compiler.onKnowledgePublished).not.toHaveBeenCalled();
    expect(mockPrisma.document.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'needs_review', qualityStatus: 'needs_review',
        parserMetadata: expect.objectContaining({ quality_rule_version: 'content-v2' }),
      }),
    }));
  });

  it('continues to compile valid plaintext', async () => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'fixture.txt', status: 'uploaded', rawFileOid: '/fixture.txt',
    });
    mockReadFile.mockResolvedValue(Buffer.from('正常的合同条款内容'));
    const service = new IngestionService({} as any, compiler as any, models as any);
    expect((await service.processDocument('doc-1')).status).toBe('indexing');
    expect(compiler.onKnowledgePublished).toHaveBeenCalledWith('kb-1', 'doc-1', ['fixture']);
  });

  it('does not publish canonical Markdown when a newer version wins the save fence', async () => {
    mockPrisma.document.findUnique
      .mockResolvedValueOnce({
        id: 'doc-1', kbId: 'kb-1', title: 'fixture.txt', status: 'uploaded',
        rawFileOid: '/fixture.txt', version: 3,
      })
      .mockResolvedValueOnce({ version: 4 });
    mockReadFile.mockResolvedValue(Buffer.from('正常的合同条款内容'));
    const service = new IngestionService({} as any, compiler as any, models as any);

    await expect(service.processDocument('doc-1', 3)).resolves.toMatchObject({
      skipped: true,
      reason: 'superseded-version',
    });
    expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining('.tmp'), expect.any(String), 'utf8');
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('.tmp'));
  });

  it('version-fences terminal failure updates', async () => {
    const service = new IngestionService({} as any, compiler as any, models as any);
    await service.markFailed('doc-1', 'bad parse', 9);
    expect(mockPrisma.document.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'doc-1', version: 9 },
    }));
  });
});
