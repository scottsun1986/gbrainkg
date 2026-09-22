#!/usr/bin/env node
/**
 * End-to-end SOTA evaluation against a live instance.
 *
 * Replays real user questions (sampled read-only from the message history)
 * through the chat stream and records, per question:
 *
 *   first-token latency, total latency, answer length, citation count,
 *   refusal or not, grounding-gate and citation-rebinding outcomes.
 *
 *   SOTA_API_BASE=http://127.0.0.1:3000 SOTA_PASSWORD=... \
 *     npx tsx scripts/sota-live-eval.ts --questions=20 --out=/tmp/sota-live.json
 *
 * Ordering guarantees the load profile stays gentle: questions run strictly
 * one at a time, so a small production box is never hit concurrently.
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

const API_BASE = (process.env.SOTA_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const USER = process.env.SOTA_USER || process.env.TEST_USER || 'admin';
const PASSWORD = process.env.SOTA_PASSWORD || process.env.TEST_PASSWORD || '';

function argValue(name: string, fallback?: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

const REFUSAL = /(未包含相关信息|无法(?:根据知识库)?回答|不知道|无法提供(?:该信息)?|not available|no information)/;

async function login(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`);
  const payload: any = await response.json();
  return payload.token;
}

interface AskResult {
  answer: string;
  citations: Array<{ doc_title?: string; score?: number }>;
  firstTokenMs: number | null;
  totalMs: number;
  trace: Record<string, { status: string; summary?: string }>;
  error?: string;
}

async function ask(
  token: string,
  question: string,
  timeoutMs = Number(process.env.SOTA_TIMEOUT_MS || 300_000),
): Promise<AskResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result: AskResult = {
    answer: '',
    citations: [],
    firstTokenMs: null,
    totalMs: 0,
    trace: {},
  };
  try {
    const response = await fetch(`${API_BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: question, kb_scope: 'all' }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'delta' || event.type === 'answer') {
            const chunk = String(event.content || event.delta || '');
            if (chunk) {
              if (result.firstTokenMs === null) result.firstTokenMs = Date.now() - started;
              result.answer += chunk;
            }
          } else if (event.type === 'citation') {
            const entry = event.timeline_entry || event.citation || {};
            result.citations.push({ doc_title: entry.doc_title, score: entry.score });
          } else if (event.type === 'trace' && event.node) {
            result.trace[event.node.id] = { status: event.node.status, summary: event.node.summary };
          } else if (event.type === 'error') {
            result.error = String(event.content || 'error');
          }
        } catch {
          // keep-alive or partial payload
        }
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    result.totalMs = Date.now() - started;
  }
  return result;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(((p / 100) * (sorted.length - 1))))];
}

async function main(): Promise<void> {
  const questionCount = Number(argValue('questions', '20'));
  const out = argValue('out');
  const lookbackDays = Number(argValue('lookback-days', '14'));
  const prisma = new PrismaClient();
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
    const rows: Array<{ content: string }> = await prisma.$queryRaw`
      SELECT DISTINCT ON (md5(content)) content
      FROM "Message"
      WHERE role = 'user'
        AND "createdAt" >= ${since}
        AND length(content) BETWEEN 6 AND 80
        AND content ~ '[？?]|什么|如何|怎么|哪些|多少|是否|who|what|how'
      ORDER BY md5(content), "createdAt" DESC
      LIMIT ${questionCount}
    `;
    if (!rows.length) {
      console.log('no real user questions found in the lookback window');
      return;
    }
    const token = await login();
    const results: any[] = [];
    for (const row of rows) {
      const question = String(row.content).replace(/\s+/g, ' ').trim();
      const asked = await ask(token, question);
      const refused = REFUSAL.test(asked.answer) && asked.answer.trim().length <= 120;
      results.push({
        question: question.slice(0, 80),
        refused,
        answerChars: asked.answer.length,
        citations: asked.citations.length,
        firstTokenMs: asked.firstTokenMs,
        totalMs: asked.totalMs,
        rebinding: asked.trace.citation_rebinding?.status,
        groundingGate: asked.trace.grounding_gate?.summary,
        citationValidation: asked.trace.citation_validation?.summary,
        error: asked.error,
      });
      console.log(
        `${asked.error ? 'ERR' : refused ? 'REFUSE' : 'ANSWER'} ${asked.totalMs}ms ` +
          `cites=${asked.citations.length} chars=${asked.answer.length} rebind=${asked.trace.citation_rebinding?.status || '-'} :: ${question.slice(0, 40)}`,
      );
    }

    const answered = results.filter((r) => !r.refused && !r.error);
    const summary = {
      generatedAt: new Date().toISOString(),
      apiBase: API_BASE,
      questions: results.length,
      answered: answered.length,
      refusals: results.filter((r) => r.refused).length,
      errors: results.filter((r) => r.error).length,
      latencyMs: {
        firstTokenP50: percentile(answered.map((r) => r.firstTokenMs || 0), 50),
        firstTokenP95: percentile(answered.map((r) => r.firstTokenMs || 0), 95),
        totalP50: percentile(answered.map((r) => r.totalMs), 50),
        totalP95: percentile(answered.map((r) => r.totalMs), 95),
      },
      citationsPerAnswer: Number(
        (answered.reduce((sum, r) => sum + r.citations, 0) / Math.max(answered.length, 1)).toFixed(2),
      ),
      rebindingTriggered: results.filter((r) => r.rebinding === 'warning').length,
      results,
    };
    const text = JSON.stringify(summary, null, 2);
    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
    if (out) writeFileSync(out, `${text}\n`, 'utf8');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
