/**
 * Human review sampling export.
 *
 * Runs a sample of golden questions (including any stored Bad Cases) against the
 * live API and writes a scoring sheet (Markdown + JSON with blank human fields)
 * so a human can independently grade answer correctness / citation fidelity.
 * This is the human-in-the-loop half of evaluation independence.
 *
 * Usage:
 *   LLMWIKI_TOKEN=<jwt> npx tsx tests/evaluation/export-human-review.ts
 * Env:
 *   HR_LIMIT=20   questions to sample
 */
import fs from 'fs';
import path from 'path';

const API_BASE = (process.env.API_BASE || process.env.API_URL || 'http://127.0.0.1:3202').replace(/\/$/, '');
const TOKEN = process.env.LLMWIKI_TOKEN || process.env.AUTH_TOKEN || '';
const LIMIT = Math.max(1, Number(process.env.HR_LIMIT || 20));
const RESULTS_DIR = path.join(__dirname, 'results');

interface GoldenCase {
  id: string; category: string; question: string;
  expected_document_titles: string[]; expected_keywords: string[]; expected_no_answer: boolean;
}

async function ask(question: string): Promise<{ answer: string; titles: string[]; stages: number }> {
  const response = await fetch(`${API_BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ message: question }),
    signal: AbortSignal.timeout(120000),
  });
  const out = { answer: '', titles: [] as string[], stages: 0 };
  if (response.status !== 200 && response.status !== 201) return out;
  const text = await response.text();
  const traceIds = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const d = JSON.parse(payload);
      if (d.type === 'delta' && d.content) out.answer += d.content;
      else if (d.type === 'citation' && d.timeline_entry) out.titles.push(d.timeline_entry.doc_title || '');
      else if (d.type === 'trace' && d.node?.id) traceIds.add(d.node.id);
    } catch { /* partial */ }
  }
  out.stages = traceIds.size;
  return out;
}

async function main() {
  if (!TOKEN) { console.error('需要 LLMWIKI_TOKEN'); process.exit(2); }
  const dataset: GoldenCase[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'golden-dataset.json'), 'utf-8'),
  );
  const sample = dataset.slice(0, LIMIT);
  const rows: any[] = [];
  for (const c of sample) {
    const r = await ask(c.question);
    rows.push({
      id: c.id, category: c.category, question: c.question,
      expected_keywords: c.expected_keywords, expected_documents: c.expected_document_titles,
      expected_no_answer: c.expected_no_answer,
      answer: r.answer, citations: [...new Set(r.titles)], traceStages: r.stages,
      humanScore: null, humanNotes: '',
    });
    console.log(`[export] ${c.id} (${c.category}) 回答 ${r.answer.length} 字 / 引用 ${new Set(r.titles).size}`);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(RESULTS_DIR, `human-review-${stamp}.json`);
  const mdPath = path.join(RESULTS_DIR, `human-review-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ createdAt: stamp, api: API_BASE, rows }, null, 2));

  const md = [
    `# 人工抽检评阅表 (${stamp})`,
    '',
    '> 评分建议：答案正确性(0-5)、引用支撑度(0-5)、是否幻觉(是/否)。请在 JSON 的 humanScore/humanNotes 填写。',
    '',
    '| 用例 | 类别 | 问题 | 期望要点 | 模型回答(截断) | 引用 | 评分 |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.category} | ${r.question.replace(/\|/g, '/')} | ${(r.expected_keywords || []).join('、')} | ${String(r.answer).replace(/\n/g, ' ').slice(0, 80)} | ${r.citations.slice(0, 3).join('、')} |  |`),
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
