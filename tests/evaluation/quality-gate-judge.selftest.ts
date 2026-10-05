import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgeConfiguration, judgeResponseScore, summarizeJudgeSamples } from './quality-gate-judge';

const release = { GATE_STRICT: '1', GATE_LLM_JUDGE: 'true', GATE_LLM_JUDGE_MIN: '0.95', GATE_LLM_JUDGE_SAMPLES: '3' };
assert.deepEqual(judgeConfiguration(release), { enabled: true, minimum: 0.95, samples: 3 });
assert.deepEqual(judgeConfiguration({}), { enabled: false, minimum: 0, samples: 1 });
for (const samples of ['NaN', 'Infinity', '0', '2', '3.5', '6']) {
  assert.throws(() => judgeConfiguration({ ...release, GATE_LLM_JUDGE_SAMPLES: samples }), /configuration invalid/);
}
for (const minimum of ['NaN', 'Infinity', '-1', '0', '1.01']) {
  assert.throws(() => judgeConfiguration({ ...release, GATE_LLM_JUDGE_MIN: minimum }), /configuration invalid/);
}
assert.throws(() => judgeConfiguration({ ...release, GATE_LLM_JUDGE: 'false' }), /true is required/);
assert.throws(() => judgeConfiguration({ GATE_LLM_JUDGE_MIN: '0.9' }), /true is required/);

assert.deepEqual(summarizeJudgeSamples([1, 0.5, 0], 3), { score: 0.5, spread: 1 });
assert.deepEqual(summarizeJudgeSamples([1], 1), { score: 1, spread: null });
for (const scores of [[1], [1, 1, -1], [1, NaN, 1], [1, Infinity, 1], [1, 1.1, 1]]) {
  assert.equal(summarizeJudgeSamples(scores, 3).score, -1);
}
assert.equal(judgeResponseScore({ assertions: [{ text: 'A', supported: true }, { text: 'B', supported: false }], score: 1 }, false), 0.5);
for (const response of [null, {}, { score: 1 }, { assertions: [], score: 1 }, { assertions: [{ text: 'A', supported: 'true' }], score: 1 }]) {
  assert.equal(judgeResponseScore(response, false), -1);
}
assert.equal(judgeResponseScore({ assertions: [], score: 1 }, true), 1);
assert.equal(judgeResponseScore({ assertions: [], score: NaN }, true), -1);
assert.equal(judgeResponseScore({ assertions: [], score: 2 }, true), -1);

