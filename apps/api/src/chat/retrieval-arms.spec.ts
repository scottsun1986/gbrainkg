import {
  calibratedScoreOf,
  documentCurrentlyEffective,
  extractRawChunkText,
  hasPolarityConflict,
  isRefusalAnswerText,
  numericClaimsOf,
  semanticCacheScopeKey,
  statementSupportedBy,
  stripInvalidCitationMarkers,
} from './retrieval-arms';

/**
 * These pure helpers sit on the grounding and caching paths: a regression in
 * any of them either lets a fabricated sentence through as "grounded", or lets
 * one user's cached answer be replayed to another scope. They are tested
 * directly because the services that call them are hard to exercise in
 * isolation.
 */

describe('stripInvalidCitationMarkers', () => {
  it('keeps markers inside the citation range and drops out-of-range ones', () => {
    expect(stripInvalidCitationMarkers('甲[1]乙[2]丙[3]', 2)).toBe('甲[1]乙[2]丙');
  });

  it('drops a zero index, which can never refer to a source', () => {
    expect(stripInvalidCitationMarkers('甲[0]', 3)).toBe('甲');
  });
});

describe('numericClaimsOf', () => {
  it('extracts integers and decimals but ignores citation indices', () => {
    expect(numericClaimsOf('年假为10天，补贴0.5倍[3]')).toEqual(['10', '0.5']);
  });

  it('returns an empty list for a statement with no numbers', () => {
    expect(numericClaimsOf('员工应遵守制度[1]')).toEqual([]);
  });
});

describe('extractRawChunkText', () => {
  it('removes the contextual prefix and structural comments added at ingestion', () => {
    const raw = '[上下文: 第一章 总则]\n<!-- 大纲层级: 1 -->正文内容<!-- bbox: 0,0,1,1 -->';
    expect(extractRawChunkText(raw)).toBe('正文内容');
  });
});

describe('hasPolarityConflict', () => {
  it('flags a lower bound claimed against an evidence upper bound', () => {
    expect(hasPolarityConflict('金额不得低于800元', '金额不得高于100元')).toBe(true);
  });

  it('does not flag two bounds that form a valid range', () => {
    expect(hasPolarityConflict('下限为5万元', '上限为10万元')).toBe(false);
  });

  it('flags permission claimed against an explicit prohibition', () => {
    expect(hasPolarityConflict('员工可以携带外来人员进入机房', '严禁携带外来人员进入机房')).toBe(true);
  });

  it('flags the English permission-versus-prohibition case', () => {
    expect(hasPolarityConflict('Visitors are allowed in the lab.', 'Visitors must not enter the lab.')).toBe(true);
  });

  it('does not flag a statement that agrees with the evidence', () => {
    expect(hasPolarityConflict('严禁携带外来人员进入机房', '严禁携带外来人员进入机房')).toBe(false);
  });
});

describe('statementSupportedBy', () => {
  const evidence = ['第十条 员工每年享有带薪年假10天，需提前3个工作日申请。'];

  it('accepts a cited statement that restates the evidence', () => {
    expect(statementSupportedBy('员工每年享有带薪年假10天[1]', evidence, true)).toBe(true);
  });

  it('rejects a cited statement with a fabricated number', () => {
    expect(statementSupportedBy('员工每年享有带薪年假15天[1]', evidence, true)).toBe(false);
  });

  it('rejects invented prose that only reuses common characters', () => {
    expect(statementSupportedBy('公司每年为员工提供体检与培训福利[1]', evidence, true)).toBe(false);
  });

  it('rejects any statement when the evidence pool is empty', () => {
    expect(statementSupportedBy('员工每年享有带薪年假10天', [], false)).toBe(false);
  });

  it('rejects a statement that contradicts the evidence polarity', () => {
    expect(statementSupportedBy('员工可以携带外来人员进入机房[1]', ['严禁携带外来人员进入机房'], true)).toBe(false);
  });

  it('applies the English content-word overlap check', () => {
    const en = ['Employees receive ten days of paid annual leave each year.'];
    expect(statementSupportedBy('Employees receive ten days of paid annual leave [1]', en, true)).toBe(true);
    expect(statementSupportedBy('Contractors receive quarterly performance bonuses [1]', en, true)).toBe(false);
  });
});

describe('semanticCacheScopeKey', () => {
  it('is independent of source order', () => {
    expect(semanticCacheScopeKey(['a', 'b'], 1, 1)).toBe(semanticCacheScopeKey(['b', 'a'], 1, 1));
  });

  it('changes when the source set changes, so a narrowed query cannot hit a broader entry', () => {
    expect(semanticCacheScopeKey(['a'], 1, 1)).not.toBe(semanticCacheScopeKey(['a', 'b'], 1, 1));
  });

  it('changes when the ACL or knowledge epoch changes', () => {
    const baseKey = semanticCacheScopeKey(['a'], 1, 1);
    expect(semanticCacheScopeKey(['a'], 2, 1)).not.toBe(baseKey);
    expect(semanticCacheScopeKey(['a'], 1, 2)).not.toBe(baseKey);
  });

  it('separates two users who share a scope', () => {
    expect(semanticCacheScopeKey(['a'], 1, 1, 'm', 'user-1')).not.toBe(
      semanticCacheScopeKey(['a'], 1, 1, 'm', 'user-2'),
    );
  });
});

describe('calibratedScoreOf', () => {
  it('ignores synthetic scores, which carry no calibration', () => {
    expect(calibratedScoreOf({ score: 0.9, scoreSource: 'synthetic' })).toBeNull();
  });

  it('prefers relevanceScore over the raw score', () => {
    expect(calibratedScoreOf({ relevanceScore: 0.7, score: 0.2 })).toBe(0.7);
  });

  it('returns null for missing or non-positive values', () => {
    expect(calibratedScoreOf(null)).toBeNull();
    expect(calibratedScoreOf({ score: 0 })).toBeNull();
  });
});

describe('isRefusalAnswerText', () => {
  it('detects Chinese and English refusals', () => {
    expect(isRefusalAnswerText('知识库中未找到相关规定。')).toBe(true);
    expect(isRefusalAnswerText('This is not recorded in the provided reference materials.')).toBe(true);
  });

  it('treats an empty answer as a refusal', () => {
    expect(isRefusalAnswerText('')).toBe(true);
  });

  it('does not flag a substantive answer', () => {
    expect(isRefusalAnswerText('员工每年享有带薪年假10天。')).toBe(false);
  });
});

describe('documentCurrentlyEffective', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');

  it('excludes a repealed edition with no end date', () => {
    expect(documentCurrentlyEffective({ lifecycleStatus: 'repealed' }, now)).toBe(false);
  });

  it('excludes an edition that has not come into force yet', () => {
    expect(documentCurrentlyEffective({ effectiveFrom: '2026-07-01' }, now)).toBe(false);
  });

  it('excludes an edition whose effective period has ended', () => {
    expect(documentCurrentlyEffective({ effectiveTo: '2026-05-01' }, now)).toBe(false);
  });

  it('keeps an edition with no date metadata', () => {
    expect(documentCurrentlyEffective({}, now)).toBe(true);
  });
});
