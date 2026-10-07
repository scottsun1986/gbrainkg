import { answerStyleRule } from './answer-style';

describe('grounded answer style', () => {
  it('asks for a cited conclusion followed by the matching source text in English while retaining detailed requests', () => {
    const rule = answerStyleRule(true);
    expect(rule).toContain('State the core conclusion first with its citation');
    expect(rule).toContain('carry the source text that directly matches the question');
    expect(rule).toContain('do not drop source points that bear directly on the question merely to be brief');
    expect(rule).toContain('When the user asks for details, a comparison, steps, or multiple facts');
    expect(rule).toContain('separate paragraphs and block elements with a blank line');
    expect(rule).toContain('Never wrap the whole answer in a code fence');
  });

  it('applies the same distinction to Chinese questions', () => {
    const rule = answerStyleRule(false);
    expect(rule).toContain('先直接给出核心结论并标注引用');
    expect(rule).toContain('带上参考资料中与问题直接匹配的原文关键表述');
    expect(rule).toContain('不要为压缩字数省略与问题直接相关的原文要点');
    expect(rule).toContain('若用户要求详细说明、比较、步骤或多个事实');
    expect(rule).toContain('段落和块元素之间留一个空行');
    expect(rule).toContain('禁止把整篇回答包进代码围栏');
  });
});
