import { Logger } from '@nestjs/common';
import { RetrievalArmsService, detectStructuralQueryShape } from './retrieval-arms';

describe('generic structural recall and ranking', () => {
  it.each(['List all chapters', 'Enumerate all sections', 'List all headings', '请列出所有章'])('recognizes document structure syntax: %s', query => {
    expect(detectStructuralQueryShape(query).isChapterListing).toBe(true);
  });

  it.each(['## 第一章 主题', '## Chapter 1 Topic', '## API Reference'])('preserves measured channel order without a legal-heading bonus: %s', async heading => {
    const best = { id: 'best', documentId: 'a', kbId: 'kb', ord: 0, content: 'Complete source content', metadata: { heading_hierarchy: ['Source'] }, document: { title: 'Reference', version: 1 } };
    const weaker = { id: 'weaker', documentId: 'b', kbId: 'kb', ord: 0, content: heading, metadata: { heading_hierarchy: [heading] }, document: { title: 'Reference', version: 1 } };
    const findMany = jest.fn().mockResolvedValue([weaker, best]);
    const prisma: any = { chunk: { findMany }, document: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([]) };
    prisma.$transaction = (fn: any) => fn(prisma);
    const service = new RetrievalArmsService({
      logger: new Logger('structure-test'),
      prisma,
      lexicalIndexService: { isEnabled: () => true, search: jest.fn().mockResolvedValue([best, weaker]) } as any,
    });
    const result = await service.searchChunksFallback(['kb'], '请列出所有章', 2);
    expect(result.map(hit => hit.id)).toEqual(['best', 'weaker']);
    expect(result[0].score).toBeGreaterThan(result[1].score!);
    expect(result[1].evidence).toContain(heading);
    expect((result[1] as any).headingHierarchy).toEqual([heading]);
    expect(findMany.mock.calls.some(([args]) => args.where.OR?.some((predicate: any) => predicate.content?.startsWith === '#'))).toBe(true);
  });
});
