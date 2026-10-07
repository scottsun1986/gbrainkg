import { OrderedAnswer, tidyVerifiedAnswer, answerSentenceBoundary, isStructuralHeadingLine, isSourceLabelHeading, dropEmptySectionHeadings, splitLeadingHeading, isAnswerBlockStart, isEnumerativeLabelLine, normalizeAnswerLayout, boldSourceLabels, isPlainTextHeading } from './ordered-answer';

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

  /**
   * A bare bold phrase mid-sentence reads as a heading on its own, so without a
   * stand-alone check the recovery tore emphasis off as navigation and split
   * the sentence — production: "…视为旷工**半日**；**超过2小时**的，视为旷工**1日**"
   * rendered as a line break right after "超过2小时".
   */
  it('does not treat bold emphasis inside a clause as a heading', () => {
    expect(splitLeadingHeading('迟到**超过30分钟**不足2小时的，视为旷工**半日**；**超过2小时**的，视为旷工**1日**；')).toBeNull();
    expect(splitLeadingHeading('现行版本为 **V3.0**，弹性打卡 09:00 至 10:00[3]。')).toBeNull();
  });

  it('still recovers a source heading whose prose follows on the same line', () => {
    // The anchor parenthetical names the library and is what makes this a
    // heading rather than a claim, so same-line prose does not disqualify it.
    const h = '**来源 1《企业考勤制度手册》（集团总部知识库）**';
    const split = splitLeadingHeading(h + '该手册提到员工上下班均需打卡[3]。');
    expect(split!.heading).toBe(h);
    expect(split!.rest).toBe('该手册提到员工上下班均需打卡[3]。');
  });
});

