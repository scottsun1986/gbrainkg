import { buildSourceContext, buildStaticAnswerRules, multiHopAnswerDirective } from './answer-prompt';

describe('answer prompt ownership', () => {
  const logger = { log: jest.fn() };
  it('keeps merged tail evidence and original numbering', () => {
    const text = 'head\n' + 'x'.repeat(7000) + '\nend-link';
    const context = buildSourceContext([{ docTitle: 'A', context: text, mergedChunkCount: 2 }, { docTitle: 'B', context: 'second' }], '', true, logger);
    expect(context).toContain('end-link');
    expect(context).toContain('Source 2');
    expect(context).toContain('《B》');
  });
  it('retains bilingual grounding, citation and value rules', () => {
    const englishRules = buildStaticAnswerRules(true);
    const chineseRules = buildStaticAnswerRules(false);
    expect(englishRules).toContain('copied character-for-character');
    expect(chineseRules).toContain('决定性取值必须逐字照抄');
    expect(englishRules).toContain("Preserve each source's stated scope, including its population or cohort");
    expect(chineseRules).toContain('保留每个来源明示的适用范围，包括人群或群体');
    expect(englishRules).toContain('Preserve the narrower evidence subject as the grammatical subject of the factual claim, including in the opening answer and list headings');
    expect(chineseRules).toContain('将证据支持的较窄主体保留为事实陈述的语法主语，包括首句和清单标题');
    expect(englishRules).toContain("explicitly qualify the claim to the supported subgroup rather than inherit the question's broader subject");
    expect(chineseRules).toContain('须在陈述中明确限定为有证据支持的子群体，不能沿用问题中的宽泛主体');
    expect(englishRules).toContain('For simple requests to name parts, categories, or stages, list the supported named parts and their applicable scope with citations');
    expect(chineseRules).toContain('对仅要求列举组成部分、类别或阶段的简单问题，列出有证据支持的名称、适用范围和角标即可');
    expect(englishRules).toContain('Do not expand subcriteria, sub-indicators, thresholds, calculations, or implementation details unless asked');
    expect(chineseRules).toContain('除非用户要求，不展开子条件、子指标、阈值、计算或实施细节');
    expect(chineseRules).toContain('当问题要求具体指标或条件，且资料');
    expect(englishRules).toContain('Only claim a dimension is absent after checking all supplied evidence');
    expect(chineseRules).toContain('只有检查全部提供的证据后才能声称某个维度未被覆盖');
    expect(englishRules).toContain('never invent source numbers or generate free-form source-title lists, bibliography, or source footers');
    expect(chineseRules).toContain('严禁捏造来源编号或生成自由形式的来源标题清单、参考文献或来源页脚');
  });
  it('selects the asked relation before combining frameworks and qualifies incomplete excerpts', () => {
    const englishRules = buildStaticAnswerRules(true);
    const chineseRules = buildStaticAnswerRules(false);
    expect(englishRules).toContain('Identify the exact subject, requested property, applicable scope');
    expect(chineseRules).toContain('先识别问题的准确主体、所问属性、适用范围');
    expect(englishRules).toContain("Never merge distinct relations or present workflow stages as an object's components");
    expect(chineseRules).toContain('不能把管理流程当作对象组成');
    expect(englishRules).toContain('A partial excerpt does not negate a complete one');
    expect(chineseRules).toContain('局部片段不能推翻完整片段');
    expect(englishRules).toContain('Do not claim that the complete document or knowledge base lacks them');
    expect(chineseRules).toContain('不声称完整文档或整个知识库没有这些名称');
    expect(englishRules).toContain('Illustrative examples — fictional, not reference evidence');
    expect(chineseRules).toContain('虚构，仅示范方法，不是本次事实证据');
    expect(englishRules).not.toContain('present each supported frame in the body');
    expect(chineseRules).not.toContain('首句应点明这些框架');
    expect(chineseRules).not.toContain('10~30字以内');
  });
  it('limits composition answers to requested items and binds each item and number to its actual evidence', () => {
    const englishRules = buildStaticAnswerRules(true);
    const chineseRules = buildStaticAnswerRules(false);
    expect(englishRules).toContain('output only their names, the count when requested, the necessary scope, and supporting citations');
    expect(chineseRules).toContain('只输出各项名称、所问数量、必需适用范围及支撑角标');
    expect(englishRules).toContain('Add such details only when the user explicitly requests proportions or a detailed explanation');
    expect(chineseRules).toContain('只有用户明确询问占比或详细说明时');
    expect(englishRules).toContain('Cite each item and each numerical claim only to a source that actually states that item or value');
    expect(chineseRules).toContain('每个列举项和每个数值只引用实际记载该项或该数值');
    expect(englishRules).toContain('every attached source supports the specific claim');
    expect(chineseRules).toContain('每个附加来源都必须支持该条具体断言');
    expect(englishRules).toContain('Do not add the unsolicited percentage or cite [2] for components');
    expect(chineseRules).toContain('不主动附加占比，也不用[2]支撑组成');
    expect(englishRules).toContain('Do not infer the image percentage');
    expect(chineseRules).toContain('不推算图片占比');
  });
  it('allows alternative interpretations only for unresolved ambiguity in the question itself', () => {
    const englishRules = buildStaticAnswerRules(true);
    const chineseRules = buildStaticAnswerRules(false);
    expect(englishRules).toContain('question text itself is materially ambiguous and no single directly matching property can be prioritized');
    expect(chineseRules).toContain('问题文本本身存在实质歧义，且无法优先确定一个直接匹配问项');
    expect(englishRules).toContain('If one reading directly fits the question, answer that reading and stop');
    expect(chineseRules).toContain('有一种理解直接契合问题时，回答该理解后即结束');
    expect(englishRules).toContain('Do not add framework differences to an unambiguous enumeration request');
    expect(chineseRules).toContain('明确的列举问题不得追加框架差异说明');
    expect(englishRules).toContain('Do not append "Collection management has three stages, which differs from the two components"');
    expect(chineseRules).toContain('不得续写“馆藏管理有三个环节，与上述两项组成不同”');
    expect(englishRules).not.toContain('Only when another evidence-backed reading is genuinely plausible');
    expect(chineseRules).not.toContain('只有另一种有证据的理解同样合理时');
    expect(chineseRules).not.toContain('再补充有必要的其他理解');
  });
  it('prioritizes the source population as the opening subject even when a broad question needs a short list', () => {
    const englishRules = buildStaticAnswerRules(true);
    const chineseRules = buildStaticAnswerRules(false);
    expect(englishRules).toContain("Set the opening sentence's grammatical subject from the population explicitly named in the supporting source");
    expect(chineseRules).toContain('先用支撑原文明示的人群确定首句语法主语');
    expect(englishRules).toContain('never copy the question\'s broader subject');
    expect(chineseRules).toContain('不能照搬问题中的宽泛主语');
    expect(englishRules).toContain('Answer: "Pilot packs consist of cards and labels.[1]"');
    expect(chineseRules).toContain('答“试点套装由卡片和标签组成。[1]”');
    expect(englishRules).toContain('not "All packages" or "Packages"');
    expect(chineseRules).toContain('不能写成“全部套装”或“套装”');
    expect(englishRules.indexOf("Set the opening sentence's grammatical subject")).toBeLessThan(englishRules.indexOf('For a question asking only how many parts'));
    expect(chineseRules.indexOf('先用支撑原文明示的人群确定首句语法主语')).toBeLessThan(chineseRules.indexOf('仅问“由几部分构成”'));
    expect(englishRules.indexOf('Scope example:')).toBeLessThan(englishRules.indexOf('Example 1:'));
    expect(chineseRules.indexOf('范围示例：')).toBeLessThan(chineseRules.indexOf('例一：'));
  });
  it('keeps final bilingual instructions free of the reported query domain', () => {
    for (const english of [true, false]) {
      expect(buildStaticAnswerRules(english)).not.toMatch(/绩效|员工|业绩|能力|行为|\bemployees?\b|\bperformance\b/i);
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
