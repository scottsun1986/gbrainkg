import { splitMarkdownIntoChunks } from './markdown-chunker';

describe('splitMarkdownIntoChunks', () => {
  it('keeps short sections searchable with section metadata', () => {
    const chunks = splitMarkdownIntoChunks('# 第一章\n\n这是内容。\n\n## 第二章\n\n这是第二段。');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].metadata.section).toBe('# 第一章');
    expect(chunks[1].metadata.section).toBe('## 第二章');
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[1].charStart).toBeGreaterThan(chunks[0].charStart);
  });

  it('splits long sections into bounded overlapping windows', () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `第${index + 1}段：${'企业研发管理规范内容。'.repeat(120)}`).join('\n\n');
    const chunks = splitMarkdownIntoChunks(`# 研发管理\n\n${paragraphs}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.content.length))).toBeLessThan(5400);
    expect(chunks.every((chunk) => chunk.metadata.section === '# 研发管理')).toBe(true);
    expect(chunks.every((chunk) => chunk.charEnd > chunk.charStart)).toBe(true);
  });

  it('promotes native policy clauses to stable child sections', () => {
    const chunks = splitMarkdownIntoChunks('第一章 总则\n\n第十条 旷工\n未请假擅自不到岗的，视为旷工。\n\n第十一条 处理\n连续旷工三日可以解除劳动合同。');
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.metadata.section)).toEqual([
      '第一章 总则',
      '第十条 旷工',
      '第十一条 处理',
    ]);
    expect(chunks[1].content).toContain('未请假擅自不到岗');
    
    // Clause structure should be detected and add metadata
    expect(chunks[0].metadata.chapter_no).toBe(1);
    expect(chunks[1].metadata.article_no).toBe(10);
    expect(chunks[2].metadata.article_no).toBe(11);
    expect(chunks[2].metadata.chapter_no).toBe(1); // inherited
  });

  it('detects page markers and assigns page_no', () => {
    const chunks = splitMarkdownIntoChunks('<!-- page 5 -->\n\n# 第一章 某文档\n\n这是第一段。\n\n--- page 6 ---\n\n## 第二章\n\n这是第二段。');
    
    expect(chunks).toHaveLength(3);
    expect(chunks[0].metadata.page_no).toBe(5);
    expect(chunks[1].metadata.page_no).toBe(5);
    expect(chunks[2].metadata.page_no).toBe(6);
  });

  it('detects markdown heading page markers and assigns page_no', () => {
    const chunks = splitMarkdownIntoChunks('## 第 3 页\n\n这是第三页的内容。\n\n## 第 4 页\n\n这是第四页的内容。');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].metadata.page_no).toBe(3);
    expect(chunks[1].metadata.page_no).toBe(4);
  });

  it('estimates token counts for Chinese text accurately', () => {
    // Chinese chars should count roughly as 1 token each, not 0.25
    const text = '这是一个中文句子的测试。';
    const chunks = splitMarkdownIntoChunks(text);
    expect(chunks[0].tokenCount).toBeGreaterThan(5);
  });

  it('links neighbor chunks with prev_chunk_ord and next_chunk_ord', () => {
    const markdown = '# 章节一\n\n段落一。\n\n## 章节二\n\n段落二。\n\n### 章节三\n\n段落三。';
    const chunks = splitMarkdownIntoChunks(markdown);
    expect(chunks.length).toBe(3);
    expect(chunks[0].metadata.prev_chunk_ord).toBeUndefined();
    expect(chunks[0].metadata.next_chunk_ord).toBe(1);
    expect(chunks[1].metadata.prev_chunk_ord).toBe(0);
    expect(chunks[1].metadata.next_chunk_ord).toBe(2);
    expect(chunks[2].metadata.prev_chunk_ord).toBe(1);
    expect(chunks[2].metadata.next_chunk_ord).toBeUndefined();
  });

  it('propagates table headers when long tables span across chunk boundaries', () => {
    const tableHeader = '| 岗位 | 差旅标准 | 住宿上限 |\n| --- | --- | --- |';
    const rows = Array.from({ length: 80 }, (_, i) => `| 职级${i + 1} | 一等座${i + 1} | ${500 + i * 10}元 |`).join('\n');
    const tableDoc = `# 差旅规范\n\n${tableHeader}\n${rows}`;
    const chunks = splitMarkdownIntoChunks(tableDoc);
    
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk of this table should have has_table = true
    expect(chunks.every((c) => c.metadata.has_table)).toBe(true);
    // Subsequent chunks should have the table header propagated so column semantics are preserved
    expect(chunks[1].content).toContain('| 岗位 | 差旅标准 | 住宿上限 |');
  });
});
