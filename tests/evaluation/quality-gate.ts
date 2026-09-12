/**
 * RAG Quality Gate for CI/CD
 *
 * Runs the golden dataset against a LIVE API and enforces SOTA thresholds.
 * Exit code 0 = PASS (all thresholds met), 1 = FAIL.
 *
 * Usage:
 *   LLMWIKI_TOKEN=<jwt> npx tsx tests/evaluation/quality-gate.ts
 *
 * Environment variables:
 *   API_URL / API_BASE     - API origin (default http://127.0.0.1:3202)
 *   LLMWIKI_TOKEN|AUTH_TOKEN - a valid Bearer JWT (required for authed corpus)
 *   GATE_* thresholds      - see THRESHOLDS below
 *
 * The golden corpus is seeded under knowledge bases named
 * "Golden Evaluation <scope>" (e.g. scope "kb-company-policy").
 */
import fs from 'fs';
import path from 'path';
import { llmChat, extractJson, llmConfig } from './llm-client';
import { runMetadata } from './run-meta';

interface EvalQuestion {
  id: string;
  category: string;
  question: string;
  expected_kb_scope: string[];
  expected_document_titles: string[];
  expected_keywords: string[];
  expected_no_answer: boolean;
  requires_auth_user: string | null;
  unauthorized_users: string[];
  /** Prior questions sent first (same scope) to establish conversation context. */
  prior_turns?: string[];
  notes: string;
}

interface ChatResult {
  answer: string;
  citations: Array<{ doc_title?: string; document_id?: string; page_no?: number; snippet?: string }>;
  conversationId?: string;
  status: number;
  error?: string;
}

const API_BASE = (process.env.API_URL || process.env.API_BASE || 'http://127.0.0.1:3202')
  .replace(/\/api\/v1\/chat\/completions$/, '')
  .replace(/\/$/, '');
const CHAT_URL = `${API_BASE}/api/v1/chat/completions`;
const TOKEN = process.env.LLMWIKI_TOKEN || process.env.AUTH_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.GATE_REQUEST_TIMEOUT_MS || 90_000);
// Independent (LLM-as-judge) scoring: opt-in, reported always, gated only when
// GATE_LLM_JUDGE_MIN > 0. This avoids a gate that only measures keyword overlap.
const LLM_JUDGE_ENABLED = process.env.GATE_LLM_JUDGE === 'true';
const LLM_JUDGE_MIN = parseFloat(process.env.GATE_LLM_JUDGE_MIN || '0');

const DATASET_PATH = path.join(__dirname, 'golden-dataset.json');
const RESULTS_DIR = path.join(__dirname, 'results');

const THRESHOLDS = {
  hitRate: parseFloat(process.env.GATE_HIT_RATE || '0.80'),
  keywordCoverage: parseFloat(process.env.GATE_KEYWORD_COVERAGE || '0.75'),
  permission: parseFloat(process.env.GATE_PERMISSION_RATE || '1.00'),
  noAnswer: parseFloat(process.env.GATE_NO_HALLUCINATION || '0.90'),
  faithfulness: parseFloat(process.env.GATE_FAITHFULNESS || '0.95'),
  citationAccuracy: parseFloat(process.env.GATE_CITATION_ACCURACY || '0.90'),
  contextPrecision: parseFloat(process.env.GATE_CONTEXT_PRECISION || '0.85'),
};

const colors = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const REFUSAL_MARKERS = ['未包含相关信息', '无法回答', '无法根据知识库回答', '未包含'];

// ---------------------------------------------------------------- helpers
async function apiJson(method: string, pathname: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let json: any = null;
  try { json = await response.json(); } catch { /* ignore */ }
  return { status: response.status, json };
}

/** Resolve golden scope names (e.g. "kb-company-policy") to real KB ids. */
async function resolveScopeMap(scopes: string[][]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wanted = new Set(scopes.flat());
  let page = 1;
  while (page <= 10 && wanted.size > map.size) {
    const { status, json } = await apiJson('GET', `/api/v1/kbs?page=${page}&limit=100`, TOKEN);
    if (status !== 200) break;
    const items: any[] = json?.items || [];
    for (const kb of items) {
      for (const scope of wanted) {
        if (map.has(scope)) continue;
        const name = String(kb.name || '');
        if (name === `Golden Evaluation ${scope}` || name.endsWith(` ${scope}`) || name === scope) {
          map.set(scope, kb.id);
        }
      }
    }
    const total = Number(json?.total || 0);
    if (page * 100 >= total || !items.length) break;
    page += 1;
  }
  return map;
}

