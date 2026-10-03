/**
 * P1 质量-1：faithfulness 三段诊断工具。
 *
 * 对 golden 集（可按 bucket/关键词过滤）逐题调用真实问答 SSE，导出三段内容：
 *   1) 召回段：trace.gbrain_retrieval 的候选数、top 证据、证据评估
 *   2) 证据包段：下发的 citation 列表（标题/分数/页码/bbox/单元格坐标）
 *   3) 答案段：最终答案 + citation_validation 的句级绑定（sentenceGrounding）
 * 并对每题给出失败环节归因（检索空/证据弱/角标缺失/句级未支撑/拒答/指标口径），
 * 用于在改生成链路之前先定位问题出在哪一环。
 *
 * 用法：
 *   LLMWIKI_TOKEN=<jwt> npx tsx tests/evaluation/faithfulness-diagnose.ts \
 *     [--api http://127.0.0.1:3202] [--limit 40] [--bucket exact_clause] [--out results/diagnose.jsonl]
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const API = (flag('api', 'http://127.0.0.1:3202') || '').replace(/\/$/, '');
const TOKEN = process.env.LLMWIKI_TOKEN || '';
const LIMIT = Number(flag('limit', '40') || 40);
const BUCKET = flag('bucket');
const OUT = flag('out', path.join(__dirname, 'results', `diagnose-${Date.now()}.jsonl`));

interface GoldenCase {
  id: string;
  category?: string;
  bucket?: string;
  question: string;
  expected_kb_scope?: string[];
  expected_document_titles?: string[];
  expected_keywords?: string[];
  expected_no_answer?: boolean;
}

async function loadCases(): Promise<GoldenCase[]> {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-dataset.json'), 'utf8')) as GoldenCase[];
  let cases = Array.isArray(raw) ? raw : [];
  if (BUCKET) cases = cases.filter((c) => (c.bucket || c.category) === BUCKET);
  return cases.slice(0, LIMIT);
}

async function ask(question: string, kbScope?: string[]) {
  const res = await fetch(`${API}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ message: question, ...(kbScope?.length ? { kb_scope: kbScope } : {}) }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let answer = '';
  const citations: any[] = [];
  const traces: any[] = [];
  const stages: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const data = JSON.parse(payload);
      if (data.type === 'delta') answer += data.content || '';
      else if (data.type === 'citation') citations.push(data.timeline_entry || {});
      else if (data.type === 'trace') traces.push(data.node || {});
      else if (data.type === 'stage') stages.push(data.stage);
    } catch { /* ignore malformed frames */ }
  }
  return { status: res.status, answer, citations, traces, stages };
}

function attribute(caseRow: GoldenCase, run: Awaited<ReturnType<typeof ask>>) {
  const retrieval = run.traces.find((t) => t.id === 'gbrain_retrieval');
  const validation = run.traces.find((t) => t.id === 'citation_validation');
  const coverage = validation?.details?.semanticCoverage;
  const markers = Array.from(new Set((run.answer.match(/\[(\d+)\]/g) || []).map((m) => Number(m.slice(1, -1)))));
  const ungrounded = (validation?.details?.unsupportedStatements || []) as string[];
  const reasons: string[] = [];
  if (run.status !== 200 && run.status !== 201) reasons.push(`transport_http_${run.status}`);
  if (retrieval && Number(retrieval.details?.candidateCount || 0) === 0) reasons.push('retrieval_empty');
  if (retrieval?.details?.evidenceAssessment?.shouldEscalate) reasons.push('evidence_weak_escalated');
  if (run.citations.length === 0) reasons.push('no_citations');
  else if (markers.length === 0) reasons.push('answer_without_markers');
  if (coverage && coverage.coverageRatio < 0.6 && !coverage.refusalExempt) reasons.push('low_sentence_grounding');
  if (ungrounded.length > 0) reasons.push(`ungrounded_sentences_${ungrounded.length}`);
  if (caseRow.expected_no_answer && !/无法|未包含|not available|cannot/i.test(run.answer)) reasons.push('should_have_refused');
  if (!caseRow.expected_no_answer && /无法回答|未包含相关信息|not available/i.test(run.answer)) reasons.push('refused_unexpectedly');
  if (caseRow.expected_keywords?.length) {
    const hit = caseRow.expected_keywords.filter((k) => run.answer.includes(k)).length;
    if (hit / caseRow.expected_keywords.length < 0.5) reasons.push('keyword_miss');
  }
  return { reasons: reasons.length ? reasons : ['ok'], markerIndices: markers };
}

async function main() {
  if (!TOKEN && !process.env.LLMWIKI_USER) {
    console.error('需要 LLMWIKI_TOKEN（或先用登录脚本导出）');
    process.exit(1);
  }
  const cases = await loadCases();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const stream = fs.createWriteStream(OUT, { flags: 'w' });
  const tally = new Map<string, number>();
  console.log(`diagnose ${cases.length} cases against ${API} → ${OUT}`);
  for (const c of cases) {
    const started = Date.now();
    const run = await ask(c.question, c.expected_kb_scope);
    const attribution = attribute(c, run);
    for (const r of attribution.reasons) tally.set(r, (tally.get(r) || 0) + 1);
    const record = {
      id: c.id,
      bucket: c.bucket || c.category || null,
      question: c.question,
      expected_no_answer: Boolean(c.expected_no_answer),
      latency_ms: Date.now() - started,
      // —— 三段导出 ——
      retrieval: run.traces
        .filter((t) => ['gbrain_retrieval', 'retrieval_escalation', 'confidence_rerank'].includes(t.id))
        .map((t) => ({ stage: t.id, status: t.status, summary: t.summary, details: t.details })),
      evidence_pack: run.citations.map((e: any) => ({
        doc_title: e.doc_title, document_id: e.document_id, score: e.score,
        page_no: e.page_no, bbox: e.bbox, snippet: String(e.snippet || '').slice(0, 200),
      })),
      answer: {
        text: run.answer,
        markers: attribution.markerIndices,
        sentence_grounding: run.traces.find((t) => t.id === 'citation_validation')?.details?.sentenceGrounding || [],
        unsupported_statements: run.traces.find((t) => t.id === 'citation_validation')?.details?.unsupportedStatements || [],
        semantic_coverage: run.traces.find((t) => t.id === 'citation_validation')?.details?.semanticCoverage || null,
      },
      attribution: attribution.reasons,
    };
    stream.write(JSON.stringify(record) + '\n');
    console.log(`${c.id} [${attribution.reasons.join(',')}] ${record.latency_ms}ms`);
  }
  stream.end();
  console.log('\n=== 归因汇总（按题数） ===');
  for (const [reason, count] of Array.from(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(4)}  ${reason}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
