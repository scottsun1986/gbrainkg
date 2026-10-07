/** Score observed BEIR candidate pairs using the actual test deployment. No profile activation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadApiEnv } from './llm-client';

async function main() {
  loadApiEnv();
  const args = process.argv.slice(2);
  const arg = (name: string, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const directory = arg('--dataset-dir'); const runPath = arg('--retrieval-run'); const output = arg('--out');
  if (!directory || !runPath || !output) throw new Error('Require --dataset-dir --retrieval-run --out');
    const limit = Number(arg('--queries', '40')); const pairs = Number(arg('--pairs', '20'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(pairs) || pairs < 1 || pairs > 50) throw new Error('Bounded query/pair settings required');
  const database = new URL(process.env.DATABASE_URL_APP || process.env.DATABASE_URL || '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) throw new Error('Direct model configuration reads are local test only');
  const { ModelConfigService } = await import('../../apps/api/src/model-config.service');
  const { rerankPairs } = await import('../../apps/api/src/retrieval/pair-reranker');
  const { runAsService } = await import('../../apps/api/src/db/service-principal');
  const { disconnectPrismaClient } = await import('../../apps/api/src/prisma');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const jsonl = (path: string): any[] => readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  try {
    const config = await new ModelConfigService().getDefault('rerank');
    if (!config) throw new Error('Test deployment has no configured reranker');
    const route = new URL(config.provider.baseUrl);
    if (route.username || route.password || route.search) throw new Error('Credential-bearing provider route cannot be written to a calibration artifact');
    const corpusPath = resolve(directory, 'corpus.jsonl'); const queryPath = resolve(directory, 'queries.jsonl'); const qrelsPath = resolve(directory, 'qrels/test.tsv');
    const corpus = new Map<string, any>(jsonl(corpusPath).map(row => [String(row._id), row]));
    const queries = new Map<string, string>(jsonl(queryPath).map(row => [String(row._id), String(row.text)]));
    const qrels = new Map<string, Set<string>>();
    for (const line of readFileSync(qrelsPath, 'utf8').split(/\r?\n/)) {
      const [qid, doc, gain] = line.trim().split(/\s+/);
      if (!qid || !Number.isFinite(Number(gain))) continue;
      if (!qrels.has(qid)) qrels.set(qid, new Set());
      if (Number(gain) > 0) qrels.get(qid)!.add(doc);
    }
    const runs = jsonl(runPath).sort((a,b) => String(a.qid).localeCompare(String(b.qid))).slice(0,limit);
    const defaults = config.provider.defaultParams as Record<string, unknown> | null;
    const revision = process.env.RERANK_DEPLOYMENT_REVISION || defaults?.deploymentRevision || defaults?.revision || '';
    const report: any = { contract: 'rerank-labels-v1', complete: false, routeHash: createHash('sha256').update(config.provider.baseUrl).digest('hex'), model: config.modelName, revision,
      corpusHash: digest(corpusPath), queriesHash: digest(queryPath), qrelsHash: digest(qrelsPath), candidateRunHash: digest(runPath),
      labelPolicy: 'official positive qrels define IR relevance; unjudged candidates count nonrelevant under closed-world IR convention; NOT factual entailment or query answerability labels',
      sampling: 'observed fixed retrieval candidate pool; no injected gold/distractor candidates', cases: [] };
    const save = () => writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
    for (const run of runs) {
      const qid = String(run.qid || run.query_id || ''); const query = queries.get(qid); const relevant = qrels.get(qid);
      if (!query || !relevant) throw new Error('Candidate run topic does not match official query/qrels');
      const docs = [...new Set<string>((run.docids || run.doc_ids || []).map(String))].slice(0,pairs);
      if (docs.some(id => !corpus.has(id))) throw new Error('Candidate corpus ID missing');
      const texts = docs.map(id => { const row = corpus.get(id); return `${row.title || ''}\n${row.text || ''}`; });
      const scores = await runAsService('offline-calibration-measurement', () => rerankPairs(config, query, texts, 30000));
      if (scores.length !== docs.length) throw new Error('Incomplete actual reranker scores; run invalid');
      for (const row of scores) report.cases.push({ id: `${qid}:${docs[row.index]}`, queryId: qid, documentId: docs[row.index], score: row.relevance_score, supported: relevant.has(docs[row.index]) });
      save();
      console.log(JSON.stringify({ queries: report.cases.length ? new Set(report.cases.map((row: any) => row.queryId)).size : 0, pairs: report.cases.length, deploymentRevisionKnown: Boolean(revision) }));
    }
    report.complete = true; report.queryLevelRefusalEvaluated = false; save();
  } finally { await disconnectPrismaClient(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