// Exercise the actual CLI, report and shell coordinator without real models,
// credentials or corpus writes. All generated reports live in a disposable tree.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrainkg-judge-'));
try {
  const evaluation = path.join(temp, 'tests/evaluation');
  fs.mkdirSync(evaluation, { recursive: true });
  for (const file of ['quality-gate.ts', 'quality-gate-judge.ts', 'quality-gate-auth.ts', 'quality-gate-validity.ts', 'llm-client.ts', 'run-meta.ts']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(evaluation, file));
  }
  fs.writeFileSync(path.join(evaluation, 'golden-dataset.json'), JSON.stringify([{
    id: 'fixture', category: 'clause_query', question: 'What is A?', expected_kb_scope: [],
    expected_document_titles: ['Fixture'], expected_keywords: ['A'], expected_no_answer: false,
    unauthorized_users: [],
  }]));
  const preload = path.join(temp, 'mock.cjs');
  fs.writeFileSync(preload, `
let passes = 0;
global.fetch = async (url, init) => {
  if (String(url).includes('/kbs')) return new Response(JSON.stringify({ items: [], total: 0 }));
  if (String(url).startsWith('http://judge.invalid/')) {
    passes++;
    if (process.env.MOCK_JUDGE === 'partial' && passes > 1) throw new Error('judge unavailable');
    const prompt = JSON.parse(init.body).messages[0].content;
    const mode = process.env.MOCK_JUDGE;
    const raw = mode === 'bad-json' ? 'not json' : mode === 'bad-assertions' ? JSON.stringify({score:1}) : JSON.stringify({ assertions: [{text: 'A exists', supported: true}], score: 1, reason: prompt.includes('ANSWER_TAIL') ? 'full answer received' : 'short answer received' });
    return new Response(JSON.stringify({ model: 'fixture-version', choices: [{ message: { content: raw } }] }));
  }
  const mode = process.env.MOCK_JUDGE;
  return new Response('data: '+JSON.stringify({type:'delta',content:mode.startsWith('empty') ? '' : mode === 'refusal' ? '无法回答该问题' : mode === 'uncited' ? 'A is an unsupported answer without a citation.' : 'A exists.'+'x'.repeat(2000)+'ANSWER_TAIL'})+'\\n'+
    (mode === 'uncited' ? '' : 'data: '+JSON.stringify({type:'citation',timeline_entry:{doc_title:'Fixture',snippet:'A exists.'+'e'.repeat(900)+'EVIDENCE_TAIL'}})+'\\n'));
};
`);
  const env = {
    ...process.env, LLMWIKI_TOKEN: 'fixture', API_URL: 'http://api.invalid',
    LLM_BASE_URL: 'http://judge.invalid', LLM_MODEL: 'fixture', LLM_API_KEY: 'judge-secret-must-not-appear',
    GATE_MIN_SCORED_CASES: '1', GATE_LIMIT: '0', ...release,
  };
  for (const mode of ['complete', 'partial', 'disabled', 'empty', 'empty-refusal', 'refusal', 'uncited', 'bad-json', 'bad-assertions']) {
    const datasetPath = path.join(evaluation, 'golden-dataset.json');
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
    dataset[0].expected_no_answer = mode === 'empty-refusal';
    dataset[0].expected_document_titles = mode === 'uncited' ? [] : ['Fixture'];
    fs.writeFileSync(datasetPath, JSON.stringify(dataset));
    const result = spawnSync(process.execPath, [...process.execArgv, '--require', preload, path.join(evaluation, 'quality-gate.ts')], {
      env: { ...env, MOCK_JUDGE: mode, ...(['disabled', 'uncited'].includes(mode) ? { GATE_STRICT: '0', GATE_LLM_JUDGE: 'false', GATE_LLM_JUDGE_MIN: '0' } : {}) },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, ['partial', 'empty', 'empty-refusal', 'refusal', 'uncited', 'bad-json', 'bad-assertions'].includes(mode) ? 1 : 0, result.stdout + result.stderr);
    const reports = fs.readdirSync(path.join(evaluation, 'results'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(evaluation, 'results', reports[0]), 'utf8'));
    assert.equal(report.summary.valid, !['partial', 'empty', 'empty-refusal', 'bad-json', 'bad-assertions'].includes(mode));
    assert.equal(report.summary.judge.coveragePass, !['partial', 'empty', 'empty-refusal', 'bad-json', 'bad-assertions'].includes(mode));
    assert.equal(report.summary.metrics.faithfulness, ['complete', 'refusal'].includes(mode) ? 1 : null);
    assert.equal(report.summary.judge.faithfulnessMeasured, ['complete', 'refusal'].includes(mode));
    if (['empty', 'empty-refusal', 'refusal'].includes(mode)) assert.equal(report.summary.passed, 0);
    if (mode === 'uncited') assert.equal(report.summary.metrics.groundingPresence, 0);
    const row = report.results[0];
    assert.equal(row.answer, row.fullAnswer.slice(0, 400));
    assert.equal(row.question, 'What is A?');
    assert.ok(!JSON.stringify(report).includes('judge-secret-must-not-appear'));
    if (!['disabled', 'uncited', 'empty', 'empty-refusal'].includes(mode)) {
      const trace = row.judgeTrace;
      assert.equal(trace.input.answer, row.fullAnswer);
      assert.equal(trace.samples.length, 3);
      assert.deepEqual(trace.config, { baseUrl: 'http://judge.invalid', model: 'fixture', temperature: 0, maxTokens: 600, timeoutMs: 45000 });
      assert.ok(trace.input.evidence.includes('A exists.'));
      assert.ok(!trace.input.evidence.includes('EVIDENCE_TAIL'));
      assert.ok(trace.input.prompt.includes(trace.input.evidence));
      assert.ok(trace.samples.every((pass: any) => pass.requestAttempted && pass.requestedAt));
      if (mode !== 'refusal') {
        assert.ok(row.fullAnswer.length > 2000);
        assert.ok(trace.input.prompt.includes('ANSWER_TAIL'));
      }
      if (mode === 'complete') {
        assert.ok(trace.valid);
        assert.ok(trace.samples.every((pass: any) => pass.rawCompletion.model === 'fixture-version'));
        assert.ok(trace.samples.every((pass: any) => pass.valid && pass.score === 1 && pass.rawResponse.includes('full answer received') && pass.parsed.assertions[0].text === 'A exists'));
      }
      if (mode === 'partial') {
        assert.equal(trace.valid, false);
        assert.equal(trace.samples[0].valid, true);
        assert.equal(trace.samples[1].valid, false);
        assert.equal(trace.samples[1].rawResponse, null);
        assert.equal(trace.samples[1].rawCompletion, null);
        assert.match(trace.samples[1].error, /judge unavailable/);
      }
      if (mode === 'bad-json') {
        assert.equal(trace.samples[0].rawResponse, 'not json');
        assert.equal(trace.samples[0].parsed, null);
        assert.match(trace.samples[0].error, /not valid JSON/);
      }
      if (mode === 'bad-assertions') {
        assert.deepEqual(trace.samples[0].parsed, { score: 1 });
        assert.match(trace.samples[0].error, /malformed/);
      }
    }

    fs.unlinkSync(path.join(evaluation, 'results', reports[0]));
  }
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\necho "mock live gate: $1"\nexit 1\n', { mode: 0o755 });
  for (const strict of ['0', '1']) {
    const shell = spawnSync('bash', [path.join(__dirname, 'ci-gate.sh')], {
      env: { ...env, GATE_STRICT: strict, PATH: `${bin}:${process.env.PATH}`, CHECK_INTL: '1', ANN_EVAL_DATABASE_URL: 'fixture' },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(shell.status, 1, shell.stdout + shell.stderr);
    assert.match(shell.stdout, /2 enabled live gate\(s\) failed/);
    assert.match(shell.stdout, /ann_recall_eval\.py/);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('quality-gate-judge self-test passed');
