import { buildCanonicalBlock, canonicalBlockFromMetadata } from './canonical-block';

describe('CanonicalBlock v1', () => {
  it('normalizes document, layout, table and neighbour provenance', () => {
    const block = buildCanonicalBlock({
      document: { id: 'd1', kbId: 'k1', title: '费用表.xlsx', version: 3, sourceType: 'upload' },
      chunk: {
        ord: 2,
        content: '# 费用\n| 部门 | 金额 |\n| --- | --- |\n| 研发 | 100 |',
        tokenCount: 20,
        charStart: 100,
        charEnd: 180,
        metadata: {
          page_no: 4,
          section: '费用',
          breadcrumb: '财务 > 费用',
          heading_hierarchy: ['财务', '费用'],
          has_table: true,
          table_headers: ['部门', '金额'],
          table_rows_count: 1,
          bboxes: [{ x: 1, y: 2, w: 3, h: 4, page: 4 }],
          prev_chunk_ord: 1,
          next_chunk_ord: 3,
        },
      },
    });
    expect(block.schema).toBe('canonical-block/v1');
    expect(block.id).toBe('d1:v3:2');
    expect(block.structure.kind).toBe('mixed');
    expect(block.structure.tableHeaders).toEqual(['部门', '金额']);
    expect(block.position.page).toBe(4);
    expect(block.content.sha256).toHaveLength(64);
    expect(canonicalBlockFromMetadata({ canonical_block: block })).toEqual(block);
  });

  it('classifies plain prose as text', () => {
    const block = buildCanonicalBlock({
      document: { id: 'd', kbId: 'k', title: 'doc', version: 1, sourceType: 'upload' },
      chunk: { ord: 0, content: 'plain prose', tokenCount: 2, charStart: 0, charEnd: 11 },
    });
    expect(block.structure.kind).toBe('text');
  });
});
