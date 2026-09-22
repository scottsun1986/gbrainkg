/**
 * Unit tests for `src/lib/citation-phrases.ts` pure highlight phrase extractors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCleanPhrases,
  rankPhrases,
  chunkAnchoredPhrases,
  resolveHighlightPhrases,
  stripDecorations,
} from '../src/lib/citation-phrases';

describe('extractCleanPhrases', () => {
  it('strips markdown and splits on punctuation', () => {
    const phrases = extractCleanPhrases('**数字化转型** 的痛点；管理挑战: 影响业务');
    assert.ok(phrases.includes('数字化转型 的痛点'));
    assert.ok(phrases.some((p) => p.includes('管理挑战')));
    assert.ok(phrases.every((p) => !p.includes('**')));
  });

  it('drops boilerplate, short tokens and the document title', () => {
    const phrases = extractCleanPhrases('属性维度\n可信度\nab\n报告标题', '报告标题');
    assert.ok(!phrases.includes('属性维度'));
    assert.ok(!phrases.includes('可信度'));
    assert.ok(!phrases.includes('ab'));
    assert.ok(!phrases.includes('报告标题'));
  });

  it('returns empty for empty snippet', () => {
    assert.deepEqual(extractCleanPhrases(''), []);
  });
});

describe('rankPhrases', () => {
  it('prefers phrases that appear exactly once in the full text', () => {
    const ranked = rankPhrases(['唯一短语', '重复短语'], '唯一短语 出现。重复短语 出现。重复短语 又来。');
    assert.equal(ranked[0], '唯一短语');
  });

  it('drops phrases that never match and caps output', () => {
    const ranked = rankPhrases(['不存在的东西在这里'], '完全无关的正文内容');
    assert.deepEqual(ranked, []);
  });
});

describe('chunkAnchoredPhrases', () => {
  it('returns null without a confident chunk match', () => {
    assert.equal(chunkAnchoredPhrases('短', [{ content: '无关内容' }]), null);
    assert.equal(chunkAnchoredPhrases('一段足够长的引用文本片段', []), null);
  });

  it('anchors phrases from the matching chunk when confidence is high', () => {
    const snippet = '本季度合规检查发现三项重大制度缺陷需要立即整改';
    const chunk = {
      content: [
        '【第1节】',
        '本季度合规检查发现三项重大制度缺陷需要立即整改。',
        '相关部门应当在三十日内完成整改并提交报告。',
        '复核组将于下月开展专项督查。',
      ].join('\n'),
    };
    const phrases = chunkAnchoredPhrases(snippet, [chunk]);
    assert.ok(phrases && phrases.length >= 2);
    assert.ok(phrases!.some((p) => p.includes('整改')));
  });
});

describe('resolveHighlightPhrases / stripDecorations', () => {
  it('strips context markers', () => {
    assert.equal(stripDecorations('[上下文:xxx]正文【第3节】'), '正文');
  });

  it('falls back to cleaned phrases when no chunk anchors', () => {
    const out = resolveHighlightPhrases('独立的引用短语内容', null, '');
    assert.ok(out.includes('独立的引用短语内容') || out.some((p) => p.includes('独立的引用')));
  });
});
