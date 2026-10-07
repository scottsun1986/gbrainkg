/** Paired oracle-context generation experiment. This does not measure full
 * RAG retrieval or official leaderboard F1. Both arms receive identical gold
 * documents; only the final-generation multi-hop directive differs. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { llmChat, llmConfig } from './llm-client';
import { buildSourceContext, buildStaticAnswerRules, multiHopAnswerDirective } from '../../apps/api/src/chat/answer-prompt';
import { answerStyleRule } from '../../apps/api/src/chat/answer-style';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(__dirname, '../..');
const output = path.resolve(root, arg('--output', 'docs/validation/2026-10-07/optimization/paired-multihop-generation.json'));
const limit = Number(arg('--limit', '20'));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function answerTokens(text: string): string[] {
  return text.toLowerCase().replace(/\[\d+\]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(token => token && !['a', 'an', 'the'].includes(token));
}
export function answerF1(prediction: string, expected: string): number {
  const actual = answerTokens(prediction), gold = answerTokens(expected);
  if (!actual.length || !gold.length) return Number(actual.join(' ') === gold.join(' '));
  const counts = new Map<string, number>(); gold.forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
  let common = 0;
  actual.forEach(token => { if ((counts.get(token) || 0) > 0) { common++; counts.set(token, counts.get(token)! - 1); } });
  return common ? 2 * (common / actual.length) * (common / gold.length) / ((common / actual.length) + (common / gold.length)) : 0;
}

async function main() {
  if (!Number.isInteger(limit) || limit < 2 || limit > 200) throw new Error('Invalid paired sample limit');
  const config = llmConfig();
  if (!config) throw new Error('Configured test LLM is unavailable');
  const baselineSource = execFileSync('git', ['show', 'HEAD:apps/api/src/chat/chat.service.ts'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const start = baselineSource.indexOf('const staticSystemRules = ') + 'const staticSystemRules = '.length;
  const end = baselineSource.indexOf('\n\n      const dynamicDirectives', start);
  if (start < 25 || end < start) throw new Error('Baseline prompt boundary not found');
  // Trusted, checked-in prompt literal. No benchmark or provider text is evaluated.
  const baselineRules = new Function('isEnglishQuery', 'answerStyleRule', `return ${baselineSource.slice(start, end)}`)(true, answerStyleRule) as string;
  const candidateRules = buildStaticAnswerRules(true);
  const cases: any[] = [];
  const skipped: any[] = [];
  for (const dataset of ['hotpot', 'musique']) {
    const dir = path.join(root, 'tests/evaluation/intl-benchmark');
    const questions = JSON.parse(fs.readFileSync(path.join(dir, `${dataset}_eval_set.json`), 'utf8'));
    const corpus = JSON.parse(fs.readFileSync(path.join(dir, `corpus/${dataset}_corpus.json`), 'utf8'));
    const byTitle = new Map<string, string>();
    corpus.forEach((document: any) => byTitle.set(document.title, [byTitle.get(document.title), document.text].filter(Boolean).join('\n')));
    const target = dataset === 'hotpot' ? Math.ceil(limit / 2) : Math.floor(limit / 2);
    let selected = 0;
    for (const question of [...questions].sort((a: any, b: any) => hash(a.qid).localeCompare(hash(b.qid)))) {
      if (selected === target) break;
      if (!question.gold_titles?.length || question.gold_titles.some((title: string) => !byTitle.has(title))) { skipped.push({ dataset, qid: question.qid, reason: 'missing-gold-source' }); continue; }
      cases.push({ dataset, ...question, citations: question.gold_titles.map((title: string, index: number) => ({ docTitle: title, context: byTitle.get(title), subQueryOrigin: `gold-source-${index + 1}` })) });
      selected++;
    }
  }
  if (cases.length !== limit) throw new Error('Incomplete paired corpus coverage');
  const report: any = { contract: 'paired-oracle-multihop-generation-v1', createdAt: new Date().toISOString(), mode: 'oracle-gold-context', limits: ['Gold documents are provided directly; retrieval quality and permission behavior are not measured.', 'Citation recall measures source-marker coverage, not entailment of each reasoning link.', 'Full-answer token F1 is local diagnostic normalization, not official benchmark scoring.'], model: config.modelName, routeHash: hash(config.baseUrl), baselineGit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), baselinePromptHash: hash(baselineRules), candidatePromptHash: hash([candidateRules, multiHopAnswerDirective('multi_hop', [{ subQueryOrigin: 'gold' }], true)]), inputHash: hash(cases), skipped, results: [] };
  const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
  for (const [index, item] of cases.entries()) {
    const context = buildSourceContext(item.citations, '', true, { log() {} });
    const result: any = { dataset: item.dataset, qid: item.qid, question: item.question, goldAnswer: item.answer, goldSources: item.gold_titles, contextHash: hash(context) };
    for (const arm of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const system = `${arm === 'baseline' ? baselineRules : candidateRules}\n\nReference Knowledge Base Materials:\n${context}${arm === 'candidate' ? '\n\n' + multiHopAnswerDirective('multi_hop', item.citations, true) : ''}`;
      const startedAt = Date.now();
      try {
        const answer = await llmChat([{ role: 'system', content: system }, { role: 'user', content: item.question }], { maxTokens: 800, timeoutMs: 60000 });
        if (!answer) throw new Error('Empty LLM answer');
        const validCitations = new Set([...answer.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])).filter(value => value >= 1 && value <= item.gold_titles.length));
        result[arm] = { answer, fullAnswerF1: answerF1(answer, item.answer), firstSentenceF1: answerF1(answer.split(/(?<=[.!?])\s+/)[0], item.answer), goldSourceCitationRecall: validCitations.size / item.gold_titles.length, latencyMs: Date.now() - startedAt };
      } catch (error) { result[arm] = { error: (error as Error).message, latencyMs: Date.now() - startedAt }; }
    }
    report.results.push(result); save();
    console.log(`paired generation ${index + 1}/${cases.length}: ${item.dataset}/${item.qid}`);
  }
  const paired = report.results.filter((row: any) => !row.baseline.error && !row.candidate.error);
  report.completePairs = paired.length;
  report.failedPairs = cases.length - paired.length;
  report.summary = Object.fromEntries(['baseline', 'candidate'].map(arm => [arm, Object.fromEntries(['fullAnswerF1', 'firstSentenceF1', 'goldSourceCitationRecall', 'latencyMs'].map(metric => [metric, paired.length ? paired.reduce((sum: number, row: any) => sum + row[arm][metric], 0) / paired.length : null]))]));
  report.complete = paired.length === cases.length;
  save();
  if (!report.complete) process.exitCode = 1;
}
if (process.argv[1]?.endsWith('paired-multihop-generation.ts')) main().catch(error => { console.error(error.message); process.exitCode = 1; });
