/** Offline visual fixture built from the real answer renderer and stylesheet.
 * Run from apps/web: npx tsx __tests__/answer-layout.fixture.tsx [output.html]
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { AnswerMarkdown } from '../src/components/chat/AnswerMarkdown';
import type { Citation } from '../src/types';

const content = [
  "结论：**先核对适用版本，再逐项执行**，关键数值与引用应放在同一条陈述中。[1]",
  "",
  "## 适用条件",
  "",
  "这是独立的说明段落，包含中文、English、数字 30% 和行内代码 `documentVersionId`。较长的回答应保留清楚的段落间距，而不是把所有内容堆成一段。",
  "这是一行明确保留的换行。",
  "",
  "### 执行步骤",
  "",
  "1. 确认文档有效期与当前权限。[1]",
  "   - 核对来源版本。",
  "   - 保留原文依据，不把摘要当原文。[2]",
  "2. 对照完整表格计算结果。",
  "",
  "> 原文摘录应与解释分开显示，引用仍可逐条打开。[2]",
  "",
  "## 对照表",
  "",
  "| 检查项 | 原文版本 | 适用时间 | 数值 | 单位 | 覆盖范围 | 状态 | 依据 |",
  "| --- | --- | --- | ---: | --- | --- | --- | --- |",
  "| 核心索引 | 2026-10-01 | 当前有效 | 100 | % | 全部授权内容 | 已验证 | [1] |",
  "| 增量变更 | 不可变版本 | 指定时点 | 10.25 | MB | 当前文档 | 待核对 | [2] |",
  "",
  "| 方案 | 时长 | 说明 |",
  "| --- | --- | --- |",
  "| 第一项 | 10 分钟 | 简短比较，桌面保留表格，手机逐项呈现。[1] |",
  "| 第二项 | 20 分钟 | 仍按原文顺序展示。[2] |",
  "",
  "| 属性 | 内容 |",
  "| --- | --- |",
  "| 标识符 | a-very-long-identifier-without-spaces-that-must-wrap-instead-of-expanding-the-answer |",
  "| 说明 | 两列表格在小屏幕仍保持自然换行，不需要拖动才能阅读完整内容。[1] |",
  "",
  "## 代码示例",
  "",
  "```json",
  "{",
  "  \"documentVersionId\": \"a-long-identifier-for-horizontal-scrolling-without-expanding-the-whole-chat-page\",",
  "  \"citation\": \"[1] is literal text inside code\"",
  "}",
  "```",
  "",
  "- [x] 已完成核对",
  "- [ ] 尚待复核",
  "",
  "参考[普通链接](https://example.test/reference)。未知编号 [2026] 不应变成来源按钮。",
  "",
  "<script>window.answerXss = true</script>",
].join('\n');
const sources = [{ id: 'one', citationIndex: 1, title: '原文一' }, { id: 'two', citationIndex: 2, title: '原文二' }] as Citation[];
const body = renderToStaticMarkup(<main className="chat-main"><div className="chat-inner"><article className="msg msg-ai"><div className="body"><div className="who">百纳 · 排版验收样例</div><AnswerMarkdown content={content} sources={sources} /></div></article></div></main>);
const css = readFileSync('src/app/globals.css', 'utf8').replace(/<\/style/gi, '<\\/style');
writeFileSync(process.argv[2] || '/tmp/gbrain-answer-layout.html', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>回答排版验收</title><style>${css}</style></head><body>${body}</body></html>`);

