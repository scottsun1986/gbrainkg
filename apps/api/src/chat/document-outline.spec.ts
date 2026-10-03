import { chapterHeadings, normalizeDocumentTitle, outlineDocumentTitle, renderDocumentOutline } from './document-outline';

describe('exhaustive named document outline', () => {
  it('extracts the named document without the request wording', () => {
    expect(outlineDocumentTitle('请列出《企业考勤管理制度详细手册》的全部章名')).toBe('企业考勤管理制度详细手册');
    expect(outlineDocumentTitle('List all chapters in "Operations Guide"')).toBe('Operations Guide');
    expect(outlineDocumentTitle('比较《甲》和《乙》的所有章节')).toBeNull();
    expect(outlineDocumentTitle('《指南》第二章规定是什么')).toBeNull();
    expect(outlineDocumentTitle('List all headings in \"Operations Guide\"')).toBeNull();
    expect(normalizeDocumentTitle('Operations Guide.DOCX')).toBe(normalizeDocumentTitle('Operations Guide'));
  });
  it('reads escaped office headings through the last chapter, without prose or code examples', () => {
    const chapters = ['第一章 总则', '第二章 时间', '第三章 方式', '第四章 处理', '第五章 假期', '第六章 加班', '第七章 奖惩', '第八章 附则'];
    expect(chapterHeadings(chapters.map(x => `\\## ${x}\n正文`).join('\n'))).toEqual(chapters);
    expect(chapterHeadings('正文引用第二章要求。\n```md\n## 第九章 代码示例\n```\n## 第八章 附则')).toEqual(['第八章 附则']);
  });
  it('keeps per-heading immutable evidence indices and distinguishes same-title libraries', () => {
    expect(renderDocumentOutline([
      { docId: 'a', docTitle: '指南', kbName: '甲', context: '## 第一章 总则' },
      { docId: 'a', docTitle: '指南', kbName: '甲', context: '## 第八章 附则' },
      { docId: 'b', docTitle: '指南', kbName: '乙', context: '## Chapter 1 Scope' },
    ])).toBe('### 《指南》（甲）\n\n- 第一章 总则 [1]\n- 第八章 附则 [2]\n\n### 《指南》（乙）\n\n- Chapter 1 Scope [3]');
  });
});
