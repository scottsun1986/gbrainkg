import { OrderedAnswer, tidyVerifiedAnswer, answerSentenceBoundary, isStructuralHeadingLine, isSourceLabelHeading, dropEmptySectionHeadings, splitLeadingHeading } from './ordered-answer';

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

describe('multi-source answer structure', () => {
  it('treats a per-source label as a heading even when it ends with a full stop', () => {
    expect(isSourceLabelHeading('**来源 1《软件研发中心绩效管理办法 V2.doc》（第 5-11 页）：**')).toBe(true);
    expect(isSourceLabelHeading('**来源 2《软件研发中心绩效管理办法.doc》（第 1-5 页）：**')).toBe(true);
    expect(isSourceLabelHeading('来源 1《企业考勤制度手册V2.docx》。')).toBe(true);
    expect(isSourceLabelHeading('**Source 2 — Employee Handbook.pdf**')).toBe(true);
    expect(isStructuralHeadingLine('**来源 1《软件研发中心绩效管理办法 V2.doc》（第 5-11 页）：**')).toBe(true);
  });

  it('does not treat a sentence that merely mentions a source as a heading', () => {
    expect(isSourceLabelHeading('来源 1 规定员工迟到一小时按旷工半日处理[1]。')).toBe(false);
    expect(isSourceLabelHeading('根据来源 2 的规定')).toBe(false);
    expect(isSourceLabelHeading('')).toBe(false);
  });

  it('drops a source label whose section lost all its content', () => {
    const answer = [
      '**来源 1《V1.doc》：**',
      '**来源 2《V2.doc》：**',
      '权重 60%-80%[2]。',
    ].join('\n');
    expect(tidyVerifiedAnswer(answer)).toBe('**来源 2《V2.doc》：**\n权重 60%-80%[2]。');
  });

  it('keeps a label that still has content under it', () => {
    const answer = [
      '**来源 1《V1.doc》：**',
      '权重 50%-60%[1]。',
      '**来源 2《V2.doc》：**',
      '权重 60%-80%[2]。',
    ].join('\n');
    expect(tidyVerifiedAnswer(answer)).toBe(answer);
  });

  it('leaves a fenced heading untouched', () => {
    const code = '~~~\n# heading\n~~~';
    expect(dropEmptySectionHeadings(code.split('\n'))).toEqual(code.split('\n'));
  });
});

/**
 * A heading carries no sentence punctuation, so when the model omits the
 * newline before it the gate's boundary scan runs past the heading into its own
 * first sentence. Both then arrive as one string, which no longer classifies as
 * a heading, and the grounding gates drop it as an unsupported claim —
 * production: an answer whose first section had no heading at all.
 */
describe('splitLeadingHeading', () => {
  const heading = '**来源 1 与来源 5《员工考勤管理制度 V3.0》**（E2ESCORE-82892b86、E2ESCORE-148246e2 两个知识库）';
  const body = '两份文件内容一致，第三条均规定：弹性打卡时间为 09:00 至 10:00[1][5]。';

  it('separates a heading from the sentence it was merged with', () => {
    const split = splitLeadingHeading(heading + body);
    expect(split).not.toBeNull();
    expect(split!.heading).toBe(heading);
    expect(isStructuralHeadingLine(split!.heading)).toBe(true);
    expect(split!.rest).toBe(body);
  });

  it('keeps a short anchor parenthetical with its heading', () => {
    const h = '**来源 3《企业考勤管理制度详细手册.doc》**（集团总部知识库）';
    const split = splitLeadingHeading(h + '该手册提到员工上下班均需打卡[3]。');
    expect(split!.heading).toBe(h);
    expect(split!.rest).toBe('该手册提到员工上下班均需打卡[3]。');
  });

  it('leaves prose containing a version number alone', () => {
    // "V3.0" must not be mistaken for a numbered section ordinal.
    expect(splitLeadingHeading('上班时间随版本而不同：现行 V3.0 为弹性打卡 09:00–10:00 [3]，V1.0 则为固定 08:30 [1][4]。')).toBeNull();
  });

  it('leaves mid-sentence bold emphasis alone', () => {
    expect(splitLeadingHeading('现行版本为 **V3.0**，弹性打卡 09:00 至 10:00[3]。')).toBeNull();
  });

  it('returns null when there is no heading to recover', () => {
    expect(splitLeadingHeading('两份文件内容一致，第三条均规定 08:30[2][4]。')).toBeNull();
  });
});
