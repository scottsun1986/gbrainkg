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
  });
});