describe('answer block layout normalization', () => {
  it('opens a new block for a bold source label with a same-line payload', () => {
    expect(isAnswerBlockStart('**来源《企业研发管理规范》**：研发人员考核采用…[3]')).toBe(true);
    expect(isAnswerBlockStart('**来源《软件研发中心绩效管理办法》**：三类指标…[2]')).toBe(true);
    // A qualifier may sit between the closing marker and the colon.
    expect(isAnswerBlockStart('**《企业研发管理规范》的口径**（适用于公司所有研发项目）：研发人员考核采用…[3]')).toBe(true);
    // The qualifier may itself carry a citation marker.
    expect(isAnswerBlockStart('**《软件研发中心绩效管理办法》口径**（适用于软件研发中心全体正式员工 [1]）：三类指标 [1]')).toBe(true);
    expect(isAnswerBlockStart('研发人员考核采用“项目绩效+技术贡献”的结构[3]。')).toBe(false);
    // Bold emphasis followed directly by prose stays inline.
    expect(isAnswerBlockStart('**重要**内容继续同一句。')).toBe(false);
  });

  it('recognizes enumerative discourse labels without a numbered source', () => {
    expect(isEnumerativeLabelLine('其二，企业研发管理规范：')).toBe(true);
    expect(isEnumerativeLabelLine('**其一：**')).toBe(true);
    expect(isEnumerativeLabelLine('其次，说明如下。')).toBe(true);
    expect(isAnswerBlockStart('其二，企业研发管理规范：内容[3]。')).toBe(true);
    // A clause reference is not a discourse label.
    expect(isEnumerativeLabelLine('第十条 经济补偿按 N+1 执行。')).toBe(false);
  });

  it('inserts exactly one blank line before each block that follows prose', () => {
    const input = [
      '研发人员的绩效组成，两份来源给出了不同结构，须并列参考：',
      '**来源《软件研发中心绩效管理办法》**：三类指标 [2]',
      '**来源《企业研发管理规范》**：项目绩效+技术贡献 [3]',
    ].join('\n');
    expect(normalizeAnswerLayout(input)).toBe([
      '研发人员的绩效组成，两份来源给出了不同结构，须并列参考：',
      '',
      '**来源《软件研发中心绩效管理办法》**：三类指标 [2]',
      '',
      '**来源《企业研发管理规范》**：项目绩效+技术贡献 [3]',
    ].join('\n'));
  });

  it('separates enumerative sections but never splits a list or a table', () => {
    expect(normalizeAnswerLayout('其一：内容A。\n其二，企业研发管理规范：内容B。'))
      .toBe('其一：内容A。\n\n其二，企业研发管理规范：内容B。');
    const list = '- 甲[1]\n- 乙[2]\n- 丙[3]';
    expect(normalizeAnswerLayout(list)).toBe(list);
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(normalizeAnswerLayout(table)).toBe(table);
  });

  it('splits a bold label glued after a sentence boundary or a citation marker', () => {
    expect(normalizeAnswerLayout('原文表述：…[2]；**二、《企业研发管理规范》口径（适用范围）**\n研发人员考核…[3]。'))
      .toBe('原文表述：…[2]；\n\n**二、《企业研发管理规范》口径（适用范围）**\n研发人员考核…[3]。');
    expect(normalizeAnswerLayout('前节结论[2] **来源《企业研发管理规范》**：研发人员考核…[3]'))
      .toBe('前节结论[2]\n\n**来源《企业研发管理规范》**：研发人员考核…[3]');
  });

  it('separates headings and code fences from surrounding prose without touching fenced content', () => {
    expect(normalizeAnswerLayout('结论。\n## 依据\n内容。\n```js\nx\n```'))
      .toBe('结论。\n\n## 依据\n内容。\n\n```js\nx\n```');
    const fenced = '说明。\n```text\n# 代码里的标题\n- 代码里的列表\n```';
    expect(normalizeAnswerLayout(fenced)).toBe('说明。\n\n```text\n# 代码里的标题\n- 代码里的列表\n```');
  });

  it('is idempotent', () => {
    const input = '前言。\n**来源 1《A》**：内容 [1]\n**来源 2《B》**：内容 [2]\n- 甲\n- 乙';
    const once = normalizeAnswerLayout(input);
    expect(normalizeAnswerLayout(once)).toBe(once);
  });

  it('drops lone bracket/punctuation residue but keeps tables, rules and fences', () => {
    expect(normalizeAnswerLayout('甲。\n）\n乙。')).toBe('甲。\n乙。');
    expect(normalizeAnswerLayout('| A | B |\n|---|---|\n| 1 | 2 |')).toBe('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(normalizeAnswerLayout('说明。\n\n---\n\n后续。')).toBe('说明。\n\n---\n\n后续。');
    expect(normalizeAnswerLayout('```\n）\n```')).toBe('```\n）\n```');
  });

  it('reserves bold for standalone labels and strips inline emphasis', () => {
    expect(normalizeAnswerLayout('资料记载有**业绩指标**和**行为指标**两部分[1]。'))
      .toBe('资料记载有业绩指标和行为指标两部分[1]。');
    expect(normalizeAnswerLayout('说明。\n**来源《X》**：内容 [1]'))
      .toBe('说明。\n\n**来源《X》**：内容 [1]');
    // A list-item label keeps its bold; its trailing inline bold is stripped.
    expect(normalizeAnswerLayout('- **业绩指标**：衡量工作产出与**成果** [1]'))
      .toBe('- **业绩指标**：衡量工作产出与成果 [1]');
  });

  it('classifies plain-text headings from structure, not domain vocabulary', () => {
    // A heading ends on a section-type noun.
    expect(isPlainTextHeading('一、处理方式')).toBe(true);
    expect(isPlainTextHeading('二、适用范围')).toBe(true);
    // A rule carries limit wording or a predicate, regardless of topic.
    expect(isPlainTextHeading('三、超过10分钟以上')).toBe(false);
    expect(isPlainTextHeading('四、应当提交申请')).toBe(false);
  });

  it('makes every source label bold, including a multi-line parenthetical', () => {
    const input = '**来源1《A》**（适用）\n\n- x [1]\n\n来源2《B》（适用全体在职员工含试用期、劳务派遣人员；\n标准工时制适用于一般管理岗位）\n\n- y [2]';
    const out = boldSourceLabels(input);
    expect(out).toContain('**来源2《B》（适用全体在职员工含试用期、劳务派遣人员；\n标准工时制适用于一般管理岗位）**');
    // An already-bold label is left untouched.
    expect(out).toContain('**来源1《A》**（适用）');
    // A sentence that merely starts with a source word is not a label.
    expect(boldSourceLabels('来源2《B》规定，员工迟到按旷工处理 [2]。')).toBe('来源2《B》规定，员工迟到按旷工处理 [2]。');
    // A title-less label is normalized too.
    expect(boldSourceLabels('来源 1（适用于公司全体正式员工）\n\n- x [1]'))
      .toContain('**来源 1（适用于公司全体正式员工）**');
  });
});
