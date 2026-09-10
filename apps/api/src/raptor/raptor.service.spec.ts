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
    await expect(service.search(['kb-1'], '总结全文')).resolves.toEqual([]);
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
});
