import { RaptorService } from './raptor.service';

describe('RaptorService', () => {
  let service: RaptorService;

  beforeEach(() => {
    delete process.env.RAPTOR_ENABLED;
    service = new RaptorService();
  });

  it('groups chunks by chapter when chapter numbers are present', () => {
    const groups = (service as any).groupChunks([
      { id: 'c1', ord: 0, content: '第一章内容A', metadata: { chapter_no: 1 } },
      { id: 'c2', ord: 1, content: '第一章内容B', metadata: { chapter_no: 1 } },
      { id: 'c3', ord: 2, content: '第二章内容', metadata: { chapter_no: 2 } },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].clusterKey).toBe('chapter-1');
    expect(groups[0].chunkIds).toEqual(['c1', 'c2']);
    expect(groups[1].clusterKey).toBe('chapter-2');
  });

  it('groups by section heading when no chapter number exists, and falls back to body', () => {
    const groups = (service as any).groupChunks([
      { id: 'c1', ord: 0, content: 'A', metadata: { section: '## 总则' } },
      { id: 'c2', ord: 1, content: 'B', metadata: {} },
    ]);
    const keys = groups.map((g: any) => g.clusterKey);
    expect(keys.some((k: string) => k.startsWith('section-'))).toBe(true);
    expect(keys).toContain('body');
  });

  it('produces an extractive summary bounded to the source text', () => {
    const text = '第一条 规定内容。第二条 补充规定内容。第三条 结束条款内容。';
    const summary = (service as any).extractiveSummary(text);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(800);
    expect(text).toContain(summary.slice(0, 5));
  });

  it('returns no search hits when disabled', async () => {
    process.env.RAPTOR_ENABLED = 'false';
    await expect(service.search(['kb-1'], '总结全文')).resolves.toEqual([]);
    delete process.env.RAPTOR_ENABLED;
  });

  it('scores and maps summary nodes into citation-like hits when enabled', async () => {
    process.env.RAPTOR_ENABLED = 'true';
    const findMany = jest.fn().mockResolvedValue([
      { id: 'n1', kbId: 'kb-1', documentId: 'doc-1', level: 1, title: '员工手册 · 全文摘要', content: '本手册规定考勤与休假制度。' },
      { id: 'n2', kbId: 'kb-1', documentId: 'doc-2', level: 0, title: '第一章', content: '无关内容。' },
    ]);
    (service as any).prisma = { raptorNode: { findMany } };
    const hits = await service.search(['kb-1'], '员工手册 考勤 休假 制度', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ documentId: 'doc-1', kbId: 'kb-1', raptor: true, level: 1 });
    expect(hits[0].evidence).toContain('宏观摘要');
    delete process.env.RAPTOR_ENABLED;
  });

  it('clusters chunks using K-Means++ and soft assignment when embedding service is present', async () => {
    const mockEmbeddingService = {
      isEnabled: () => true,
      embed: jest.fn().mockResolvedValue([
        [1.0, 0.0, 0.0, 0.0],
        [0.95, 0.05, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.95, 0.05, 0.0],
      ]),
    } as any;
    const raptor = new RaptorService(undefined, mockEmbeddingService);
    const clusters = await raptor.clusterChunks([
      { id: 'c1', ord: 0, content: '人事请假条款A', metadata: {} },
      { id: 'c2', ord: 1, content: '人事请假条款B', metadata: {} },
      { id: 'c3', ord: 2, content: '财务报销条款A', metadata: {} },
      { id: 'c4', ord: 3, content: '财务报销条款B', metadata: {} },
    ]);

    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(mockEmbeddingService.embed).toHaveBeenCalled();
    const c1ChunkIds = clusters.flatMap((c) => c.chunkIds);
    expect(c1ChunkIds).toContain('c1');
    expect(c1ChunkIds).toContain('c3');
  });

  it('builds Level 2 Knowledge Base Global Tree from Level 1 document summaries', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'l1-1', kbId: 'kb-100', documentId: 'doc-1', title: '人事制度', content: '规定请假与考勤' },
      { id: 'l1-2', kbId: 'kb-100', documentId: 'doc-2', title: '财务制度', content: '规定报销与差旅' },
    ]);
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const create = jest.fn().mockResolvedValue({ id: 'l2-1' });
    (service as any).prisma = {
      raptorNode: { findMany, deleteMany, create },
      $transaction: jest.fn().mockImplementation((actions) => Promise.all(actions)),
    };

    const res = await service.buildKbGlobalTree('kb-100');
    expect(res.nodes).toBe(1);
    expect(findMany).toHaveBeenCalledWith({ where: { kbId: 'kb-100', level: 1 }, select: expect.any(Object) });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kbId: 'kb-100',
        documentId: null,
        level: 2,
        title: expect.stringContaining('全景'),
      }),
    });
  });

  it('searchGlobal prioritizes Level 2 KB global nodes over Level 1 document nodes', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'n-doc', kbId: 'kb-1', documentId: 'doc-1', level: 1, title: '请假制度全文', content: '员工手册全文概述' },
      { id: 'n-global', kbId: 'kb-1', documentId: null, level: 2, title: '全库业务架构与制度演进全景', content: '全库涵盖人事与财务全景' },
    ]);
    (service as any).prisma = { raptorNode: { findMany } };

    const hits = await service.searchGlobal(['kb-1'], '全库有哪些制度体系演进历程', 2);
    expect(hits.length).toBe(2);
    expect(hits[0].level).toBe(2);
    expect(hits[0].evidence).toContain('全库演进全景');
    expect(hits[1].level).toBe(1);
  });
});
