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
    const result = html('结论[2]。\n\n**来源 1《X》**：依据。\n\n## 依据\n\n第一段。\n第二行。\n\n3. 步骤三\n   - 子要点\n4. 步骤四\n\n> 原文说明\n\n---');
    for (const tag of ['<h2>', '<p>', '<strong>', '<br/>', '<ol start="3">', '<ul>', '<li>', '<blockquote>', '<hr/>']) assert.ok(result.includes(tag), tag);
    assert.ok(!result.includes('## 依据'));
  });

  it('reserves bold for standalone labels and strips inline emphasis', () => {
    const result = html('资料记载有**业绩指标**和**行为指标**两部分[1]。');
    assert.ok(!result.includes('<strong>'));
    assert.ok(result.includes('业绩指标和行为指标'));
    // A bold label keeps its emphasis and opens its own block.
    const label = html('说明[1]。**来源《企业研发管理规范》**：研发人员考核采用…[3]');
    assert.match(label, /<\/p><p><strong>来源《企业研发管理规范》<\/strong>/);
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

  it('opens a new block for a source label that follows a citation marker or a hard break', () => {
    const afterCitation = html('前节结论[2] **来源《企业研发管理规范》**：研发人员考核…[3]');
    assert.match(afterCitation, /<\/p><p><strong>来源《企业研发管理规范》<\/strong>/);
    const afterBreak = html('前节结论[2]\n**来源《企业研发管理规范》**：研发人员考核…[3]');
    assert.match(afterBreak, /<\/p><p><strong>来源《企业研发管理规范》<\/strong>/);
    const afterSemicolon = html('原文表述：…[2]；**二、《企业研发管理规范》口径（适用范围）**');
    assert.match(afterSemicolon, /<\/p><p><strong>二、《企业研发管理规范》口径（适用范围）<\/strong>/);
    // Inline emphasis mid-sentence is untouched.
    assert.ok(!html('前节结论[2] **重点**仍是同一段。').includes('</p><p>'));
  });

  it('keeps standalone source headings bold when a scope qualifier follows the marker', () => {
    const result = html('**来源 1《A》**（适用范围）\n甲[2]。\n\n**来源 2《B》**（适用范围）：乙[2]。');
    assert.equal((result.match(/<strong>/g) || []).length, 2);
    assert.ok(result.includes('（适用范围）'));
    assert.equal((result.match(/<button/g) || []).length, 2);
    assert.ok(!html('**重点**（补充）仍是正文。').includes('<strong>'));
  });

  it('renders task checkboxes once without leaking Markdown markers', () => {
    const result = html('- [x] 已完成\n- [ ] 待处理');
    assert.equal((result.match(/type="checkbox"/g) || []).length, 2);
    assert.ok(!result.includes('[x]') && !result.includes('[ ]'));
    assert.match(result, /aria-label="已完成"/);
    assert.match(result, /aria-label="未完成"/);
  });

  it('renders GFM tables with alignments, inline citations and responsive column labels', () => {
    const result = html('| 项目 | 数值 |\n| --- | ---: |\n| 甲[2] | 30 |');
    assert.match(result, /role="region"/);
    assert.match(result, /<thead\b/);
    assert.match(result, /scope="col"/);
    assert.match(result, /answer-cell-label/);
    assert.ok(!result.includes("可横向滚动"));
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


it('keeps source row and cell order when a wide table becomes stacked entries', () => {
  const result = html('| A | B | C | D | E | F | G |\n|---|---|---|---|---|---|---|\n| first | second[2] | third | fourth | fifth | sixth | seventh |\n| eighth | ninth | tenth | eleventh | twelfth | thirteenth | fourteenth |');
  assert.match(result, /answer-table-stacked/);
  const values = [...result.matchAll(/class="answer-cell-value">([\s\S]*?)<\/span>/g)].map(m => m[1]);
  assert.equal(values.length, 14);
  assert.ok(values[0].includes('first') && values[4].includes('fifth') && values[7].includes('eighth'));
  assert.equal((result.match(/<button/g) || []).length, 1);
});

it('uses noninteractive, formatted-text labels when headers contain links and emphasis', () => {
  const result = html('| **字段** | [名称](https://example.test) | C |\n|---|---|---|\n| a | b | c |');
  assert.match(result, /aria-hidden="true">字段<\/span>/);
  assert.match(result, /aria-hidden="true">名称<\/span>/);
  assert.equal((result.match(/<a /g) || []).length, 1);
});
