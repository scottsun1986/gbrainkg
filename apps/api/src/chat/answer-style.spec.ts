import { answerStyleRule } from './answer-style';

describe('grounded answer style', () => {
  it('asks for a cited conclusion followed by the matching source text in English while retaining detailed requests', () => {
    const rule = answerStyleRule(true);
    expect(rule).toContain('State the core conclusion first with its citation');
    expect(rule).toContain('carry the source text that directly matches the question');
    expect(rule).toContain('do not drop source points that bear directly on the question merely to be brief');
    expect(rule).toContain('Every block-level element (source/section heading, list, table, code block, quote) must be its own block');
    expect(rule).toContain('two blocks are never separated by a single newline');
    expect(rule).toContain('bold (**…**) is reserved for a standalone source/section heading');
    expect(rule).toContain('all source/section labels in one answer must be consistently bold');
    expect(rule).toContain('non-heading text is never bold');
    expect(rule).toContain('When the user asks for details, a comparison, steps, or multiple facts');
    expect(rule).toContain('Separate paragraphs and block elements with a blank line');
    expect(rule).toContain('Never wrap the whole answer in a code fence');
  });

  it('applies the same distinction to Chinese questions', () => {
    const rule = answerStyleRule(false);
    expect(rule).toContain('先直接给出核心结论并标注引用');
    expect(rule).toContain('带上参考资料中与问题直接匹配的原文关键表述');
    expect(rule).toContain('不要为压缩字数省略与问题直接相关的原文要点');
    expect(rule).toContain('每个块级元素（来源/分节标题、列表、表格、代码块、引用）必须独立成块');
    expect(rule).toContain('禁止用单个换行分隔两个块级内容');
    expect(rule).toContain('加粗（**…**）只用于独立成行的来源/分节标题');
    expect(rule).toContain('同一回答中所有来源/分节标题的加粗必须一致');
    expect(rule).toContain('非标题的正文一律不加粗');
    expect(rule).toContain('若用户要求详细说明、比较、步骤或多个事实');
    expect(rule).toContain('段落和块元素之间留一个空行');
    expect(rule).toContain('禁止把整篇回答包进代码围栏');
  });
});
