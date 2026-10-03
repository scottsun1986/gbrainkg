import { distinctRankedPassages, evidenceIdentity } from './evidence-identity';

describe('passage diversity before candidate quota', () => {
  it('does not merge different values after a shared introduction', () => {
    const intro = '统一的企业标准与员工行为规则'.repeat(8);
    expect(evidenceIdentity(intro + '上午08:30')).not.toBe(evidenceIdentity(intro + '上午09:00'));
  });
  it('lets a different rule survive many identical copies', () => {
    const copies = Array.from({ length: 30 }, (_, i) => ({ id: `copy-${i}`, text: '<!-- 大纲层级: 总则 -->\n第三条 上午08:30' }));
    const selected = distinctRankedPassages([...copies, { id: 'different', text: '第三条 上午09:00' }], c => c.text).slice(0, 15);
    expect(selected.map(c => c.id)).toEqual(['copy-0', 'different']);
  });
  it('normalizes non-factual parser decorations without stripping facts', () => {
    expect(evidenceIdentity('<!-- 页码: 1 -->\\## 第一章 总则')).toBe(evidenceIdentity('## 第一章 总则'));
    expect(evidenceIdentity('上午09:00；下午18:00')).not.toBe(evidenceIdentity('上午09:00；下午17:00'));
  });
});
