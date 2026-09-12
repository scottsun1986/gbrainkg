import { IngestionService } from './ingestion.service';

const mockPrisma = {
  document: { findUnique: jest.fn(), update: jest.fn() },
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
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));
jest.mock('node:fs/promises', () => ({ readFile: (...args: unknown[]) => mockReadFile(...args), writeFile: jest.fn() }));
jest.mock('@firecrawl/anydoc', () => ({ toMarkdown: (...args: unknown[]) => mockToMarkdown(...args) }));

describe('ingestion publication boundary', () => {
  const compiler = { onKnowledgePublished: jest.fn().mockResolvedValue(1) };
  const models = { getOcrConfig: jest.fn() };
  beforeEach(() => { jest.clearAllMocks(); });

  it.each(['encrypted', 'resourceLimit'])('does not bypass AnyDoc %s safety rejection', async code => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'fixture.pdf', status: 'uploaded', rawFileOid: '/fixture',
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
      id: 'doc-1', kbId: 'kb-1', title: `fixture.${extension}`, status: 'uploaded', rawFileOid: '/fixture',
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
      id: 'doc-1', kbId: 'kb-1', title: 'fixture.txt', status: 'uploaded', rawFileOid: '/fixture',
    });
    mockReadFile.mockResolvedValue(Buffer.from('正常的合同条款内容'));
    const service = new IngestionService({} as any, compiler as any, models as any);
    expect((await service.processDocument('doc-1')).status).toBe('indexing');
    expect(compiler.onKnowledgePublished).toHaveBeenCalledWith('kb-1', 'doc-1', ['fixture']);
  });
});
