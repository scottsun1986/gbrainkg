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
    expect(englishRules).toContain('distinguish and present each supported frame in the body with its evidence');
    expect(chineseRules).toContain('须区分并在正文中呈现每个有证据支持的框架及对应角标');
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
