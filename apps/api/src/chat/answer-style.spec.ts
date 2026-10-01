import { answerStyleRule } from './answer-style';

describe('grounded answer style', () => {
  it('asks for concise cited fact answers in English while retaining detailed requests', () => {
    const rule = answerStyleRule(true);
    expect(rule).toContain('one or two short sentences including the citation');
    expect(rule).toContain('When the user asks for details, a comparison, steps, or multiple facts');
    expect(rule).toContain('separate paragraphs and block elements with a blank line');
    expect(rule).toContain('Never wrap the whole answer in a code fence');
  });

  it('applies the same distinction to Chinese questions', () => {
    const rule = answerStyleRule(false);
    expect(rule).toContain('一至两句短句直接作答并标注引用');
    expect(rule).toContain('若用户要求详细说明、比较、步骤或多个事实');
    expect(rule).toContain('段落和块元素之间留一个空行');
    expect(rule).toContain('禁止把整篇回答包进代码围栏');
  });
});
