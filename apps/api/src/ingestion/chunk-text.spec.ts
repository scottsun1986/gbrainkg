import { indexableChunkText } from './chunk-text';
import { buildChunkTerms } from '../retrieval/lexical-index-store';

describe('indexableChunkText', () => {
  it('drops the chunker hierarchy echo and bbox bookkeeping', () => {
    const content = [
      '<!-- 大纲层级: 创业支持计划 > 二、重点工作 > （四）完善创业服务保障 -->',
      '# 二、重点工作',
      '（四）完善创业服务保障。',
      '<!-- bbox: 12,34,56,78 -->',
    ].join('\n');

    const indexable = indexableChunkText(content);

    expect(indexable).not.toContain('大纲层级');
    expect(indexable).not.toContain('bbox');
    expect(indexable).toContain('完善创业服务保障');
  });

  it('keeps table row semantics but removes the boilerplate table summary', () => {
    const content = [
      '| 部门 | Q1 |',
      '| --- | --- |',
      '| 研发 | 120 |',
      '<!-- 表格结构摘要: 共 1 行，列: 部门 / Q1；下表为行级语义 -->',
      '<!-- 表格结构化行语义:',
      '部门=研发; Q1=120',
      '-->',
    ].join('\n');

    const indexable = indexableChunkText(content);

    expect(indexable).not.toContain('表格结构摘要');
    // The row itself is content: it must remain matchable by BM25.
    expect(indexable).toContain('部门=研发; Q1=120');
  });

  it('keeps the Contextual Retrieval prefix (Anthropic indexing recipe)', () => {
    const content = '[上下文: 本段出自第三章关于值班安排的条款]\n\n值班时间为 08:00-18:00。';
    expect(indexableChunkText(content)).toContain('[上下文:');
    expect(indexableChunkText(content)).toContain('值班时间为 08:00-18:00。');
  });

  it('removes near-universal terms from the BM25 term space', () => {
    const withMeta = '<!-- 大纲层级: 一 > 二 -->\n正文内容甲乙丙丁';
    const without = '正文内容甲乙丙丁';

    expect(buildChunkTerms(withMeta).terms).not.toContain('大纲层级');
    // Length normalisation must not count machine bookkeeping as content.
    expect(buildChunkTerms(withMeta).len).toBeLessThan(buildChunkTerms(without).len + 5);
  });
});
