import { numericClaimsOf, statementSupportedBy, documentCurrentlyEffective } from './chat.service';

describe('numericClaimsOf', () => {
  it('extracts numeric tokens and ignores citation markers', () => {
    expect(numericClaimsOf('迟到一次扣款 50 元[1]，三次扣 200 元[2]。')).toEqual(['50', '200']);
  });

  it('keeps decimal and percentage claims intact', () => {
    expect(numericClaimsOf('可用性不低于 99.95%[1]')).toEqual(['99.95']);
  });
});

describe('statementSupportedBy', () => {
  const evidence = ['考勤管理规定：员工迟到一次扣款 50 元，月累计三次扣款 200 元。旷工一天扣款 500 元。'];

  it('accepts a tagged statement whose numbers appear in the cited evidence', () => {
    expect(statementSupportedBy('员工迟到一次将被扣款 50 元[1]。', evidence, true)).toBe(true);
  });

  it('rejects a fabricated number wearing a real citation index', () => {
    expect(statementSupportedBy('员工迟到一次将被扣款 5000 元[1]。', evidence, true)).toBe(false);
  });

  it('rejects a mutated decimal threshold with a real citation index', () => {
    const sla = ['系统可用性不低于 99.95%，响应时间 800 毫秒。'];
    expect(statementSupportedBy('系统可用性不低于 99.59%[1]。', sla, true)).toBe(false);
  });

  it('accepts paraphrase with a tag (overlap above the tagged bar)', () => {
    expect(statementSupportedBy('迟到会扣款 50 元[1]。', evidence, true)).toBe(true);
  });

  it('rejects invented prose riding on a real citation index', () => {
    expect(statementSupportedBy('公司每年组织三次免费体检并发放节日礼品[1]。', evidence, true)).toBe(false);
  });

  it('accepts untagged statements overlapping the whole evidence pool above 0.7', () => {
    expect(statementSupportedBy('迟到一次扣款 50 元，三次扣 200 元。', evidence, false)).toBe(true);
  });

  it('rejects untagged weakly-related statements', () => {
    expect(statementSupportedBy('公司总部位于上海市浦东新区世纪大道。', evidence, false)).toBe(false);
  });

  it('treats whitespace-insensitive number matching (spaces inside evidence)', () => {
    const spaced = ['响应时间 800 毫秒，可用性不低于 99.95 %。'];
    expect(statementSupportedBy('响应时间800毫秒[1]，可用性99.95%[1]。', spaced, true)).toBe(true);
  });
});

describe('documentCurrentlyEffective', () => {
  it('excludes repealed editions', () => {
    expect(documentCurrentlyEffective({ lifecycleStatus: 'repealed' })).toBe(false);
  });

  it('excludes editions not yet in force', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(documentCurrentlyEffective({ effectiveFrom: future })).toBe(false);
  });

  it('excludes editions whose effective window has closed', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(documentCurrentlyEffective({ effectiveTo: past })).toBe(false);
  });

  it('keeps in-force and metadata-less editions eligible', () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    expect(documentCurrentlyEffective({ effectiveFrom: from, effectiveTo: to })).toBe(true);
    expect(documentCurrentlyEffective({})).toBe(true);
  });
});
