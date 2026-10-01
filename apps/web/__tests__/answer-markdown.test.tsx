import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerMarkdown } from '../src/components/chat/AnswerMarkdown';
import type { Citation } from '../src/types';

const sources = [{ citationIndex: 2, title: '授权原文', id: 'source-2' }] as Citation[];
const html = (content: string, citations = sources) => renderToStaticMarkup(<AnswerMarkdown content={content} sources={citations} />);

describe('answer Markdown structure and citation safety', () => {
  it('renders headings, paragraphs, nested lists, quotes and emphasis as semantic blocks', () => {
    const result = html('结论 **重要**。[2]\n\n## 依据\n\n第一段。\n第二行。\n\n3. 步骤三\n   - 子要点\n4. 步骤四\n\n> 原文说明\n\n---');
    for (const tag of ['<h2>', '<p>', '<strong>', '<br/>', '<ol start="3">', '<ul>', '<li>', '<blockquote>', '<hr/>']) assert.ok(result.includes(tag), tag);
    assert.ok(!result.includes('## 依据'));
  });
  it('repairs sentence-attached model headings while preserving code and links', () => {
    const result = html('结论[2]。## 现行版本\n\n说明。### 版本差异\n\n`示例。## 原样`\n\n```text\n示例。## 原样\n```\n\n[链接。## 原样](https://example.test)');
    assert.match(result, /<h2>现行版本<\/h2>/);
    assert.match(result, /<h3>版本差异<\/h3>/);
    assert.match(result, /<code>示例。## 原样<\/code>/);
    assert.ok(result.includes('链接。## 原样'));
    assert.ok(!html('转义。\\## 原样').includes('<h2>'));
  });

  it('separates sentence-attached bold section labels without changing inline emphasis or code', () => {
    const result = html('前节结论[2]。**现行有效版：《通用流程说明文档》（v2）**\n条款说明。**版本差异与适用关系**：差异说明。');
    assert.match(result, /<\/p><p><strong>现行有效版/);
    assert.match(result, /<\/p><p><strong>版本差异与适用关系/);
    const list = html('- 当前条款[2]。**旧版说明**\n旧版条款。');
    assert.match(list, /<\/ul><p><strong>旧版说明/);
    assert.ok(!html('普通句。**重点**仍是同一段。').includes('</p><p>'));
    assert.match(html('`示例。**标题**`'), /<code>示例。\*\*标题\*\*<\/code>/);
  });

  it('renders GFM tables with alignments, inline citations and a focusable scroll region', () => {
    const result = html('| 项目 | 数值 |\n| --- | ---: |\n| 甲[2] | 30 |');
    assert.match(result, /role="region"/);
    assert.match(result, /<thead>/);
    assert.match(result, /scope="col"/);
    assert.match(result, /text-align:right/);
    assert.match(result, /查看来源 2/);
  });
  it('binds only this message’s exact source index; numbers and unknown citations remain text', () => {
    const result = html('支持[2]，未知[1]，年份[2026]。');
    assert.equal((result.match(/<button/g) || []).length, 1);
    assert.ok(result.includes('[1]') && result.includes('[2026]'));
    assert.ok(!html('旧答案[2]', []).includes('<button'));
  });
  it('preserves code whitespace without converting code or link labels to citation buttons', () => {
    const result = html('`a[2]`\n\n```python\n  x = "[2]"\n  print(x)\n```\n\n[链接[2]](https://example.test)');
    assert.ok(!result.includes('<button'));
    assert.ok(result.includes('  x = &quot;[2]&quot;\n  print(x)'));
    assert.match(result, /rel="noopener noreferrer"/);
  });
  it('never executes model HTML, dangerous URLs, or remote image requests', () => {
    const result = html('<script>alert(1)</script>\n\n[坏链接](javascript:alert%281%29)\n\n![外链](https://tracking.test/pixel)');
    assert.ok(!result.includes('<script>') && !result.includes('<img') && !result.includes('href="javascript:'));
    assert.ok(result.includes('&lt;script&gt;'));
    assert.ok(!html('[坏链接](data:text/html,evil)').includes('href="data:'));
  });
  it('handles partial streaming Markdown and Unicode without dropping or fabricating text', () => {
    const sample = '结论😀[2]\n\n## 要点\n\n- 条目\n\n```js\nconst a = 1;\n```';
    for (let end = 1; end <= sample.length; end++) assert.doesNotThrow(() => html(sample.slice(0, end)));
    const result = html('A &amp; B &lt; C &#x1f600;');
    assert.ok(result.includes('A &amp; B &lt; C 😀'));
  });
});
