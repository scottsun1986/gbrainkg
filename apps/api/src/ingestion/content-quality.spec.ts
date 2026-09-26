import { assessContentQuality } from './content-quality';

describe('publication quality gate (empty-only hard stop)', () => {
  it('rejects only when no extractable text', () => {
    expect(assessContentQuality('![description](asset.png)', '.pptx').quality_status).toBe('rejected');
    expect(assessContentQuality('', '.docx').quality_status).toBe('rejected');
    expect(assessContentQuality('<!-- image -->', '.pptx').quality_status).toBe('rejected');
  });

  it('never upgrades a rejected parser result', () => {
    expect(assessContentQuality('有效文字'.repeat(20), '.pdf', { quality_status: 'rejected' }).quality_status).toBe('rejected');
  });

  it('passes encoding damage instead of holding for review', () => {
    const result = assessContentQuality('合同条款' + '\ufffd'.repeat(20), '.txt', {
      engine: 'anydoc', quality_status: 'passed', quality_score: 1,
    });
    expect(result.quality_status).toBe('passed');
    expect(result.quality_score).toBeLessThan(1);
    expect(result.quality_rule_version).toBe('content-v2');
  });

  it('passes control characters instead of holding for review', () => {
    expect(assessContentQuality('有效内容\0\0', '.md').quality_status).toBe('passed');
  });

  it('passes short binary extraction instead of holding for review', () => {
    expect(assessContentQuality('只有一点文字', '.pdf').quality_status).toBe('passed');
  });

  it('passes unresolved image placeholders instead of holding for review', () => {
    const result = assessContentQuality('正文内容足够长可以过最低字数限制。<!-- image: docx-media-1 -->', '.docx');
    expect(result.quality_status).toBe('passed');
  });

  it('passes residual placeholders after successful image OCR', () => {
    const md = '正文内容足够长可以过最低字数限制。\n\n## 图片文字（OCR）\n\n网关节点部署于核心区\n\n<!-- image: docx-media-9 -->\n*(装饰性小图，跳过 OCR)*';
    const result = assessContentQuality(md, '.docx', { ocr_image_count: 46, embedded_image_count: 47 });
    expect(result.quality_status).toBe('passed');
  });

  it('supports multilingual plaintext', () => {
    expect(assessContentQuality('日本語 한국어 العربية', '.txt').quality_status).toBe('passed');
  });

  it.each([0.2, 'NaN', '', 75, false])('passes uncertain OCR confidence %p', value => {
    expect(assessContentQuality('有效文字'.repeat(20), '.pdf', { ocr_average_confidence: value }).quality_status).toBe('passed');
  });

  it('passes clause numbering duplicates and gaps', () => {
    const markdown = `
      第一条 总则
      第二条 定义
      第二条 重复定义
      第十五条 跳空
    `;
    expect(assessContentQuality(markdown, '.txt').quality_status).toBe('passed');
  });

  it('passes table structure issues', () => {
    const markdown = `
| col1 | col2 | col3 | col4 |
| --- | --- | --- | --- |
| val1 | val2 | val3 | val4 |
| broken |
    `;
    expect(assessContentQuality(markdown, '.md').quality_status).toBe('passed');
  });

  it('passes low page coverage ratio', () => {
    expect(assessContentQuality('有效文字'.repeat(20), '.pdf', { page_count: 10, text_pages: 3 }).quality_status).toBe('passed');
  });

  it('still records metrics for observability', () => {
    const res = assessContentQuality('有效文字'.repeat(20), '.pdf', { page_count: 10, text_pages: 3 });
    expect(res.quality_metrics.meaningful_characters).toBeGreaterThan(0);
    expect(res.quality_status).toBe('passed');
  });
});
