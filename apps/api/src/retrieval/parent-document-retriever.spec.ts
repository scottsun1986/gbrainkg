import {
  buildParentBundle,
  dedupeOverlap,
  expandSiblings,
  groupByParent,
  ChildHit,
} from './parent-document-retriever';

const hit = (id: string, ord: number, parentChunkId: string | null, content: string): ChildHit => ({
  id,
  documentId: 'doc-1',
  kbId: 'kb-1',
  ord,
  content,
  parentChunkId,
});

describe('parent-document-retriever', () => {
  it('groups children under parent ids', () => {
    const groups = groupByParent([
      hit('c1', 0, 'p1', 'aaa'),
      hit('c2', 1, 'p1', 'bbb'),
      hit('c3', 2, null, 'ccc'),
    ]);
    expect(groups.get('p1')?.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(groups.has('__child__:c3')).toBe(true);
  });

  it('builds parent bundle preferring full parent text', () => {
    const children = [
      hit('c1', 0, 'p1', 'world peace talks'),
      hit('c2', 1, 'p1', 'continue tomorrow'),
    ];
    const parents = new Map([
      ['p1', 'hello world peace talks continue tomorrow and more context'],
    ]);
    const bundle = buildParentBundle('p1', children, parents);
    expect(bundle.parentId).toBe('p1');
    expect(bundle.childIds).toEqual(['c1', 'c2']);
    expect(bundle.mergedContent).toContain('more context');
  });

  it('dedupes overlapping parent/child tails', () => {
    const merged = dedupeOverlap('hello world peace talks', 'world peace talks continue');
    expect(merged).toBe('hello world peace talks continue');
  });

  it('expands sibling window via fetcher', async () => {
    const store: ChildHit[] = [
      hit('c0', 0, null, 'a'),
      hit('c1', 1, null, 'b'),
      hit('c2', 2, null, 'c'),
      hit('c3', 3, null, 'd'),
    ];
    const fetchRange = async (_doc: string, from: number, to: number) =>
      store.filter((h) => h.ord >= from && h.ord <= to);
    const expanded = await expandSiblings([hit('c1', 1, null, 'b')], fetchRange, 1);
    const ords = expanded.map((h) => h.ord).sort((a, b) => a - b);
    expect(ords).toEqual([0, 1, 2]);
  });
});
