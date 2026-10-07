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
    expect(buildStaticAnswerRules(true)).toContain('copied character-for-character');
    expect(buildStaticAnswerRules(false)).toContain('决定性取值必须逐字照抄');
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
