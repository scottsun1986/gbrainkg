import { isDocumentInventoryQuery, numericClaimsOf, statementSupportedBy, documentCurrentlyEffective } from './chat.service';

describe('isDocumentInventoryQuery', () => {
  it('matches count/catalogue intents in either order', () => {
    expect(isDocumentInventoryQuery('知识库里有多少文档？')).toBe(true);
    expect(isDocumentInventoryQuery('所有文档的清单给我一下')).toBe(true);
  });

  it('matches the E2E "列出所有文档标题" shape that used to fall through', () => {
    expect(isDocumentInventoryQuery('请列出本知识库中所有文档的标题。')).toBe(true);
    expect(isDocumentInventoryQuery('列出全部文档的清单')).toBe(true);
  });

  it('does not misfire on ordinary fact questions', () => {
    expect(isDocumentInventoryQuery('住宿费标准是每晚多少钱？')).toBe(false);
    expect(isDocumentInventoryQuery('第一章规定了什么？')).toBe(false);
    expect(isDocumentInventoryQuery('汇总表编号是多少？')).toBe(false);
  });
});

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

  it('rejects statement with flipped comparison polarity (higher vs lower)', () => {
    const limitDoc = ['飞行器飞行高度不得高于 800 米。'];
    expect(statementSupportedBy('飞行器飞行高度不得低于 800 米[1]。', limitDoc, true)).toBe(false);
  });

  it('correctly strips contextual prefix from evidence when evaluating support', () => {
    const prefixed = ['[上下文: 考勤制度补充说明]\n\n员工迟到一次扣款 50 元。'];
    expect(statementSupportedBy('员工迟到一次扣款 50 元[1]。', prefixed, true)).toBe(true);
  });

  it('rejects fabricated Chinese prose that merely reuses common characters', () => {
    // Character overlap alone is weak for Chinese: "迟到一次罚款100元并通报批评"
    // shares enough individual characters with the evidence to clear the 0.40
    // character bar, but none of the fabricated phrases (罚款/通报/批评) exist
    // in the evidence. The Han-bigram check must reject it.
    const fabricated = '员工迟到一次罚款 100 元并通报批评[1]。';
    expect(statementSupportedBy(fabricated, evidence, true)).toBe(false);
  });

  it('still accepts natural paraphrase under the bigram check', () => {
    // Word order differs from the evidence ("迟到会扣款" vs "迟到…扣款"),
    // yet the phrase-level bigrams (迟到/扣款) are present.
    expect(statementSupportedBy('迟到会扣款 50 元[1]。', evidence, true)).toBe(true);
  });

  it('accepts honest paraphrase whose wording is absent but whose asserted anchors are verbatim', () => {
    // Real production case: the question asks 汇总表编号, the evidence row says
    // 锚点事实|XLSX-KEY-E2E-SUM-2026. The answer introduces 编号, a word the
    // evidence never uses, so its Han-bigram ratio is 0.40 — below the 0.45
    // bar. It must still pass on the relaxed branch because the identifier it
    // asserts appears verbatim (regression: this was refused as unsupported).
    const xlsxChunk = [
      '## Sheet',
      '|  |  |',
      '| --- | --- |',
      '| 考核汇总表 |  |',
      '| 锚点事实 | XLSX-KEY-E2E-SUM-2026 |',
      '| 总记录 | 2000 |',
    ].join('\n');
    expect(
      statementSupportedBy('汇总表编号为 XLSX-KEY-E2E-SUM-2026[1]。', [xlsxChunk], true),
    ).toBe(true);
  });

  it('still rejects a fabricated identifier riding the relaxed branch', () => {
    const xlsxChunk = [
      '| 考核汇总表 |  |',
      '| 锚点事实 | XLSX-KEY-E2E-SUM-2026 |',
      '| 总记录 | 2000 |',
    ].join('\n');
    expect(
      statementSupportedBy('汇总表编号为 XLSX-KEY-E2E-FAKE-9999[1]。', [xlsxChunk], true),
    ).toBe(false);
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