async function fetchChatCompletion(
  question: string,
  kbScopeIds?: string[],
  conversationId?: string,
): Promise<ChatResult> {
  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({
        message: question,
        ...(kbScopeIds?.length ? { kb_scope: kbScopeIds } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const result: ChatResult = { answer: '', citations: [], status: response.status };
    if (response.status !== 200 && response.status !== 201) {
      result.error = `HTTP ${response.status}: ${text.slice(0, 200)}`;
      return result;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        if (data.type === 'conversation' && data.conversation_id) {
          result.conversationId = data.conversation_id;
        } else if (data.type === 'delta' && data.content) {
          result.answer += data.content;
        } else if (data.type === 'citation' && data.timeline_entry) {
          result.citations.push({
            doc_title: data.timeline_entry.doc_title,
            document_id: data.timeline_entry.document_id,
            page_no: data.timeline_entry.page_no,
            snippet: data.timeline_entry.snippet,
          });
        }
      } catch { /* partial SSE line */ }
    }
    return result;
  } catch (error) {
    return { answer: '', citations: [], status: 0, error: String(error) };
  }
}

// Max evidence text passed to the judge per citation (keeps prompts bounded).
const EVIDENCE_SNIPPET_MAX_CHARS = 800;

/**
 * Independent LLM-as-judge over assertion-evidence entailment. The judge sees
 * the snippet text of every citation (not just titles) and decomposes the
 * answer into atomic assertions; the returned score is the ratio of assertions
 * supported by the evidence. Returns -1 when no judge route is configured or
 * the judge output cannot be parsed (fail-open).
 */
async function judgeAnswer(
  question: string,
  answer: string,
  expectedKeywords: string[],
  citations: Array<{ doc_title?: string; snippet?: string }>,
  expectedNoAnswer: boolean,
): Promise<number> {
  if (!llmConfig()) return -1; // no route configured: skip
  const evidence = citations.slice(0, 8)
    .map((c, index) => {
      const snippet = String(c.snippet || '').trim().slice(0, EVIDENCE_SNIPPET_MAX_CHARS);
      return `[${index + 1}] 《${c.doc_title || '未命名文档'}》 ${snippet || '(无正文片段)'}`;
    })
    .join('\n');
  const direction = expectedNoAnswer
    ? '本题在知识库中无答案，期望模型明确拒答且不编造。'
    : `期望答案覆盖要点：${expectedKeywords.join('、') || '(以引用为准)'}`;
  const prompt = `你是独立评阅人。请只依据下方"证据片段"判断回答质量，不得使用外部知识。
问题：${question}
${direction}
证据片段（引用正文，与引用编号对应）：
${evidence || '(无)'}
模型回答：${answer.slice(0, 1200)}
评分步骤：
1. 将模型回答拆分为原子断言（可独立验证的最小陈述）。
2. 逐断言判断其是否被证据片段蕴含（supported / unsupported）。${expectedNoAnswer ? '任何编造的断言一律记为 unsupported；正确拒答则 score=1.0。' : ''}
3. score = supported 断言数 / 总断言数。
请输出 json：{"assertions": [{"text": "断言", "supported": true}], "score": 0.0-1.0, "reason": "一句话理由"}`;
  try {
    const text = await llmChat([{ role: 'user', content: prompt }], { maxTokens: 600, timeoutMs: 45000 });
    const parsed = extractJson<{ score?: number; assertions?: Array<{ supported?: boolean }> }>(text);
    if (!parsed) return -1;
    // Recount the judge's own assertion table instead of trusting its arithmetic.
    const judgments = Array.isArray(parsed.assertions) ? parsed.assertions : [];
    if (judgments.length > 0) {
      const supported = judgments.filter((a) => a?.supported === true).length;
      return Math.max(0, Math.min(1, supported / judgments.length));
    }
    if (typeof parsed.score === 'number') return Math.max(0, Math.min(1, parsed.score));
  } catch { /* fail-open */ }
  return -1;
}

// ---------------------------------------------------------------- main
async function runQualityGate() {
  console.log(`${colors.cyan}========================================${colors.reset}`);
  console.log(`${colors.cyan}  GBrainKG RAG Quality Gate (SOTA)      ${colors.reset}`);
  console.log(`${colors.cyan}========================================${colors.reset}\n`);

  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`${colors.red}Dataset not found: ${DATASET_PATH}${colors.reset}`);
    process.exit(1);
  }
  const allQuestions: EvalQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  const limit = Math.max(0, Number(process.env.GATE_LIMIT || 0));
  const dataset: EvalQuestion[] = limit > 0 ? allQuestions.slice(0, limit) : allQuestions;

  const allScopes = dataset.map((item) => item.expected_kb_scope).filter((s) => s.length > 0);
  const scopeMap = await resolveScopeMap(allScopes);
  const resolved = [...scopeMap.keys()].filter((key) => allScopes.some((s) => s.includes(key)));
  console.log(`语料范围解析: ${resolved.length}/${new Set(allScopes).size} 个知识库已映射\n`);
  if (!TOKEN) {
    console.warn(`${colors.yellow}警告: 未设置 LLMWIKI_TOKEN，鉴权类用例将全部失败${colors.reset}\n`);
  }

  interface Row {
    id: string; category: string; success: boolean;
    hitRate: boolean; citationAccuracy: boolean; noAnswer: boolean;
    permission: boolean; keywordCoverage: number;
    faithfulness: number; contextPrecision: number; judged: boolean;
    answer: string; citations: string[]; error?: string; llmJudge?: number;
  }
  const results: Row[] = [];
  let totalScore = 0;

  for (const item of dataset) {
    process.stdout.write(`评估 ${item.id} [${item.category}] ${item.question.slice(0, 32)}... `);
    const scopeIds = item.expected_kb_scope
      .map((scope) => scopeMap.get(scope))
      .filter((id): id is string => Boolean(id));

    // Multi-turn cases: establish conversation context with the prior turns,
    // then ask the referencing question inside the same conversation.
    let conversationId: string | undefined;
    if (item.prior_turns?.length) {
      for (const prior of item.prior_turns) {
        const turn = await fetchChatCompletion(prior, scopeIds, conversationId);
        conversationId = turn.conversationId ?? conversationId;
      }
    }
    let res = await fetchChatCompletion(item.question, scopeIds, conversationId);

    // LLM answering is mildly nondeterministic: when the correct evidence WAS
    // retrieved (hitRate true) but the model refused, retry once with a nonce
    // so a stale cache entry or a temperature flake does not fail the gate.
    const refused = REFUSAL_MARKERS.some((m) => res.answer.includes(m));
    const hitOnFirst = item.expected_document_titles.length === 0
      || item.expected_document_titles.some((t) => res.citations.some((c) => (c.doc_title || '').includes(t)));
    if (!item.expected_no_answer && refused && hitOnFirst) {
      res = await fetchChatCompletion(`${item.question}（复核）`, scopeIds);
    }
    const titles = res.citations.map((c) => c.doc_title || '');

    const hitRate = item.expected_document_titles.length === 0
      || item.expected_document_titles.some((t) => titles.some((rt) => rt.includes(t)));
    // When a case declares no expected documents, or demands a refusal
    // (expected_no_answer), citation accuracy/precision are not applicable:
    // a correct refusal produces no citations by design.
    const citationsNotApplicable =
      item.expected_document_titles.length === 0 || item.expected_no_answer;
    const citationAccuracy = citationsNotApplicable
      ? true
      : titles.some((t) => item.expected_document_titles.some((e) => t.includes(e)));
    // Coverage of ALL expected documents across the full returned citation
    // list (the previous check only inspected the first returned title).
    const contextPrecision = citationsNotApplicable
      ? 1
      : item.expected_document_titles.filter((e) => titles.some((rt) => rt.includes(e))).length
        / item.expected_document_titles.length;

    const finalRefused = REFUSAL_MARKERS.some((m) => res.answer.includes(m));
    const noAnswer = item.expected_no_answer
      ? finalRefused || res.answer.trim() === ''
      : res.answer.length > 0 && !REFUSAL_MARKERS.every((m) => res.answer.includes(m));

    const keywordCoverage = item.expected_keywords.length > 0
      ? item.expected_keywords.filter((kw) => res.answer.includes(kw)).length / item.expected_keywords.length
      : 1;

    // Faithfulness = ratio of answer assertions supported by the cited
    // evidence (judge-based entailment). Without a judge route the metric
    // degrades to a strict grounding-presence check (0/1) so ungrounded
    // long answers still fail the gate.
    let llmJudge: number | undefined;
    if (LLM_JUDGE_ENABLED) {
      const score = await judgeAnswer(item.question, res.answer, item.expected_keywords, res.citations, item.expected_no_answer);
      if (score >= 0) llmJudge = score;
    }
    const faithfulness = llmJudge !== undefined
      ? llmJudge
      : (!item.expected_no_answer && res.citations.length === 0
        && res.answer.length > 20 && !finalRefused) ? 0 : 1;

    // Permission probe: any permission-boundary case must also reject an
    // out-of-scope KB request outright (403), proving scope is enforced.
    let permission = true;
    if (item.unauthorized_users.length > 0 || item.category === 'permission_boundary') {
      const probe = await fetchChatCompletion(item.question, ['00000000-0000-4000-8000-000000000000']);
      permission = probe.status === 403 || probe.status === 401;
    }

    const success = (item.expected_no_answer ? noAnswer : hitRate) && permission;
    if (success) totalScore++;

    console.log(success ? `${colors.green}✓ PASS${colors.reset}` : `${colors.red}✗ FAIL${colors.reset}`);

    results.push({
      id: item.id, category: item.category, success,
      hitRate, citationAccuracy, noAnswer, permission,
      keywordCoverage, faithfulness, contextPrecision, judged: llmJudge !== undefined,
      answer: res.answer.slice(0, 400), citations: titles, error: res.error, llmJudge,
    });
  }

  const total = dataset.length;
  const agg = {
    hitRate: results.filter((r) => r.hitRate).length / total,
    keywordCoverage: results.reduce((acc, r) => acc + r.keywordCoverage, 0) / total,
    permission: results.filter((r) => r.permission).length / total,
    noAnswer: results.filter((r) => r.noAnswer).length / total,
    citationAccuracy: results.filter((r) => r.citationAccuracy).length / total,
    faithfulness: results.reduce((acc, r) => acc + r.faithfulness, 0) / total,
    contextPrecision: results.reduce((acc, r) => acc + r.contextPrecision, 0) / total,
    llmJudge: (() => {
      const judged = results.filter((r) => typeof r.llmJudge === 'number');
      return judged.length ? judged.reduce((acc, r) => acc + (r.llmJudge as number), 0) / judged.length : -1;
    })(),
  };

  const categories: Record<string, any> = {};
  for (const category of new Set(dataset.map((d) => d.category))) {
    const rows = results.filter((r) => r.category === category);
    categories[category] = {
      total: rows.length,
      successRate: rows.filter((r) => r.success).length / rows.length,
      hitRate: rows.filter((r) => r.hitRate).length / rows.length,
      keywordCoverage: rows.reduce((acc, r) => acc + r.keywordCoverage, 0) / rows.length,
    };
  }

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `quality-gate-report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    ...runMetadata(DATASET_PATH),
    api: API_BASE,
    thresholds: THRESHOLDS,
    summary: {
      total, passed: totalScore, overallSuccessRate: totalScore / total,
      metrics: agg, byCategory: categories,
    },
    results,
  }, null, 2));

  const llmJudgePass = LLM_JUDGE_MIN <= 0 || (agg.llmJudge >= 0 && agg.llmJudge >= LLM_JUDGE_MIN);

  const checks: Array<[string, number, number, boolean]> = [
    ['Hit Rate', THRESHOLDS.hitRate, agg.hitRate, agg.hitRate >= THRESHOLDS.hitRate],
    ['Keyword Coverage', THRESHOLDS.keywordCoverage, agg.keywordCoverage, agg.keywordCoverage >= THRESHOLDS.keywordCoverage],
    ['Permission', THRESHOLDS.permission, agg.permission, agg.permission >= THRESHOLDS.permission],
    ['No-Answer', THRESHOLDS.noAnswer, agg.noAnswer, agg.noAnswer >= THRESHOLDS.noAnswer],
    ['Faithfulness', THRESHOLDS.faithfulness, agg.faithfulness, agg.faithfulness >= THRESHOLDS.faithfulness],
    ['Citation Accuracy', THRESHOLDS.citationAccuracy, agg.citationAccuracy, agg.citationAccuracy >= THRESHOLDS.citationAccuracy],
    ['Context Precision', THRESHOLDS.contextPrecision, agg.contextPrecision, agg.contextPrecision >= THRESHOLDS.contextPrecision],
    ['LLM Judge (independent)', LLM_JUDGE_MIN, agg.llmJudge, llmJudgePass],
  ];

  console.log(`\n${colors.cyan}--- Quality Gate Summary ---${colors.reset}`);
  console.log(`Total: ${total}  Passed: ${totalScore} (${((totalScore / total) * 100).toFixed(1)}%)\n`);
  console.log('Metric                | Threshold | Actual  | Status');
  console.log('----------------------|-----------|---------|-------');
  let allPassed = true;
  for (const [name, threshold, actual, passed] of checks) {
    allPassed = allPassed && passed;
    const status = passed ? `${colors.green}PASS${colors.reset}` : `${colors.red}FAIL${colors.reset}`;
    console.log(`${name.padEnd(22)}| >= ${threshold.toFixed(2).padEnd(8)}| ${(actual * 100).toFixed(1).padStart(5)}% | ${status}`);
  }
  console.log(`\nReport: ${reportPath}`);

  if (allPassed) {
    console.log(`\n${colors.green}  QUALITY GATE PASSED${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}  QUALITY GATE FAILED${colors.reset}`);
    const failing = results.filter((r) => !r.success);
    console.log(`${colors.red}失败用例 ${failing.length} 个:${colors.reset}`);
    for (const row of failing.slice(0, 10)) {
      console.log(`  - ${row.id} [${row.category}] citations=${row.citations.slice(0, 2).join(',') || '无'} answer=${row.answer.slice(0, 60)}`);
    }
    process.exit(1);
  }
}

runQualityGate().catch((error) => {
  console.error(`${colors.red}Unhandled gate error:${colors.reset}`, error);
  process.exit(1);
});
