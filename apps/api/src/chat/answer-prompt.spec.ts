import { buildSourceContext, buildStaticAnswerRules, multiHopAnswerDirective } from './answer-prompt';

describe('answer prompt ownership', () => {
  const logger = { log: jest.fn() };
  const chineseRules = buildStaticAnswerRules(false);
  const englishRules = buildStaticAnswerRules(true);

  it('loads directory and table rules only for the selected task', () => {
    const ordinary = buildStaticAnswerRules(false, { directory: false, table: false });
    expect(ordinary).not.toContain('【章节目录全景列举】');
    expect(ordinary).not.toContain('【表格行记录与关键锚点事实并存处理】');
    expect(buildStaticAnswerRules(false, { directory: true, table: true })).toContain('【章节目录全景列举】');
  });

  it('keeps merged tail evidence and original numbering', () => {
    const text = 'head\n' + 'x'.repeat(7000) + '\nend-link';
    const context = buildSourceContext([{ docTitle: 'A', context: text, mergedChunkCount: 2 }, { docTitle: 'B', context: 'second' }], '', true, logger);
    expect(context).toContain('end-link');
    expect(context).toContain('Source 2');
    expect(context).toContain('《B》');
  });

  it('keeps one canonical Chinese rule body as the authority and English as a secondary addendum', () => {
    expect(chineseRules).toContain('【决策流程（按序执行）】');
    expect(chineseRules).toContain('【输出规范】');
    // English inherits the Chinese authority instead of maintaining a parallel rule set.
    expect(englishRules.startsWith(chineseRules)).toBe(true);
    expect(englishRules).toContain('The Chinese rules above are authoritative');
    expect(englishRules).toContain('otherwise use the question’s language');
    expect(chineseRules).not.toContain('[English response — secondary instructions]');
  });

  it('carries the source text that matches the question into the answer', () => {
    expect(chineseRules).toContain('【完整呈现匹配原文】');
    expect(chineseRules).toContain('必须将与该问题直接匹配的原文关键表述');
    expect(chineseRules).toContain('让用户看到依据');
    expect(chineseRules).toContain('不要为追求简短而省略与问题直接相关的原文要点');
    expect(englishRules).toContain('carry the source text that directly matches the question');
    expect(englishRules).toContain('without dropping directly relevant source points to be brief');
  });

  it('retains grounding, citation and value rules', () => {
    expect(chineseRules).toContain('决定性取值必须逐字照抄');
    expect(englishRules).toContain('application-provided typed calculations');
    expect(chineseRules).toContain('保留每个来源明示的适用范围，包括人群或群体');
    expect(chineseRules).toContain('将证据支持的较窄主体保留为事实陈述的语法主语，包括首句和清单标题');
    expect(chineseRules).toContain('须在陈述中明确限定为有证据支持的子群体，不能沿用问题中的宽泛主体');
    expect(englishRules).toContain("preserve each source's stated scope");
    expect(chineseRules).toContain('对仅要求列举组成部分、类别或阶段的简单问题，列出有证据支持的名称、适用范围和角标即可');
    expect(chineseRules).toContain('除非用户要求，不展开子条件、子指标、阈值、计算或实施细节');
    expect(chineseRules).toContain('当问题要求具体指标或条件，且资料');
    expect(chineseRules).toContain('只有检查全部提供的证据后才能声称某个维度未被覆盖');
    expect(chineseRules).toContain('严禁捏造来源编号或生成自由形式的来源标题清单、参考文献或来源页脚');
  });

  it('selects the asked relation before combining frameworks and qualifies incomplete excerpts', () => {
    expect(chineseRules).toContain('先识别问题的准确主体、所问属性、适用范围');
    expect(chineseRules).toContain('不能把管理流程当作对象组成');
    expect(chineseRules).toContain('局部片段不能推翻完整片段');
    expect(chineseRules).toContain('不声称完整文档或整个知识库没有这些名称');
    expect(chineseRules).toContain('虚构，仅示范方法，不是本次事实证据');
    expect(chineseRules).not.toContain('present each supported frame in the body');
    expect(chineseRules).not.toContain('首句应点明这些框架');
    expect(chineseRules).not.toContain('10~30字以内');
  });

  it('limits composition answers to requested items and binds each item and number to its actual evidence', () => {
    expect(chineseRules).toContain('只输出各项名称、所问数量、必需适用范围及支撑角标');
    expect(chineseRules).toContain('只有用户明确询问占比或详细说明时');
    expect(chineseRules).toContain('每个列举项和每个数值只引用实际记载该项或该数值');
    expect(chineseRules).toContain('每个附加来源都必须支持该条具体断言');
    expect(chineseRules).toContain('不主动附加占比，也不用[2]支撑组成');
    expect(chineseRules).toContain('不推算图片占比');
  });

  it('allows alternative interpretations only for unresolved ambiguity in the question itself', () => {
    expect(chineseRules).toContain('问题文本本身存在实质歧义，且无法优先确定一个直接匹配问项');
    expect(chineseRules).toContain('有一种理解直接契合问题时，回答该理解后即结束');
    expect(chineseRules).toContain('明确的列举问题不得追加框架差异说明');
    expect(chineseRules).toContain('不得续写“馆藏管理有三个环节，与上述两项组成不同”');
    expect(chineseRules).not.toContain('只有另一种有证据的理解同样合理时');
    expect(chineseRules).not.toContain('再补充有必要的其他理解');
  });

  it('prioritizes the source population as the opening subject even when a broad question needs a short list', () => {
    expect(chineseRules).toContain('先用支撑原文明示的人群确定首句语法主语');
    expect(chineseRules).toContain('不能照搬问题中的宽泛主语');
    expect(chineseRules).toContain('答“试点套装由卡片和标签组成。[1]”');
    expect(chineseRules).toContain('不能写成“全部套装”或“套装”');
    expect(chineseRules.indexOf('先用支撑原文明示的人群确定首句语法主语')).toBeLessThan(chineseRules.indexOf('仅问“由几部分构成”'));
    expect(chineseRules.indexOf('范围示例：')).toBeLessThan(chineseRules.indexOf('例一：'));
  });

  it('requires every source with a differing value for the same property to be presented', () => {
    expect(chineseRules).toContain('同属性多源差异必须并列');
    expect(chineseRules).toContain('必须全部并列呈现，逐条标注各自来源角标及其明示适用范围');
    expect(chineseRules).toContain('不得自行判定何者为准或存在替代关系');
    expect(chineseRules).toContain('不得静默合并或取平均');
    expect(chineseRules).toContain('版本号、上传时间或标题相似不构成取舍依据');
    expect(chineseRules).toContain('由用户决定采用哪一条');
    expect(chineseRules).toContain('此规则针对问题的理解，不针对来源之间取值不同');
    expect(englishRules).toContain('present every one with its own citation and stated scope');
    expect(englishRules).toContain('never choose, rank, merge or average them');
  });

  it('covers negation and relative-time question shapes', () => {
    expect(chineseRules).toContain('【否定与缺失问法】');
    expect(chineseRules).toContain('先明确回答“有/无”并标注依据来源');
    expect(chineseRules).toContain('【时间相对问法】');
    expect(chineseRules).toContain('不得凭当前日期臆断');
  });

  it('keeps final bilingual instructions free of the reported query domain', () => {
    for (const rules of [chineseRules, englishRules]) {
      expect(rules).not.toMatch(/绩效|员工|业绩|能力|行为|\bemployees?\b|\bperformance\b/i);
    }
  });

  it('requires each hop, identifies missing links, and uses merged source indices', () => {
    const rule = multiHopAnswerDirective('multi_hop', [{ subQueryOrigin: 'first' }, { subQueryOrigin: 'second' }], true);
    expect(rule).toContain('citation for every link');
    expect(rule).toContain('missing, conflicting or ambiguous');
    expect(rule).toContain('identical surface names alone');
    expect(rule).toContain('cannot substitute');
    expect(rule).toContain('first line must contain only');
    expect(rule).toContain('"sources":[2]');
    expect(rule).toContain('not facts');
    expect(multiHopAnswerDirective('simple', [{ id: 'a' }], true)).toBe('');
    expect(multiHopAnswerDirective('multi_hop', [], true)).toBe('');
  });
});

describe('answer prompt refusal rules', () => {
  it('forbids substituting unrelated values for a missing subject', () => {
    const rules = buildStaticAnswerRules(false);
    expect(rules).toContain('【主体完全无关时直接拒答】');
    expect(rules).toContain('不得罗列其他主体的价格、数值或条目来说明"不相关"');
  });

  it('keeps the partial-coverage rule for missing attributes', () => {
    // A missing attribute is not the same as a missing subject: partial answers
    // with scope notes must remain reachable.
    const rules = buildStaticAnswerRules(false);
    expect(rules).toContain('（d）没有任何来源直接陈述该属性时');
  });
});
