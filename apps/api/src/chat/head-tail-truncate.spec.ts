import { smartTruncateChunkText, truncateChunkToTokenBudget, truncateKeepingHeadAndTail } from './chat.service';

/**
 * Documents put their summary at the END: a 2000-row assessment table closes
 * with a「## 汇总」sheet whose row carries the anchor value. Head-only truncation
 * removed that sheet entirely, so the evidence was selected and cited but the
 * anchor never reached the model and the question was refused (P2-03).
 */
describe('truncateKeepingHeadAndTail', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => `| 考核项${i} | ${90 - (i % 10)} | 4% | 优 | 人工 |`).join('\n');

  it('returns the text untouched when it fits', () => {
    expect(truncateKeepingHeadAndTail('short text', 100)).toBe('short text');
  });

  it('keeps the trailing summary sheet that carries the anchor', () => {
    const text = [
      '## 考核表',
      '| 序号 | 项目 | 得分 |',
      '| --- | --- | --- |',
      rows(400),
      '## 汇总',
      '| 统计项 | 数值 |',
      '| --- | --- |',
      '| 总记录 | 2000 |',
      '| 锚点事实 | XLSX-KEY-汇总表编号SUM-2026-5566 |',
    ].join('\n');

    const out = truncateKeepingHeadAndTail(text, 1200);
    expect(out).toContain('## 汇总');
    expect(out).toContain('SUM-2026-5566');
    expect(out).toContain('考核表');
    expect(out.length).toBeLessThanOrEqual(1200 + 60);
  });

  it('never cuts a table row in half at either end', () => {
    const text = ['## 汇总', '| 统计项 | 数值 |', rows(300)].join('\n');
    const out = truncateKeepingHeadAndTail(text, 400);
    for (const line of out.split('\n')) {
      if (line.startsWith('|')) expect(line).toMatch(/^\|.*\|$/);
    }
  });

  it('falls back to the legacy head cut when there is no room for a tail', () => {
    const text = 'x'.repeat(500);
    expect(truncateKeepingHeadAndTail(text, 30)).toBe(smartTruncateChunkText(text, 30));
  });

  it('elides the middle, not the end', () => {
    const text = `${'A'.repeat(300)}\n${'B'.repeat(300)}\n${'C'.repeat(300)}`;
    const out = truncateKeepingHeadAndTail(text, 200);
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('C')).toBe(true);
    expect(out).toContain('超出篇幅限制');
  });
});

describe('truncateChunkToTokenBudget uses head+tail', () => {
  it('preserves the anchor at the end of an oversized chunk', () => {
    const text = [
      '## 考核表',
      '| 序号 | 项目 |',
      Array.from({ length: 600 }, (_, i) => `| 考核项${i} | ${i} |`).join('\n'),
      '## 汇总',
      '| 锚点事实 | SUM-2026-5566 |',
    ].join('\n');
    const out = truncateChunkToTokenBudget(text, 400);
    expect(out).toContain('SUM-2026-5566');
  });
});