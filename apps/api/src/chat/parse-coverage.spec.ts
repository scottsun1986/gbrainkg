import {
  buildCoverageQualifier,
  buildCoverageScopeNote,
  collectIncompleteCoverageSources,
  isCompletenessSensitiveQuestion,
  isCoverageScopeStatement,
  isIncompleteCoverage,
  normalizeParseCoverage,
} from './parse-coverage';

const incomplete = { total: 10, processed: 9, failed: 1, skipped: 0 };
const complete = { total: 10, processed: 10, failed: 0, skipped: 0 };

describe('parse coverage contract (F06)', () => {
  it('normalizes only finite positive coverage records', () => {
    expect(normalizeParseCoverage(null)).toBeNull();
    expect(normalizeParseCoverage({ total: 0, processed: 0, failed: 0, skipped: 0 })).toBeNull();
    expect(normalizeParseCoverage({ total: '10', processed: '9', failed: '1' })).toEqual(incomplete);
    expect(normalizeParseCoverage({ processed: 3 })).toBeNull();
  });

  it('treats failed, skipped and not-fully-processed as incomplete', () => {
    expect(isIncompleteCoverage(incomplete)).toBe(true);
    expect(isIncompleteCoverage({ total: 10, processed: 10, failed: 0, skipped: 2 })).toBe(true);
    expect(isIncompleteCoverage(complete)).toBe(false);
    expect(isIncompleteCoverage(null)).toBe(false);
  });

  it('recognizes completeness-sensitive questions in both languages', () => {
    expect(isCompletenessSensitiveQuestion('这份文档总共有几项内容？')).toBe(true);
    expect(isCompletenessSensitiveQuestion('是否存在关于年假的规定？')).toBe(true);
    expect(isCompletenessSensitiveQuestion('请列出所有条款')).toBe(true);
    expect(isCompletenessSensitiveQuestion('How many items are listed?')).toBe(true);
    expect(isCompletenessSensitiveQuestion('List all the entries')).toBe(true);
    expect(isCompletenessSensitiveQuestion('第十条的内容是什么？')).toBe(false);
    expect(isCompletenessSensitiveQuestion('What is the notice period?')).toBe(false);
  });

  it('builds a scope note only when an incomplete source is cited', () => {
    const citations = [
      { docTitle: '十页文档.md', parseCoverage: incomplete },
      { docTitle: '完整文档.md', parseCoverage: complete },
    ];
    const note = buildCoverageScopeNote(citations, false);
    expect(note).toContain('十页文档.md');
    expect(note).toContain('9/10');
    expect(note).not.toContain('完整文档.md');
    expect(buildCoverageScopeNote([{ docTitle: '完整文档.md', parseCoverage: complete }], false)).toBe('');
    const english = buildCoverageScopeNote(citations, true);
    expect(english).toContain('[Parse-coverage notice]');
    expect(english).toContain('failed 1');
  });

  it('deduplicates incomplete sources across chunks of one document', () => {
    const sources = collectIncompleteCoverageSources([
      { docTitle: 'A.md', parseCoverage: incomplete },
      { docTitle: 'A.md', parseCoverage: incomplete },
      { docTitle: 'B.md', parseCoverage: complete },
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBe('A.md');
  });

  it('appends a deterministic qualifier for completeness questions over partial parses', () => {
    const citations = [{ docTitle: '十页文档.md', parseCoverage: incomplete }];
    const qualifier = buildCoverageQualifier('总共有多少条记录？', citations, '共有 9 条记录。[1]', false);
    expect(qualifier).toContain('【范围说明】');
    expect(qualifier).toContain('十页文档.md');
    // Idempotent: once the qualifier (or an equivalent acknowledgment) is in
    // the answer, no second one is appended.
    const qualified = `共有 9 条记录。[1]${qualifier}`;
    expect(buildCoverageQualifier('总共有多少条记录？', citations, qualified, false)).toBe('');
    // Complete coverage or a non-completeness question needs no qualifier.
    expect(buildCoverageQualifier('总共有多少条记录？', [{ docTitle: 'A', parseCoverage: complete }], 'A。[1]', false)).toBe('');
    expect(buildCoverageQualifier('第十条的内容是什么？', citations, '内容。[1]', false)).toBe('');
    // A model-authored acknowledgment is respected as well.
    expect(buildCoverageQualifier('是否存在相关规定？', citations, '该文档解析覆盖不完整，仅 9/10 单元可读。[1]', false)).toBe('');
  });

  it('marks our own scope sentences so grounding stats can exclude them', () => {
    expect(isCoverageScopeStatement('【范围说明】《A》：已解析 9/10 个来源单元（失败 1，跳过 0）。')).toBe(true);
    expect(isCoverageScopeStatement('[Scope note] “A”: 9/10 units parsed')).toBe(true);
    expect(isCoverageScopeStatement('正常事实句。')).toBe(false);
  });
});
