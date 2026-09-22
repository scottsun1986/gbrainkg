import { hammingDistance, isNearDuplicate, detectLanguage, redactPii, scanPii, simhash64 } from './content-dedupe';

describe('content-dedupe', () => {
  it('computes stable simhash and detects near duplicates', () => {
    const a = simhash64('员工考勤管理制度规定工作时间为上午九点至下午六点弹性打卡。');
    const b = simhash64('员工考勤管理制度规定工作时间为上午九点至下午六点弹性打卡');
    const c = simhash64('量子抗性加密与双向握手延迟指标体系完全不同的文本内容示例。');
    expect(typeof a).toBe('bigint');
    expect(isNearDuplicate(a, b)).toBe(true);
    expect(hammingDistance(a, c)).toBeGreaterThan(3);
  });

  it('flags and redacts PII', () => {
    const text = '联系人张三 13800138000 邮箱 a.b@example.com 身份证 11010519491231002X';
    const findings = scanPii(text);
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toContain('phone_cn');
    expect(kinds).toContain('email');
    expect(kinds).toContain('id_cn');
    const { text: redacted } = redactPii(text);
    expect(redacted).not.toContain('13800138000');
    expect(redacted).toContain('[REDACTED:phone_cn]');
    expect(redacted).toContain('[REDACTED:email]');
  });

  it('detects languages', () => {
    expect(detectLanguage('这是一段中文内容用于语言检测测试。')).toBe('zh');
    expect(detectLanguage('This is an English paragraph used for language detection.')).toBe('en');
    expect(detectLanguage('知识库产品 English documentation 混合内容示例 test case')).toBe('mixed');
    expect(detectLanguage('....')).toBe('unknown');
  });
});
