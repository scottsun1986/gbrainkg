import { assessExtendedQuality } from './content-quality';

describe('assessExtendedQuality', () => {
  it('flags PII as needs_review and records language + simhash', () => {
    const md = '联系人：张三 13800138000\n本办法规定安全冗余与技术加密要求。';
    const result = assessExtendedQuality(md);
    expect(result.language).toBe('zh');
    expect(result.piiFindings.length).toBeGreaterThan(0);
    expect(result.status).toBe('needs_review');
    expect(result.simhash).toMatch(/^0x[0-9a-f]+$/);
    expect(result.issues[0]).toMatch(/个人信息/);
  });

  it('passes clean text', () => {
    const result = assessExtendedQuality('本手册规定考勤与休假制度，不含任何联系方式。');
    expect(result.piiFindings).toHaveLength(0);
    expect(result.status).toBe('passed');
  });
});
