import { gateThreshold } from './gate-thresholds';
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
import { judgeConfiguration, judgeResponseScore, summarizeJudgeSamples } from './quality-gate-judge';
import { requireResolvedScopes, resolveGateToken } from './quality-gate-auth';
import { classifyResultError, evaluateValidity, isEnvironmentError, validityBounds } from './quality-gate-validity';

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
let TOKEN = '';
const REQUEST_TIMEOUT_MS = Number(process.env.GATE_REQUEST_TIMEOUT_MS || 90_000);
// Resolve before any API request; invalid release settings fail closed.
const judgeConfig = judgeConfiguration();
const LLM_JUDGE_ENABLED = judgeConfig.enabled;
const LLM_JUDGE_MIN = judgeConfig.minimum;
const LLM_JUDGE_SAMPLES = judgeConfig.samples;

const DATASET_PATH = path.join(__dirname, 'golden-dataset.json');
const RESULTS_DIR = path.join(__dirname, 'results');

const THRESHOLDS = {
  hitRate: gateThreshold('GATE_HIT_RATE'),
  keywordCoverage: gateThreshold('GATE_KEYWORD_COVERAGE'),
  permission: gateThreshold('GATE_PERMISSION_RATE'),
  noAnswer: gateThreshold('GATE_NO_HALLUCINATION'),
  faithfulness: gateThreshold('GATE_FAITHFULNESS'),
  citationAccuracy: gateThreshold('GATE_CITATION_ACCURACY'),
  contextPrecision: gateThreshold('GATE_CONTEXT_PRECISION'),
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
 * the judge output cannot be parsed. Missing results fail the judge coverage gate.
 */
interface JudgePassTrace {
  sample: number;
  requestedAt: string;
  requestAttempted: boolean;
  rawResponse: string | null;
  rawCompletion: unknown;
  parsed: unknown;
  score: number | null;
  valid: boolean;
  error?: string;
}
interface JudgeTrace {
  input: { question: string; answer: string; expectedKeywords: string[]; expectedNoAnswer: boolean; evidence: string; prompt: string };
  config: { baseUrl: string; model: string; temperature: number; maxTokens: number; timeoutMs: number } | null;
  evidenceBudget: { maxCitations: number; maxCharsPerCitation: number };
  samples: JudgePassTrace[];
  valid: boolean;
  spread: number | null;
  error?: string;
}

function safeJudgeConfiguration(): JudgeTrace['config'] {
  const config = llmConfig();
  if (!config) return null;
  let baseUrl = '[invalid URL]';
  try {
    const url = new URL(config.baseUrl);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    baseUrl = url.toString().replace(/\/$/, '');
  } catch { /* Invalid route is recorded by each attempted judge call. */ }
  return { baseUrl, model: config.modelName,
    temperature: 0, maxTokens: 600, timeoutMs: 45000 };
}

async function judgeAnswer(
  question: string,
  answer: string,
  expectedKeywords: string[],
  citations: Array<{ doc_title?: string; snippet?: string }>,
  expectedNoAnswer: boolean,
): Promise<{ score: number; trace: JudgeTrace }> {
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
模型回答：${answer}
评分步骤：
1. 将模型回答拆分为原子断言（可独立验证的最小陈述）。
2. 逐断言判断其是否被证据片段蕴含（supported / unsupported）。${expectedNoAnswer ? '任何编造的断言一律记为 unsupported；正确拒答则 score=1.0。' : ''}
3. score = supported 断言数 / 总断言数。
请输出 json：{"assertions": [{"text": "断言", "supported": true}], "score": 0.0-1.0, "reason": "一句话理由"}`;
  const trace: JudgeTrace = {
    input: { question, answer, expectedKeywords, expectedNoAnswer, evidence, prompt },
    config: safeJudgeConfiguration(),
    evidenceBudget: { maxCitations: 8, maxCharsPerCitation: EVIDENCE_SNIPPET_MAX_CHARS },
    samples: [], valid: false, spread: null,
  };
  if (!answer.trim()) {
    trace.error = 'empty answer; judge not requested';
    return { score: -1, trace };
  }
  for (let sample = 0; sample < LLM_JUDGE_SAMPLES; sample++) {
    trace.samples.push(await judgeAnswerOnce(prompt, expectedNoAnswer, sample + 1));
  }
  const result = summarizeJudgeSamples(trace.samples.map(pass => pass.score ?? -1), LLM_JUDGE_SAMPLES);
  trace.valid = result.score >= 0;
  trace.spread = result.spread;
  if (!trace.valid) trace.error = 'one or more requested judge samples failed';
  if (result.spread !== null) judgeSampleSpreads.push(result.spread);
  return { score: result.score, trace };
}

/** Spreads are reported alongside complete per-sample traces. */
const judgeSampleSpreads: number[] = [];

async function judgeAnswerOnce(prompt: string, expectedNoAnswer: boolean, sample: number): Promise<JudgePassTrace> {
  const pass: JudgePassTrace = { sample, requestedAt: new Date().toISOString(), requestAttempted: false,
    rawResponse: null, rawCompletion: null, parsed: null, score: null, valid: false };
  const config = llmConfig();
  if (!config) return { ...pass, error: 'judge route not configured' };
  try {
    pass.requestAttempted = true;
    pass.rawResponse = await llmChat([{ role: 'user', content: prompt }], { maxTokens: 600, timeoutMs: 45000, onResponse: payload => { pass.rawCompletion = payload; } });
    pass.parsed = extractJson(pass.rawResponse);
    const score = judgeResponseScore(pass.parsed, expectedNoAnswer);
    if (score >= 0) { pass.score = score; pass.valid = true; }
    else pass.error = pass.parsed ? 'malformed judge assertions/score' : 'judge response is not valid JSON';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pass.error = config.apiKey ? message.split(config.apiKey).join('[REDACTED]') : message;
  }
  return pass;
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

  TOKEN = await resolveGateToken(API_BASE, process.env);

  // Pre-flight probe. The 2026-09-27 run produced a 50-row report in which every
  // row was HTTP 401 and the summary still printed a 40% success rate; the score
  // existed because an empty answer satisfies several rules by construction.
  // One authenticated request before scoring means a bad credential ends the run
  // with a diagnosis instead of a number that can be misread as quality.
  {
    const probe = await apiJson('GET', '/api/v1/kbs?page=1&limit=1', TOKEN);
    if (probe.status === 401 || probe.status === 403) {
      console.error(
        `${colors.red}Quality gate aborted: the API rejected the gate credential (HTTP ${probe.status}).${colors.reset}`,
      );
      console.error('Set LLMWIKI_TOKEN/AUTH_TOKEN (or LLMWIKI_USER+LLMWIKI_PASS) to a credential the instance accepts, then re-run.');
      console.error('No report was written: an unauthenticated run measures nothing.');
      process.exit(1);
    }
    if (probe.status === 0 || probe.status >= 500) {
      console.error(
        `${colors.red}Quality gate aborted: the API did not answer the pre-flight probe (HTTP ${probe.status}).${colors.reset}`,
      );
      process.exit(1);
    }
  }

  const allScopes = dataset.map((item) => item.expected_kb_scope).filter((s) => s.length > 0);
  const scopeMap = await resolveScopeMap(allScopes);
  const requiredScopes = [...new Set(allScopes.flat())];
  console.log(`语料范围解析: ${scopeMap.size}/${requiredScopes.length} 个知识库已映射\n`);
  requireResolvedScopes(allScopes, scopeMap, API_BASE);

  interface Row {
    id: string; category: string; success: boolean;
    hitRate: boolean; citationAccuracy: boolean; noAnswer: boolean;
    permission: boolean; keywordCoverage: number; groundingPresence: boolean;
    faithfulness: number | null; contextPrecision: number; judged: boolean;
    answer: string; fullAnswer: string; question: string; judgeTrace?: JudgeTrace; citations: string[]; error?: string; llmJudge?: number;
    /**
     * Set when the case produced no score for an environmental reason (auth,
     * transport, timeout, corpus). Such a row is excluded from every metric:
     * scoring it would let an unreachable API satisfy the rules that are
     * vacuously true for an empty answer (see quality-gate-validity.ts).
     */
    envError?: string;
  }
  const results: Row[] = [];
  /** Cases in which the environment, not the system, decided the outcome. */
  let envErrorCount = 0;
  let totalScore = 0;

  for (const item of dataset) {
    process.stdout.write(`评估 ${item.id} [${item.category}] ${item.question.slice(0, 32)}... `);
    const scopeIds = item.expected_kb_scope
      .map((scope) => scopeMap.get(scope))
      .filter((id): id is string => Boolean(id));

    // An environmental failure here means the case was never scored, so it is
    // recorded and excluded from every metric instead of being scored against
    // rules that an empty answer satisfies by construction.
    const envFailure = (result: ChatResult): string | null => {
      const category = classifyResultError({ status: result.status, error: result.error });
      if (!isEnvironmentError(category)) return null;
      return `${category}: ${result.error || `HTTP ${result.status}`}`;
    };

    // Multi-turn cases: establish conversation context with the prior turns,
    // then ask the referencing question inside the same conversation.
    let conversationId: string | undefined;
    let envError: string | null = null;
    if (item.prior_turns?.length && !envError) {
      for (const prior of item.prior_turns) {
        const turn = await fetchChatCompletion(prior, scopeIds, conversationId);
        envError = envFailure(turn);
        if (envError) break;
        conversationId = turn.conversationId ?? conversationId;
      }
    }
    let res: ChatResult = envError
      ? { answer: '', citations: [], status: 0, error: envError }
      : await fetchChatCompletion(item.question, scopeIds, conversationId);
    if (!envError) envError = envFailure(res);

    // LLM answering is mildly nondeterministic: when the correct evidence WAS
    // retrieved (hitRate true) but the model refused, retry once with a nonce
    // so a stale cache entry or a temperature flake does not fail the gate.
    if (!envError) {
      const refused = REFUSAL_MARKERS.some((m) => res.answer.includes(m));
      const hitOnFirst = item.expected_document_titles.length === 0
        || item.expected_document_titles.some((t) => res.citations.some((c) => (c.doc_title || '').includes(t)));
      if (!item.expected_no_answer && refused && hitOnFirst) {
        const retry = await fetchChatCompletion(`${item.question}（复核）`, scopeIds);
        // A retry that fails environmentally must not overwrite a real first
        // answer: the first attempt is the measurement, the retry is a rescue.
        const retryEnvError = envFailure(retry);
        if (!retryEnvError) res = retry;
      }
    }

    if (envError) {
      envErrorCount += 1;
      console.log(`${colors.red}SKIP (environment)${colors.reset} ${envError.slice(0, 80)}`);
      results.push({
        id: item.id, category: item.category, success: false,
        hitRate: false, citationAccuracy: false, noAnswer: false,
        permission: false, keywordCoverage: 0, groundingPresence: false, faithfulness: null,
        contextPrecision: 0, judged: false,
        answer: res.answer.slice(0, 400), fullAnswer: res.answer, question: item.question, citations: [], error: envError, envError,
      });
      continue;
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
      ? res.answer.trim().length > 0 && finalRefused
      : res.answer.trim().length > 0 && !finalRefused;

    const keywordCoverage = item.expected_keywords.length > 0
      ? item.expected_keywords.filter((kw) => res.answer.includes(kw)).length / item.expected_keywords.length
      : 1;

    // Only independent entailment judgments measure faithfulness. Missing
    // measurements remain null rather than being replaced by citation proxies.
    let llmJudge: number | undefined;
    let judgeTrace: JudgeTrace | undefined;
    if (LLM_JUDGE_ENABLED) {
      const judgment = await judgeAnswer(item.question, res.answer, item.expected_keywords, res.citations, item.expected_no_answer);
      judgeTrace = judgment.trace;
      if (judgment.score >= 0) llmJudge = judgment.score;
    }
    const faithfulness = llmJudge ?? null;
    // Preserve the development gate's previous citation-presence guard, but
    // report it as a proxy rather than claiming it measures entailment.
    const groundingPresence = item.expected_no_answer || res.citations.length > 0
      || res.answer.length <= 20 || finalRefused;

    // Permission probe: any permission-boundary case must also reject an
    // out-of-scope KB request outright, proving scope is enforced.
    //
    // Only 403 counts. The previous rule accepted 401 as well, which made a
    // rejected credential indistinguishable from an enforced scope: on the
    // 2026-09-27 run every probe was 401 and 8 of 10 boundary cases were booked
    // as passing permission checks. A 401 here is an environment failure.
    let permission = true;
    if (item.unauthorized_users.length > 0 || item.category === 'permission_boundary') {
      const probe = await fetchChatCompletion(item.question, ['00000000-0000-4000-8000-000000000000']);
      if (probe.status === 401) {
        envErrorCount += 1;
        console.log(`${colors.red}SKIP (environment)${colors.reset} permission probe rejected the gate credential (HTTP 401)`);
        results.push({
          id: item.id, category: item.category, success: false,
          hitRate: false, citationAccuracy: false, noAnswer: false,
          permission: false, keywordCoverage: 0, groundingPresence: false, faithfulness: null,
          contextPrecision: 0, judged: false,
          answer: res.answer.slice(0, 400), fullAnswer: res.answer, question: item.question, judgeTrace, citations: titles, error: 'auth: permission probe rejected the credential',
          envError: 'auth: permission probe rejected the credential',
        });
        continue;
      }
      permission = probe.status === 403;
    }

    const success = noAnswer && (item.expected_no_answer || hitRate) && permission;
    if (success) totalScore++;

    console.log(success ? `${colors.green}✓ PASS${colors.reset}` : `${colors.red}✗ FAIL${colors.reset}`);

    results.push({
      id: item.id, category: item.category, success,
      hitRate, citationAccuracy, noAnswer, permission,
      keywordCoverage, groundingPresence, faithfulness, contextPrecision, judged: llmJudge !== undefined,
      answer: res.answer.slice(0, 400), fullAnswer: res.answer, question: item.question, judgeTrace, citations: titles, error: res.error, llmJudge,
    });
  }

  const total = dataset.length;
  // Environment failures produced no score, so every rate is computed over the
  // cases that were actually scored. Dividing by `total` would let an outage
  // depress the score, and dividing by `results.length` (which still contains
  // the skipped rows) would do the same. The verdict below decides whether the
  // scored subset is large enough to be reported at all.
  const scoredRows = results.filter((r) => !r.envError);
  const scored = scoredRows.length;
  const rate = (predicate: (row: Row) => boolean): number =>
    scored > 0 ? scoredRows.filter(predicate).length / scored : 0;
  const mean = (pick: (row: Row) => number): number =>
    scored > 0 ? scoredRows.reduce((acc, r) => acc + pick(r), 0) / scored : 0;

  const bounds = validityBounds();
  const verdict = evaluateValidity({
    scored,
    attempted: total,
    envErrors: envErrorCount,
    minScoredCases: bounds.minScoredCases,
    maxEnvErrorRate: bounds.maxEnvErrorRate,
  });

  const judgedCount = scoredRows.filter((r) => typeof r.llmJudge === 'number').length;
  const judgeCoveragePass = !LLM_JUDGE_ENABLED || (scored > 0 && judgedCount === scored);
  if (verdict.valid && !judgeCoveragePass) {
    verdict.valid = false;
    verdict.invalidReason = `independent judge incomplete: ${judgedCount}/${scored} cases completed all ${LLM_JUDGE_SAMPLES} passes`;
  }

  const agg = {
    hitRate: rate((r) => r.hitRate),
    keywordCoverage: mean((r) => r.keywordCoverage),
    permission: rate((r) => r.permission),
    noAnswer: rate((r) => r.noAnswer),
    citationAccuracy: rate((r) => r.citationAccuracy),
    groundingPresence: rate((r) => r.groundingPresence),
    faithfulness: (() => {
      const measured = scoredRows.filter((r) => r.faithfulness !== null);
      return measured.length ? measured.reduce((sum, r) => sum + r.faithfulness!, 0) / measured.length : null;
    })(),
    contextPrecision: mean((r) => r.contextPrecision),
    llmJudge: (() => {
      const judged = scoredRows.filter((r) => typeof r.llmJudge === 'number');
      return judged.length ? judged.reduce((acc, r) => acc + (r.llmJudge as number), 0) / judged.length : -1;
    })(),
  };

  const categories: Record<string, any> = {};
  for (const category of new Set(dataset.map((d) => d.category))) {
    const rows = results.filter((r) => r.category === category);
    const categoryRows = rows.filter((r) => !r.envError);
    categories[category] = {
      total: rows.length,
      scored: categoryRows.length,
      envErrors: rows.length - categoryRows.length,
      successRate: categoryRows.length ? categoryRows.filter((r) => r.success).length / categoryRows.length : null,
      hitRate: categoryRows.length ? categoryRows.filter((r) => r.hitRate).length / categoryRows.length : null,
      keywordCoverage: categoryRows.length
        ? categoryRows.reduce((acc, r) => acc + r.keywordCoverage, 0) / categoryRows.length
        : null,
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
      total, passed: totalScore,
      // Reported for debugging only; read `valid` first. An invalid run's rate
      // is not a quality measurement (see quality-gate-validity.ts).
      overallSuccessRate: scored > 0 ? totalScore / scored : 0,
      // The full verdict, not just a boolean: a non-null invalidReason is what
      // makes an invalid report actionable instead of merely red.
      validity: {
        valid: verdict.valid,
        invalidReason: verdict.invalidReason,
        envErrorRate: verdict.envErrorRate,
        scored,
        envErrors: envErrorCount,
        attempted: total,
        minScoredCases: bounds.minScoredCases,
        maxEnvErrorRate: bounds.maxEnvErrorRate,
      },
      valid: verdict.valid,
      invalidReason: verdict.invalidReason,
      metrics: agg, byCategory: categories,
      judge: {
        enabled: LLM_JUDGE_ENABLED,
        samplesPerAnswer: LLM_JUDGE_SAMPLES,
        minimum: LLM_JUDGE_MIN,
        judgedCount,
        coverage: scored > 0 ? judgedCount / scored : 0,
        coveragePass: judgeCoveragePass,
        faithfulnessMeasured: scored > 0 && judgedCount === scored,
        model: LLM_JUDGE_ENABLED ? llmConfig()?.modelName ?? null : null,
        config: LLM_JUDGE_ENABLED ? safeJudgeConfiguration() : null,
        meanSampleSpread: judgeSampleSpreads.length
          ? judgeSampleSpreads.reduce((a, b) => a + b, 0) / judgeSampleSpreads.length
          : null,
        maxSampleSpread: judgeSampleSpreads.length ? Math.max(...judgeSampleSpreads) : null,
      },
    },
    results,
  }, null, 2));

  const llmJudgePass = LLM_JUDGE_MIN <= 0 || (agg.llmJudge >= 0 && agg.llmJudge >= LLM_JUDGE_MIN);

  const checks: Array<[string, number, number, boolean]> = [
    ['Hit Rate', THRESHOLDS.hitRate, agg.hitRate, agg.hitRate >= THRESHOLDS.hitRate],
    ['Keyword Coverage', THRESHOLDS.keywordCoverage, agg.keywordCoverage, agg.keywordCoverage >= THRESHOLDS.keywordCoverage],
    ['Permission', THRESHOLDS.permission, agg.permission, agg.permission >= THRESHOLDS.permission],
    ['No-Answer', THRESHOLDS.noAnswer, agg.noAnswer, agg.noAnswer >= THRESHOLDS.noAnswer],
    ['Citation Accuracy', THRESHOLDS.citationAccuracy, agg.citationAccuracy, agg.citationAccuracy >= THRESHOLDS.citationAccuracy],
    ['Context Precision', THRESHOLDS.contextPrecision, agg.contextPrecision, agg.contextPrecision >= THRESHOLDS.contextPrecision],
  ];
  if (LLM_JUDGE_ENABLED) {
    checks.push(
      ['Faithfulness', THRESHOLDS.faithfulness, agg.faithfulness ?? -1, agg.faithfulness !== null && agg.faithfulness >= THRESHOLDS.faithfulness],
      ['LLM Judge (independent)', LLM_JUDGE_MIN, agg.llmJudge, llmJudgePass],
      ['LLM Judge Coverage', 1, scored > 0 ? judgedCount / scored : 0, judgeCoveragePass],
    );
  } else {
    checks.push(['Grounding Presence (proxy)', THRESHOLDS.faithfulness, agg.groundingPresence, agg.groundingPresence >= THRESHOLDS.faithfulness]);
  }

  if (!verdict.valid) {
    // Print the counts, then refuse to present them as a result. The banner is
    // explicit so a reader skimming output cannot mistake the numbers below for
    // a quality measurement.
    console.log(`\n${colors.red}========================================${colors.reset}`);
    console.log(`${colors.red}  INVALID RUN - NOT A QUALITY RESULT     ${colors.reset}`);
    console.log(`${colors.red}========================================${colors.reset}`);
    console.log(`Reason: ${verdict.invalidReason}`);
    console.log(`Attempted: ${total}  Scored: ${scored}  Environment errors: ${envErrorCount} (${(verdict.envErrorRate * 100).toFixed(1)}%)`);
    console.log(`Report (for debugging only): ${reportPath}`);
    console.log(`\n${colors.red}  QUALITY GATE FAILED (invalid run)${colors.reset}`);
    process.exit(1);
  }

  console.log(`\n${colors.cyan}--- Quality Gate Summary ---${colors.reset}`);
  console.log(`Total: ${total}  Scored: ${scored}  Env errors: ${envErrorCount}  Passed: ${totalScore} (${((totalScore / Math.max(1, scored)) * 100).toFixed(1)}%)\n`);
  if (!LLM_JUDGE_ENABLED) console.log('Faithfulness: NOT MEASURED (development run; release requires GATE_STRICT=1).');
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
