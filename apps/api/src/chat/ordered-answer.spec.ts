import { OrderedAnswer, tidyVerifiedAnswer, answerSentenceBoundary } from './ordered-answer';

describe('verified answer order', () => {
  it('restores delayed evidence beneath its own heading, ahead of later sections', () => {
    const answer = new OrderedAnswer();
    answer.append(0, '**当前版本**\n');
    answer.append(1, '当前条款[1]。\n');
    answer.append(2, '**历史版本**\n');
    answer.append(4, '**版本差异**\n');
    answer.append(5, '比较结论[1][2]。');
    answer.append(3, '历史条款[2]。\n');
    expect(answer.render()).toBe('**当前版本**\n当前条款[1]。\n**历史版本**\n历史条款[2]。\n**版本差异**\n比较结论[1][2]。');
  });
  it('drops rejected slots without moving approved table rows or duplicating fragments', () => {
    const answer = new OrderedAnswer();
    answer.append(0, '| 字段 | 数值 |\n|---|---|\n');
    answer.append(3, '\n结论。');
    answer.append(1, '| 已核验 | 30[1] |\n');
    expect(answer.render()).toBe('| 字段 | 数值 |\n|---|---|\n| 已核验 | 30[1] |\n\n结论。');
    expect(answer.render()).toBe(answer.render());
  });
});

describe('verified answer formatting after clause rejection', () => {
  it('removes orphan citation/bold shells without removing facts, tables or source markers', () => {
    expect(tidyVerifiedAnswer('**[1][2][3]\n| 来源 | 时间 |\n|---|---|\n| 甲 | 09:00[1] |\n\n## 结论\n')).toBe('| 来源 | 时间 |\n|---|---|\n| 甲 | 09:00[1] |');
    expect(tidyVerifiedAnswer('**结论为09:00[1]。**\n\n- 第一章 总则[2]')).toBe('**结论为09:00[1]。**\n\n- 第一章 总则[2]');
  });
});

  it('cleans a closing bold marker after an earlier clause was rejected, preserving code', () => {
    expect(tidyVerifiedAnswer('已核验规定09:00[2]。**\n**另一项规定08:30[1]。**')).toBe('已核验规定09:00[2]。\n**另一项规定08:30[1]。**');
    expect(tidyVerifiedAnswer('运算符为 `**`[1]。\n```python\nx ** 2\n**\n```')).toBe('运算符为 `**`[1]。\n```python\nx ** 2\n**\n```');
  });


describe('layout after delayed verification', () => {
  it('uses source neighbours when inserting block boundaries, without splitting recovered rows', () => {
    const answer = new OrderedAnswer();
    answer.append(0, '开头。');
    answer.append(3, '| B | 20[2] |\n', true);
    answer.append(4, '## 后续章节\n', true);
    answer.append(1, '| 项目 | 数值 |\n|---|---|\n', true);
    answer.append(2, '| A | 10[1] |\n', true);
    expect(answer.render()).toBe('开头。\n| 项目 | 数值 |\n|---|---|\n| A | 10[1] |\n| B | 20[2] |\n## 后续章节\n');
  });
  it('holds a complete table row across stream chunks and punctuation', () => {
    expect(answerSentenceBoundary('| A | 第一句。第二句；')).toBe(-1);
    const row = '| A | 第一句。第二句；数值10[1] |\n';
    expect(answerSentenceBoundary(row + '下一段。')).toBe(row.length - 1);
    expect(answerSentenceBoundary('第一句。第二句。')).toBe(3);
  });
});


it('preserves code blank lines, headings and mixed fence literals verbatim', () => {
  const code = '~~~~text\n```literal\n\n\n# code heading\n~~~~';
  expect(tidyVerifiedAnswer(code)).toBe(code);
  expect(tidyVerifiedAnswer('```text\n\n# unfinished code heading')).toBe('```text\n\n# unfinished code heading');
});
