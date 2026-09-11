import { assessContentQuality } from './content-quality';

describe('authoritative publication quality gate', () => {
  it.each(['plaintext-fastpath', 'anydoc', 'ocr'])('does not trust success from %s', engine => {
    const result = assessContentQuality('合同条款' + '\ufffd'.repeat(20), '.txt', {
      engine, quality_status: 'passed', quality_score: 1,
    });
    expect(result.quality_status).toBe('needs_review');
    expect(result.quality_score).toBeLessThan(1);
    expect(result.quality_rule_version).toBe('content-v2');
  });
  it('detects controls before ingestion normalizes them', () => {
    expect(assessContentQuality('有效内容\0\0', '.md').quality_status).toBe('needs_review');
  });
  it('rejects image-only content', () => {
    expect(assessContentQuality('![description](asset.png)', '.pptx').quality_status).toBe('rejected');
  });
  it('keeps short binary extraction for review', () => {
    expect(assessContentQuality('只有一点文字', '.pdf').quality_status).toBe('needs_review');
  });
  it('supports multilingual plaintext', () => {
    expect(assessContentQuality('日本語 한국어 العربية', '.txt').quality_status).toBe('passed');
  });
  it.each([0.2, 'NaN', '', 75, false])('reviews uncertain OCR confidence %p', value => {
    expect(assessContentQuality('有效文字'.repeat(20), '.pdf', { ocr_average_confidence: value }).quality_status).toBe('needs_review');
  });
  it('never upgrades a rejected parser result', () => {
    expect(assessContentQuality('有效文字'.repeat(20), '.pdf', { quality_status: 'rejected' }).quality_status).toBe('rejected');
  });

  it('detects duplicate clause numbering and gaps', () => {
    const markdown = `
      第一条 总则
      第二条 定义
      第二条 重复定义
      第十五条 跳空
    `;
    const res = assessContentQuality(markdown, '.txt');
    expect(res.quality_issues).toContain('存在重复的条款编号（如第二条）');
    expect(res.quality_issues).toContain('条款编号存在明显跳空断层');
    expect(res.quality_status).toBe('needs_review');
  });

  it('detects table structure integrity issues', () => {
    const markdown = `
| col1 | col2 | col3 | col4 |
| --- | --- | --- | --- |
| val1 | val2 | val3 | val4 |
| broken |
    `;
    const res = assessContentQuality(markdown, '.md');
    expect(res.quality_issues).toContain('检测到表格结构不完整或存在截断');
  });

  it('detects low page coverage ratio', () => {
    const res = assessContentQuality('有效文字'.repeat(20), '.pdf', { page_count: 10, text_pages: 3 });
    expect(res.quality_issues).toContain('页面文字覆盖率偏低 (3/10)，可能存在未识别的扫描页面');
    expect(res.quality_status).toBe('needs_review');
  });

  it('credits OCR recognized pages towards page coverage ratio', () => {
    const res = assessContentQuality('有效文字'.repeat(50), '.pdf', {
      page_count: 20,
      text_pages: 0,
      ocr_cost_pages: 20,
      ocr_provider: 'baidu',
    });
    expect(res.quality_issues).not.toContain('页面文字覆盖率偏低 (0/20)，可能存在未识别的扫描页面');
    expect(res.quality_status).toBe('passed');
  });
});

