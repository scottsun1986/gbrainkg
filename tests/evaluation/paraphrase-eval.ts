/**
 * Paraphrase held-out evaluation (generalization / anti-overfitting).
 *
 * The golden dataset was authored by the same team that tuned retrieval, so its
 * surface forms can be memorised. This tool generates UNSEEN paraphrases of each
 * golden question with an independent LLM and checks that the SAME anchors
 * (keywords / expected documents / refusal) still hold. Passing on unseen
 * surface forms is evidence the retrieval generalises rather than pattern-matches.
 *
 * Usage:
 *   LLMWIKI_TOKEN=<jwt> npx tsx tests/evaluation/paraphrase-eval.ts
 * Env:
 *   PARAPHRASE_LIMIT=12        questions to paraphrase (cost bound)
 *   PARAPHRASE_PER_QUESTION=2  paraphrases per question
 *   API_BASE=http://127.0.0.1:3202
 */
import fs from 'fs';
import path from 'path';
import { llmChat, extractJson } from './llm-client';

interface GoldenCase {
  id: string;
  category: string;
  question: string;
  expected_document_titles: string[];
  expected_keywords: string[];
  expected_no_answer: boolean;
  unauthorized_users?: string[];
}

const API_BASE = (process.env.API_BASE || process.env.API_URL || 'http://127.0.0.1:3202').replace(/\/$/, '');
const TOKEN = process.env.LLMWIKI_TOKEN || process.env.AUTH_TOKEN || '';
const LIMIT = Math.max(1, Number(process.env.PARAPHRASE_LIMIT || 12));
const PER = Math.max(1, Number(process.env.PARAPHRASE_PER_QUESTION || 2));
const RESULTS_DIR = path.join(__dirname, 'results');
const REFUSALS = ['未包含相关信息', '无法回答', '无法根据知识库回答'];

async function ask(question: string): Promise<{ answer: string; titles: string[] }> {
  const response = await fetch(`${API_BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ message: question }),
    signal: AbortSignal.timeout(120000),
  });
  const out = { answer: '', titles: [] as string[] };
  if (response.status !== 200 && response.status !== 201) return out;
  const text = await response.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const d = JSON.parse(payload);
      if (d.type === 'delta' && d.content) out.answer += d.content;
      else if (d.type === 'citation' && d.timeline_entry) out.titles.push(d.timeline_entry.doc_title || '');
    } catch { /* partial */ }
  }
  return out;
}

async function paraphrases(question: string): Promise<string[]> {
  const prompt = `将下面的问题改写为 ${PER} 个语义完全相同但措辞不同的中文问句（口语化/书面化各一亦可）。只输出 json：{"items":["...","..."]}。不得改变事实与范围。\n问题：${question}`;
  try {
    const text = await llmChat([{ role: 'user', content: prompt }], { maxTokens: 600, timeoutMs: 30000 });
    const parsed = extractJson<{ items?: string[] }>(text);
    return (parsed?.items || []).map((s) => String(s).trim()).filter((s) => s.length >= 4).slice(0, PER);
  } catch {
    return [];
  }
}

function anchorsHold(c: GoldenCase, r: { answer: string; titles: string[] }): boolean {
  if (c.expected_no_answer) {
    return REFUSALS.some((w) => r.answer.includes(w));
  }
  const kwOk = c.expected_keywords.length === 0 || c.expected_keywords.every((k) => r.answer.includes(k));
  const docOk = c.expected_document_titles.length === 0
    || c.expected_document_titles.some((t) => r.titles.some((rt) => rt.includes(t)));
  return kwOk && docOk;
}

async function main() {
  console.log('='.repeat(64));
  console.log(' Paraphrase held-out evaluation (unseen surface forms)');
  console.log('='.repeat(64));
  if (!TOKEN) { console.error('需要 LLMWIKI_TOKEN'); process.exit(2); }

  const dataset: GoldenCase[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'golden-dataset.json'), 'utf-8'),
  );
  // Prefer answerable + refusal categories (skip permission probes / multi-turn).
  const pool = dataset.filter((c) => ['clause_query', 'factual_precision', 'cross_document_synthesis', 'edge_cases', 'document_listing'].includes(c.category));
  const selected = pool.slice(0, LIMIT);

  const rows: any[] = [];
  let passed = 0;
  for (const c of selected) {
    const pars = await paraphrases(c.question);
    if (!pars.length) { console.log(`[SKIP] ${c.id} 无法生成改写`); continue; }
    let ok = true;
    const details: any[] = [];
    for (const p of pars) {
      const r = await ask(p);
      const hit = anchorsHold(c, r);
      ok = ok && hit;
      details.push({ paraphrase: p, hit, answer: r.answer.slice(0, 160) });
    }
    if (ok) passed += 1;
    console.log(`[${ok ? '✓' : '✗'}] ${c.id} [${c.category}] ${pars.length} 个未见改写均${ok ? '保持锚点' : '有失败'}`);
    rows.push({ id: c.id, category: c.category, pass: ok, details });
  }

  const total = rows.length;
  console.log('-'.repeat(64));
  console.log(`泛化通过 ${passed}/${total}（未见过问法）`);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(RESULTS_DIR, `paraphrase-eval-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ summary: { total, passed }, rows }, null, 2));
  console.log(`报告: ${out}`);
  process.exit(passed === total && total > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
