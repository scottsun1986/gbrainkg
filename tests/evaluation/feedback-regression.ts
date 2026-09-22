#!/usr/bin/env node
/**
 * Replays every FeedbackCase that an administrator converted into a gold item.
 *
 * The audit's gap was not "negative feedback is dropped" (it already landed in
 * FeedbackCase) but that nothing replayed it. This harness asks the live API the
 * same question that was rated `not_useful`, and checks the new answer against
 * the correction recorded during triage:
 *
 *   - the answer must not be a refusal when a correction exists;
 *   - every keyword of the correction (or an explicit "expected:" list in the
 *     correction) must appear in the answer or its cited snippets;
 *   - the previously wrong answer fragment must not come back verbatim.
 *
 *   API_BASE=http://127.0.0.1:3202 TEST_USER=admin TEST_PASSWORD=... \
 *     npx --yes tsx@4.23.13 tests/evaluation/feedback-regression.ts
 *
 *   FEEDBACK_REPORT=docs/test-reports/feedback-regression.json ... (optional)
 *
 * With FEEDBACK_GATE=1 a regression exits non-zero, which is what a release
 * pipeline should use; the default run only reports.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3202').replace(/\/$/, '');
const USER = process.env.TEST_USER || 'admin';
const PASSWORD = process.env.TEST_PASSWORD || '';
const GATE = process.env.FEEDBACK_GATE === '1';
const LIMIT = Number(process.env.FEEDBACK_LIMIT || 50);
const REPORT = process.env.FEEDBACK_REPORT || '';

interface CaseRow {
  id: string;
  question: string;
  answer: string;
  correction: string | null;
}

export function correctionKeywords(correction: string): string[] {
  const explicit = correction.match(/expected\s*[:：]\s*(.+)$/im);
  const source = explicit ? explicit[1] : correction;
  return Array.from(
    new Set(
      source
        .split(/[\s,，、;；|]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && token.length <= 30)
        .filter((token) => !['expected'].includes(token.toLowerCase())),
    ),
  ).slice(0, 12);
}

export function evaluateAnswer(
  answer: string,
  evidence: string,
  previousAnswer: string,
  keywords: string[],
): { pass: boolean; reason: string } {
  const haystack = `${answer}\n${evidence}`.toLowerCase();
  const refusal = /无法回答|无法根据|未包含|没有找到|无法从|知识库中未|不足以回答|cannot answer/.test(answer);
  if (refusal) return { pass: false, reason: 'refusal' };
  const missing = keywords.filter((keyword) => !haystack.includes(keyword.toLowerCase()));
  if (missing.length) return { pass: false, reason: `missing:${missing.join('|')}` };
  const normalised = (text: string): string => text.replace(/\s+/g, '');
  if (previousAnswer && normalised(answer) === normalised(previousAnswer)) {
    return { pass: false, reason: 'identical-to-rejected-answer' };
  }
  return { pass: true, reason: 'ok' };
}

async function login(): Promise<string> {
  if (!PASSWORD) throw new Error('TEST_PASSWORD is required (admin credentials for the live API).');
  const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`);
  const payload: any = await response.json();
  return payload.token;
}

async function ask(token: string, question: string): Promise<{ answer: string; evidence: string }> {
  const response = await fetch(`${API_BASE}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: question, kbScope: 'all' }),
  });
  if (!response.ok || !response.body) throw new Error(`chat failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let evidence = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        if (typeof event.delta === 'string') answer += event.delta;
        if (typeof event.content === 'string') answer += event.content;
        if (typeof event.answer === 'string') answer += event.answer;
        if (Array.isArray(event.citations)) {
          evidence += event.citations
            .map((citation: any) => String(citation?.snippet || citation?.title || ''))
            .join('\n');
        }
      } catch {
        // ignore keep-alive / partial payloads
      }
    }
  }
  return { answer, evidence };
}

async function main(): Promise<void> {
  const token = await login();
  try {
    // Converted cases are read through the admin API rather than a direct
    // database connection so the harness runs from a CI runner that only has
    // network access to the deployment.
    const response = await fetch(
      `${API_BASE}/api/v1/admin/feedback-cases?status=converted&limit=${LIMIT}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`listing converted feedback cases failed: HTTP ${response.status}`);
    }
    const payload: any = await response.json();
    const cases: CaseRow[] = Array.isArray(payload?.cases) ? payload.cases : [];
    if (!cases.length) {
      console.log('No converted feedback cases found; nothing to replay.');
      return;
    }
    const results: any[] = [];
    let failed = 0;
    for (const row of cases) {
      const keywords = correctionKeywords(String(row.correction || ''));
      let outcome = { pass: false, reason: 'not-run' };
      let observed = '';
      try {
        const { answer, evidence } = await ask(token, row.question);
        observed = answer;
        outcome = evaluateAnswer(answer, evidence, row.answer, keywords);
      } catch (err) {
        outcome = { pass: false, reason: `error:${err instanceof Error ? err.message : String(err)}` };
      }
      if (!outcome.pass) failed += 1;
      results.push({
        caseId: row.id,
        question: row.question,
        keywords,
        pass: outcome.pass,
        reason: outcome.reason,
        answerPreview: observed.slice(0, 200),
      });
      console.log(`${outcome.pass ? '✅' : '❌'} ${row.question.slice(0, 60)} — ${outcome.reason}`);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      apiBase: API_BASE,
      total: cases.length,
      failed,
      passRate: (cases.length - failed) / cases.length,
      results,
    };
    if (REPORT) {
      mkdirSync(dirname(REPORT), { recursive: true });
      writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`Report written to ${REPORT}`);
    }
    if (GATE && failed > 0) {
      console.error(`❌ ${failed}/${cases.length} converted feedback cases regressed.`);
      process.exit(1);
    }
  } finally {
    // nothing to release: the harness talks HTTP only
  }
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    // Pure-function checks so the harness can be validated without a live API.
    const keywords = correctionKeywords('expected: 交通费 报销标准');
    if (keywords.join(',') !== '交通费,报销标准') throw new Error(`keywords: ${keywords.join(',')}`);
    if (evaluateAnswer('无法回答该问题', '', '', ['交通费']).pass) throw new Error('refusal must fail');
    if (!evaluateAnswer('交通费报销标准为 800 元', '交通费', 'old', ['交通费', '800']).pass) {
      throw new Error('supported answer must pass');
    }
    if (evaluateAnswer('old', '', 'old', []).pass) throw new Error('unchanged answer must fail');
    if (evaluateAnswer('交通费为 800 元', '', 'old', ['住宿费']).pass) throw new Error('missing keyword must fail');
    console.log('feedback-regression selftest OK');
    process.exit(0);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
