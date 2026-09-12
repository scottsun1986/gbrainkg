import { Injectable, Logger } from '@nestjs/common';
import { ModelConfigService } from '../model-config.service';

export type QueryComplexity = 'simple' | 'multi_hop' | 'comparative' | 'global_synthesis';

export interface DecomposedQuery {
  originalQuery: string;
  complexity: QueryComplexity;
  subQueries: string[];
  reasoning: string;
}

export interface RetrievalJudgment {
  status: 'sufficient' | 'insufficient' | 'irrelevant';
  missingAspects: string[];
  suggestedFollowUp: string[];
  confidence: number;
  reasoning?: string;
  hopNumber?: number;
}

export interface JudgeSufficiencyOptions {
  complexity?: QueryComplexity;
  subQueries?: string[];
  executedProbes?: string[];
}

@Injectable()
export class AgenticRagService {
  private readonly logger = new Logger(AgenticRagService.name);
  private readonly enabled = process.env.AGENTIC_RAG_ENABLED !== 'false';
  private readonly maxHops = Number(process.env.AGENTIC_RAG_MAX_HOPS || '3');

  constructor(private readonly modelConfigService: ModelConfigService) {}

  /**
   * Classify query complexity to determine retrieval strategy.
   * Uses heuristics first, falls back to LLM for ambiguous cases.
   */
  async classifyQuery(query: string): Promise<QueryComplexity> {
    if (!this.enabled) return 'simple';
    
    const q = query.trim();
    
    // Heuristic classification
    // Comparative patterns
    if (/比较|对比|区别|不同|差异|vs|versus|相比|冲突|矛盾|不一致|两个文档|两份文档|多份文档|两个版本|两份|多份|哪个为准|新旧|哪份/u.test(q)) return 'comparative';
    // Global synthesis patterns  
    if (/所有|全部|总结|概述|哪些|列举|汇总|主要.*有|一共|共有|总共|多少条|几条|多少章|几章|全文结构|架构体系/u.test(q)) return 'global_synthesis';
    // Multi-hop patterns
    if (/(.*的.*的|.*中.*关于|根据.*那么|如果.*则.*怎么)/u.test(q) && q.length > 20) return 'multi_hop';
    // Multiple question marks or conjunctions
    if ((q.match(/？|\?/g) || []).length > 1) return 'multi_hop';
    if (/并且|同时|以及|而且|另外|还有|再加上/u.test(q) && q.length > 20) return 'multi_hop';
    // Structural compound detection: the question splits into multiple
    // self-contained clauses ("A怎么样，另外B如何"), regardless of which
    // conjunction happens to be used.
    const clauseParts = q
      .split(/[,，?？;；]|并且|另外|以及|同时|还有|再加上/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4);
    if (clauseParts.length >= 2) return 'multi_hop';

    return 'simple';
  }

  /**
   * Decompose a complex query into simpler sub-queries.
   * Each sub-query can be independently retrieved and answered.
   */
  async decomposeQuery(query: string, complexity: QueryComplexity): Promise<DecomposedQuery> {
    if (!this.enabled || complexity === 'simple') {
      return {
        originalQuery: query,
        complexity,
        subQueries: [query],
        reasoning: 'Simple query, no decomposition needed.',
      };
    }

    try {
      const config = await this.getLlmConfig();
      if (!config) {
        return { originalQuery: query, complexity, subQueries: [query], reasoning: 'No LLM config available.' };
      }

      const systemPrompt = `你是一个查询分解专家。将复杂问题拆解为 2-4 个可独立检索的子问题。

规则：
1. 每个子问题必须是独立的、可以单独在知识库中检索的问题
2. 子问题合起来应该能完整回答原始问题
3. 对比/冲突类问题：分别查询各方比较对象或制度的不同表述（严禁在子问题中使用“第一份文档”、“第二份文档”等无意义代词，而应转换为该主题在不同制度/版本中的具体关键词或不同规范表述，如“考勤管理制度 作息时间”、“考勤制度手册 工作时间”）
4. 多跳类问题：按推理链的步骤拆解
5. 综合类问题：按主题或维度拆解

输出 json 格式（合法的 JSON，严禁出现省略号）：
{"subQueries": ["子问题1", "子问题2"], "reasoning": "拆解理由"}`;

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `请拆解以下问题：${query}` },
          ],
          temperature: 0,
          max_tokens: Number(process.env.AGENTIC_DECOMPOSE_MAX_TOKENS || 450),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload: any = await response.json();
      let content = this.assistantText(payload);
      if (!content) throw new Error('empty completion content (token budget or reasoning model)');
      let parsed: any = null;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[0] : content;
        const cleanedStr = jsonStr.replace(/,\s*\.\.\./g, '').replace(/\.\.\./g, '');
        parsed = JSON.parse(cleanedStr);
      } catch (e) {
        const arrMatch = content.match(/\[([\s\S]*?)\]/);
        if (arrMatch) {
          const items = (arrMatch[1].match(/"([^"]+)"|'([^']+)'/g) || [])
            .map((s) => s.replace(/^["']|["']$/g, '').trim())
            .filter((s) => s.length >= 2 && !s.includes('子问题') && !s.includes('...'));
          if (items.length > 0) {
            parsed = { subQueries: items, reasoning: '' };
          }
        }
      }
      const subQueries = Array.isArray(parsed?.subQueries) 
        ? parsed.subQueries.filter((q: any) => typeof q === 'string' && q.trim().length > 0 && !q.includes('...')).slice(0, 4)
        : [query];

      this.logger.log(`Decomposed query into ${subQueries.length} sub-queries: ${subQueries.join(' | ')}`);

      return {
        originalQuery: query,
        complexity,
        subQueries: subQueries.length > 0 ? subQueries : [query],
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      this.logger.warn(`Query decomposition failed: ${err instanceof Error ? err.message : String(err)}`);
      return { originalQuery: query, complexity, subQueries: [query], reasoning: 'Decomposition failed, using original query.' };
    }
  }

  /**
   * HyDE (Hypothetical Document Embeddings, Gao et al., 2022): ask the model
   * to draft a short, plausible expert passage that would answer the question.
   * That passage is then used as an additional retrieval arm, bridging the
   * vocabulary gap between colloquial questions and formal policy wording.
   * Returns null when disabled, unconfigured, or on any failure.
   */
  async generateHypotheticalDocument(query: string): Promise<string | null> {
    if (!this.enabled || process.env.HYDE_ENABLED === 'false') return null;
    try {
      const config = await this.getLlmConfig();
      if (!config) return null;
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            {
              role: 'system',
              content: '你是企业制度文档撰写专家。请针对用户问题，直接写一段可能出现在正式规章制度/技术规范中的专业文本（150-300字），尽量包含准确的专业术语、条款编号风格与具体数值。只输出正文，不要解释、不要标题、不要客套。',
            },
            { role: 'user', content: query },
          ],
          temperature: 0.1,
          max_tokens: Number(process.env.HYDE_MAX_TOKENS || 400),
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: any = await response.json();
      const content = this.assistantText(payload);
      if (!content) {
        this.logger.warn('HyDE completion returned empty content; skipping HyDE arm.');
        return null;
      }
      this.logger.debug(`Generated HyDE passage (${content.length} chars) for query.`);
      return content.slice(0, 800);
    } catch (err) {
      this.logger.warn(`HyDE generation failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * General, corpus-agnostic query expansion. Instead of maintaining a
   * hardcoded synonym table (which can never be exhaustive), ask the model to
   * produce the formal/standard terms, synonyms and related policy vocabulary
   * that a document is likely to use. Examples: 夏天→夏令时, 打车→交通费,
   * 裁员→解除劳动合同. Results are cached in-process because the same query is
   * often re-issued (retries, multiple turns).
   */
  async expandQuery(query: string): Promise<string[]> {
    if (!this.enabled || process.env.QUERY_EXPANSION_ENABLED === 'false') return [];
    const cacheKey = query.trim();
    const cached = this.expansionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.terms;
    try {
      const config = await this.getLlmConfig();
      if (!config) return [];
      const buildBody = (jsonMode: boolean) => JSON.stringify({
        model: config.modelName,
        messages: [
          {
            role: 'system',
            content: `你是企业知识库检索助手。针对用户问题，产出有助于检索的同义词、正式/规范表述与相关制度术语，用于弥合口语与制度文本之间的用词差异。
要求：
1. 只输出 json：{"expansions": ["词1", "词2", ...]}
2. 3-6 个，每个是简短检索词或短语（不要整句）
3. 覆盖：同义词、正式/行业规范用语、相关制度术语、可能的别名（如季节性作息称"夏令时/冬令时"）
4. 不要解释，不要编号`,
          },
          { role: 'user', content: query },
        ],
        temperature: 0,
        max_tokens: Number(process.env.QUERY_EXPANSION_MAX_TOKENS || 300),
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      let response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: config.headers,
        body: buildBody(true),
        signal: AbortSignal.timeout(Number(process.env.QUERY_EXPANSION_TIMEOUT_MS || 10000)),
      });
      // Some providers reject response_format for certain models (HTTP 400):
      // retry once without JSON mode, extracting the JSON from the text.
      if (response.status === 400) {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: config.headers,
          body: buildBody(false),
          signal: AbortSignal.timeout(Number(process.env.QUERY_EXPANSION_TIMEOUT_MS || 10000)),
        });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: any = await response.json();
      let content = this.assistantText(payload);
      let parsed: any = null;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else parsed = JSON.parse(content);
      } catch (e) {
        const arrMatch = content.match(/\[([\s\S]*?)\]/);
        if (arrMatch) {
          try {
            const arr = JSON.parse(`[${arrMatch[1]}]`);
            parsed = { expansions: arr };
          } catch (e2) {}
        }
      }
      const rawExpansions = parsed?.expansions || (Array.isArray(parsed) ? parsed : []);
      const terms = Array.isArray(rawExpansions)
        ? rawExpansions
            .filter((t: any) => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 30)
            .map((t: string) => t.trim())
            .slice(0, 6)
        : [];
      this.expansionCache.set(cacheKey, { terms, expiresAt: Date.now() + 10 * 60 * 1000 });
      if (this.expansionCache.size > 500) {
        const oldest = this.expansionCache.keys().next().value;
        if (oldest) this.expansionCache.delete(oldest);
      }
      if (terms.length) this.logger.debug(`Expanded query with ${terms.length} retrieval terms: ${terms.join(' | ')}`);
      return terms;
    } catch (err) {
      this.logger.warn(`Query expansion failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private readonly expansionCache = new Map<string, { terms: string[]; expiresAt: number }>();

  /**
   * Unified query planner: combines sub-query decomposition and canonical
   * institutional terminology expansion into a SINGLE LLM round trip, cutting
   * query planning API calls from 3 down to 1.
   */
  async planComplexQuery(
    query: string,
    complexity: QueryComplexity,
  ): Promise<{ subQueries: string[]; expansions: string[]; reasoning: string }> {
    if (!this.enabled || complexity === 'simple') {
      return { subQueries: [query], expansions: [], reasoning: '' };
    }

    try {
      const config = await this.getLlmConfig();
      if (!config) {
        return { subQueries: [query], expansions: [], reasoning: 'No LLM config available.' };
      }

      const systemPrompt = `你是一个企业知识库检索规划专家。请针对用户复杂问题进行双重检索规划：
1. 子问题拆解（subQueries）：拆解为 2-3 个可独立在知识库检索的子问题（对比/冲突类问题必须分别查询各方比较对象或不同制度的表述，严禁使用“第一份文档”、“第二份文档”等无意义代词）。
2. 规范术语扩展（expansions）：给出 3-5 个有助于弥合口语与正式制度文本差异的正式术语、行业规范用语或制度相关词汇（如夏令时/冬令时、标准工时等）。

输出合法 JSON：
{
  "subQueries": ["子问题1", "子问题2"],
  "expansions": ["扩展术语1", "扩展术语2"],
  "reasoning": "简要规划理由"
}`;

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `请规划以下问题：${query}` },
          ],
          temperature: 0,
          max_tokens: Number(process.env.AGENTIC_PLAN_MAX_TOKENS || 450),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload: any = await response.json();
      const content = this.assistantText(payload);
      if (!content) throw new Error('empty completion content');

      let parsed: any = null;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      } catch (e) {
        parsed = {};
      }

      const subQueries = Array.isArray(parsed?.subQueries)
        ? parsed.subQueries.filter((q: any) => typeof q === 'string' && q.trim().length > 0 && !q.includes('...')).slice(0, 4)
        : [query];

      const expansions = Array.isArray(parsed?.expansions)
        ? parsed.expansions.filter((t: any) => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 30).slice(0, 6)
        : [];

      return {
        subQueries: subQueries.length > 0 ? subQueries : [query],
        expansions,
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      this.logger.warn(`Unified query planning failed: ${err instanceof Error ? err.message : String(err)}`);
      return { subQueries: [query], expansions: [], reasoning: '' };
    }
  }

  /**
   * Build the full agentic retrieval plan: complexity, expanded retrieval terms,
   * decomposed sub-queries, and an optional HyDE passage.
   * Simple queries bypass expansion when exact; complex queries use a unified
   * single-call planner (subQueries + expansions in 1 call) unless disabled.
   */
  async planQuery(query: string): Promise<{
    complexity: QueryComplexity;
    expansions: string[];
    subQueries: string[];
    hyde: string | null;
  }> {
    const complexity = await this.classifyQuery(query);
    if (complexity === 'simple') {
      // Direct pass for exact clauses (e.g. 第十条) to avoid unnecessary LLM expansion
      const isExactClause = /第\s*[\d一二三四五六七八九十百千万〇零两]+\s*[章节条款项]|附件/u.test(query);
      if (isExactClause) {
        return { complexity, expansions: [], subQueries: [query], hyde: null };
      }
      // Plain factual questions skip the LLM expansion round trip entirely:
      // the hybrid recall arms (vector + keyword + rerank) already cover them,
      // and the planning call only delays the first token. Restore the old
      // behaviour with AGENTIC_SIMPLE_EXPANSION=true.
      if (process.env.AGENTIC_SIMPLE_EXPANSION !== 'true') {
        return { complexity, expansions: [], subQueries: [query], hyde: null };
      }
      const expansions = await this.expandQuery(query);
      return { complexity, expansions, subQueries: [query], hyde: null };
    }

    const useUnified = process.env.AGENTIC_UNIFIED_PLAN !== 'false';
    if (useUnified) {
      const planPromise = this.planComplexQuery(query, complexity);
      const hydePromise = process.env.HYDE_ENABLED === 'true'
        ? this.generateHypotheticalDocument(query)
        : Promise.resolve(null);
      const [plan, hyde] = await Promise.all([planPromise, hydePromise]);

      const llmSubs = (plan.subQueries || [])
        .map((q) => String(q || '').trim())
        .filter((q) => q.length >= 4 && q !== query.trim());

      const deterministicSubs = llmSubs.length > 0
        ? llmSubs
        : query
            .split(/[,，?？;；。]|并且|另外|以及|同时|还有|再加上/)
            .map((part) => part.trim())
            .filter((part) => part.length >= 4 && part !== query.trim())
            .slice(0, 3);

      return {
        complexity,
        expansions: plan.expansions,
        subQueries: deterministicSubs.length ? deterministicSubs : [query],
        hyde,
      };
    }

    const [decomposed, hyde, expansions] = await Promise.all([
      this.decomposeQuery(query, complexity),
      this.generateHypotheticalDocument(query),
      this.expandQuery(query),
    ]);
    const llmSubs = (decomposed.subQueries || [])
      .map((q) => String(q || '').trim())
      .filter((q) => q.length >= 4 && q !== query.trim());
    const deterministicSubs = llmSubs.length > 0
      ? llmSubs
      : query
          .split(/[,，?？;；。]|并且|另外|以及|同时|还有|再加上/)
          .map((part) => part.trim())
          .filter((part) => part.length >= 4 && part !== query.trim())
          .slice(0, 3);
    return {
      complexity,
      expansions,
      subQueries: deterministicSubs.length ? deterministicSubs : [query],
      hyde,
    };
  }

  /**
   * Judge whether retrieved context is sufficient to answer the query.
   * Returns guidance on what's missing and suggested follow-up queries.
   */
  async judgeRetrievalSufficiency(
    query: string,
    retrievedContext: string,
    iterationCount: number,
    options?: JudgeSufficiencyOptions,
  ): Promise<RetrievalJudgment> {
    if (!this.enabled || iterationCount >= this.maxHops) {
      return {
        status: 'sufficient',
        missingAspects: [],
        suggestedFollowUp: [],
        confidence: 0.85,
        reasoning: iterationCount >= this.maxHops ? `已达到最大跳数限制 (${this.maxHops})，强制闭环生成` : 'Agentic RAG 已禁用',
        hopNumber: iterationCount,
      };
    }

    // If no context at all, definitely irrelevant/insufficient
    if (!retrievedContext || !retrievedContext.trim()) {
      return {
        status: 'irrelevant',
        missingAspects: ['知识库中未检索到与问题相关的直接证据'],
        suggestedFollowUp: [query],
        confidence: 0.1,
        reasoning: '首轮未检索到任何候选内容',
        hopNumber: iterationCount,
      };
    }

    const executedSet = new Set(
      (options?.executedProbes || [query]).map((p) => p.trim().toLowerCase()),
    );

    // Heuristic entity coverage & subquery gap detection
    const heuristicGaps = this.analyzeHeuristicCoverage(query, retrievedContext, options);

    // ── Fast-Pass Heuristic: skip LLM when evidence is demonstrably complete ──
    if (heuristicGaps.missingAspects.length === 0) {
      const docTitles = new Set((retrievedContext.match(/《([^》]+)》/g) || []).map((t) => t.replace(/[《》]/g, '').trim()));
      if (options?.complexity === 'comparative' && docTitles.size >= 2) {
        this.logger.debug('Sufficiency Fast-Pass: comparative entities and multi-doc evidence fully covered by heuristic.');
        return {
          status: 'sufficient',
          missingAspects: [],
          suggestedFollowUp: [],
          confidence: 0.95,
          reasoning: '启发式验证已完整覆盖对比双方文档与全部关键维度',
          hopNumber: iterationCount,
        };
      }
    }

    // ── Fast-Fail Heuristic: skip LLM when a conflict question clearly lacks the second doc ──
    if (/冲突|矛盾|不一致|两个文档|两份文档|多份文档|两个版本|两份|多份|哪个为准|新旧|为何没有都出来|为什么没有都出来/u.test(query)) {
      const docTitles = new Set((retrievedContext.match(/《([^》]+)》/g) || []).map((t) => t.replace(/[《》]/g, '').trim()));
      if (docTitles.size < 2 && heuristicGaps.suggestedFollowUp.length > 0) {
        const freshFollowUps = heuristicGaps.suggestedFollowUp.filter((p) => !executedSet.has(p.trim().toLowerCase()));
        if (freshFollowUps.length > 0) {
          this.logger.debug('Sufficiency Fast-Fail: conflict question lacks second document, immediately triggering hop.');
          return {
            status: 'insufficient',
            missingAspects: heuristicGaps.missingAspects,
            suggestedFollowUp: freshFollowUps.slice(0, 2),
            confidence: 0.9,
            reasoning: '多文档对比/冲突问题仅检索到单份文档，定向补充检索另一份制度',
            hopNumber: iterationCount,
          };
        }
      }
    }

    try {
      const config = await this.getLlmConfig();
      if (!config) {
        // Fallback to deterministic heuristic judgment
        if (heuristicGaps.missingAspects.length > 0) {
          const freshFollowUps = heuristicGaps.suggestedFollowUp.filter(
            (p) => !executedSet.has(p.trim().toLowerCase()),
          );
          if (freshFollowUps.length > 0) {
            return {
              status: 'insufficient',
              missingAspects: heuristicGaps.missingAspects,
              suggestedFollowUp: freshFollowUps.slice(0, 2),
              confidence: 0.7,
              reasoning: '启发式分析检测到对比实体或关键维度证据缺失',
              hopNumber: iterationCount,
            };
          }
        }
        return {
          status: 'sufficient',
          missingAspects: [],
          suggestedFollowUp: [],
          confidence: 0.7,
          reasoning: '启发式判定当前证据充分',
          hopNumber: iterationCount,
        };
      }

      const executedListStr = Array.from(executedSet).slice(0, 8).join(' | ');
      const systemPrompt = `你是一个企业知识库检索充分性裁决专家（Sufficiency Evaluator）。
请严谨判断当前检索到的上下文证据（Context）是否足以完整回答用户问题（Query）。

裁决规则：
1. 【对比类问题 (Comparative)】：必须确保被对比的全部实体/阶段/方案均有对应证据。如果仅有A而缺乏B的证据，必须判定为 insufficient，并在 missingAspects 中明确指出缺少B，suggestedFollowUp 给出针对B的定向检索词。
2. 【多跳因果/实体关联问题 (Multi-Hop)】：必须覆盖多步推理依赖的上下文。若缺少推理链的前置条件或后置依据，判定为 insufficient，并给出下一跳检索词。
3. 【禁止重复检索】：已执行过的检索词列表为：[${executedListStr}]。suggestedFollowUp 中严禁出现或微调这些已执行过的词，必须给出更具体或不同维度的检索词（最多2个）。
4. 【无幻觉准则】：若证据完全不相关，输出 irrelevant；若已有充分证据可得出完整结论，输出 sufficient。

输出严格 JSON 格式：
{
  "status": "sufficient" | "insufficient" | "irrelevant",
  "confidence": 0.0 - 1.0,
  "reasoning": "简要裁决理由（50字以内）",
  "missingAspects": ["缺失的维度/实体/条款"],
  "suggestedFollowUp": ["下一跳建议查询词"]
}`;

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `用户问题: ${query}\n问题类型: ${options?.complexity || 'auto'}\n\n已检索到的候选证据 (前 3000 字):\n${retrievedContext.slice(0, 3000)}\n\n请严格评估证据充分性：`,
            },
          ],
          temperature: 0,
          max_tokens: Number(process.env.AGENTIC_RAG_JUDGE_MAX_TOKENS || 350),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(Number(process.env.AGENTIC_RAG_JUDGE_TIMEOUT_MS || 15000)),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload: any = await response.json();
      let content = this.assistantText(payload);
      let parsed: any = null;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else parsed = JSON.parse(content);
      } catch (e) {
        const statusMatch = content.match(/"status"\s*:\s*"([^"]+)"/);
        const reasoningMatch = content.match(/"reasoning"\s*:\s*"([^"]+)"/);
        parsed = {
          status: statusMatch ? statusMatch[1] : 'sufficient',
          reasoning: reasoningMatch ? reasoningMatch[1] : '',
          suggestedFollowUp: [],
          missingAspects: [],
        };
      }
      const rawStatus = ['sufficient', 'insufficient', 'irrelevant'].includes(parsed?.status)
        ? parsed.status
        : 'sufficient';

      // Deduplicate follow-up queries against already executed probes
      const rawFollowUps: string[] = Array.isArray(parsed.suggestedFollowUp)
        ? parsed.suggestedFollowUp
            .map((s: any) => String(s || '').trim())
            .filter((s: string) => s.length >= 2 && !executedSet.has(s.toLowerCase()))
        : [];

      // Combine with heuristic gaps if LLM missed an obvious entity disparity
      const mergedFollowUps = Array.from(
        new Set([
          ...rawFollowUps,
          ...heuristicGaps.suggestedFollowUp.filter((s) => !executedSet.has(s.toLowerCase())),
        ]),
      ).slice(0, 2);

      const status = rawStatus === 'insufficient' && mergedFollowUps.length === 0
        ? 'sufficient'
        : rawStatus;

      const missingAspects = Array.isArray(parsed.missingAspects) && parsed.missingAspects.length
        ? parsed.missingAspects.slice(0, 3)
        : heuristicGaps.missingAspects.slice(0, 3);

      return {
        status,
        missingAspects,
        suggestedFollowUp: status === 'insufficient' ? mergedFollowUps : [],
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
        reasoning: parsed.reasoning || (status === 'sufficient' ? '当前检索证据已充分覆盖问题要点' : '存在未覆盖的关键实体或信息维度'),
        hopNumber: iterationCount,
      };
    } catch (err) {
      this.logger.warn(`Retrieval judgment failed: ${err instanceof Error ? err.message : String(err)}`);
      // Fail-safe deterministic fallback
      if (heuristicGaps.missingAspects.length > 0) {
        const freshFollowUps = heuristicGaps.suggestedFollowUp.filter(
          (p) => !executedSet.has(p.trim().toLowerCase()),
        );
        if (freshFollowUps.length > 0) {
          return {
            status: 'insufficient',
            missingAspects: heuristicGaps.missingAspects,
            suggestedFollowUp: freshFollowUps.slice(0, 2),
            confidence: 0.7,
            reasoning: '启发式分析检测到未覆盖的对比实体或子查询',
            hopNumber: iterationCount,
          };
        }
      }
      return {
        status: 'sufficient',
        missingAspects: [],
        suggestedFollowUp: [],
        confidence: 0.6,
        reasoning: '判别模型响应超时或异常，安全放行至生成阶段',
        hopNumber: iterationCount,
      };
    }
  }

  /**
   * Deterministic entity and subquery coverage analyzer.
   * Detects if one side of a comparison or one decomposed branch has 0 hits.
   */
  private analyzeHeuristicCoverage(
    query: string,
    context: string,
    options?: JudgeSufficiencyOptions,
  ): { missingAspects: string[]; suggestedFollowUp: string[] } {
    const missingAspects: string[] = [];
    const suggestedFollowUp: string[] = [];
    const ctxLower = context.toLowerCase();

    // 1. Comparative entity detection: "A与B的区别", "比较A和B", "A相比B有什么不同"
    const compMatch = query.match(
      /(?:比较|对比)?\s*([^\s与和跟同相比以及及差异区别]+?)\s*(?:与|和|跟|同|相比|及)\s*([^\s与和跟同相比以及及差异区别]+?)(?:的)?(?:区别|差异|不同|对比|比较|优缺点)/u,
    );
    if (compMatch) {
      const cleanEntity = (e: string) => e.replace(/(?:的|关于)?(?:参数|指标|要求|规定|内容|标准|条款|方案|流程|阶段)?$/u, '').trim();
      const entityA = compMatch[1].trim();
      const entityB = compMatch[2].trim();
      const cleanA = cleanEntity(entityA);
      const cleanB = cleanEntity(entityB);
      if (entityA.length >= 2 && entityB.length >= 2) {
        const hasA = ctxLower.includes(entityA.toLowerCase()) || (cleanA.length >= 2 && ctxLower.includes(cleanA.toLowerCase()));
        const hasB = ctxLower.includes(entityB.toLowerCase()) || (cleanB.length >= 2 && ctxLower.includes(cleanB.toLowerCase()));
        if (hasA && !hasB) {
          missingAspects.push(`缺少对比实体“${cleanB || entityB}”的相关信息`);
          suggestedFollowUp.push(`${cleanB || entityB} 相关规范与要求`);
        } else if (!hasA && hasB) {
          missingAspects.push(`缺少对比实体“${cleanA || entityA}”的相关信息`);
          suggestedFollowUp.push(`${cleanA || entityA} 相关规范与要求`);
        }
      }
    }

    // 1.5 Multi-document conflict or discrepancy mention in query
    if (/冲突|矛盾|不一致|两个文档|两份文档|多份文档|两个版本|两份|多份|哪个为准|新旧|为何没有都出来|为什么没有都出来/u.test(query)) {
      const docTitles = new Set((context.match(/《([^》]+)》/g) || []).map((t) => t.replace(/[《》]/g, '').trim()));
      if (docTitles.size < 2) {
        missingAspects.push('用户询问冲突或多文档对比，但当前上下文仅检索到单份文档，缺少另一份冲突/对照文档证据');
        const coreTopic = query.replace(/.*?(关于|对于|是什么|有哪些|冲突|矛盾|不一致|两个文档|两份文档|多份文档|为何没有都出来|为什么没有都出来|。|，|\?|？)/gu, '').trim() || '相关规定';
        suggestedFollowUp.push(`${coreTopic} 制度 规定 办法 手册`);
      }
    }

    // 2. SubQueries coverage
    if (options?.subQueries && options.subQueries.length > 1) {
      for (const sub of options.subQueries) {
        const cleanedSub = sub.replace(/[？?。！!,，\s]+/g, '').trim();
        if (cleanedSub.length >= 4 && !ctxLower.includes(cleanedSub.toLowerCase())) {
          const grams = [];
          for (let i = 0; i < cleanedSub.length - 1; i += 2) grams.push(cleanedSub.slice(i, i + 2));
          const hitCount = grams.filter((g) => ctxLower.includes(g.toLowerCase())).length;
          if (hitCount === 0) {
            missingAspects.push(`未覆盖子问题：“${sub}”`);
            suggestedFollowUp.push(sub);
          }
        }
      }
    }

    return { missingAspects, suggestedFollowUp };
  }

  /**
   * Extract usable assistant text. Reasoning models (e.g. deepseek-v4-flash)
   * may return an empty `content` and place the text in `reasoning_content`.
   * For those, recover the final drafted passage from the tail of the
   * reasoning trace rather than discarding the answer entirely.
   */
  private assistantText(payload: any): string {
    const message = payload?.choices?.[0]?.message || {};
    const content = String(message.content || '').trim();
    if (content) return content;
    const reasoning = String(message.reasoning_content || message.reasoning || '').trim();
    if (!reasoning) return '';
    const jsonBlock = reasoning.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonBlock) return jsonBlock[1];
    const rawJson = reasoning.match(/\{[\s\r\n]*"(?:expansions|status|subQueries|complexity|plan)"[\s\S]*?\}/);
    if (rawJson) return rawJson[0];
    return this.extractDraftFromReasoning(reasoning);
  }

  private extractDraftFromReasoning(reasoning: string): string {
    // Prefer the text after the last drafting cue, then after the last blank
    // line. Fall back to the tail of the reasoning trace.
    const cues = ['起草：', '草稿：', '正文：', '答复：', '答案：'];
    let body = reasoning;
    for (const cue of cues) {
      const idx = body.lastIndexOf(cue);
      if (idx >= 0) {
        body = body.slice(idx + cue.length);
        break;
      }
    }
    if (body === reasoning) {
      const parts = reasoning.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) body = parts[parts.length - 1];
    }
    body = body.replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
    return body.length >= 30 ? body : reasoning.slice(-600);
  }

  private async getLlmConfig(): Promise<{ baseUrl: string; modelName: string; headers: Record<string, string> } | null> {
    // Page-configured default LLM + provider-required headers, via the single
    // shared resolver (no hardcoded model name).
    const resolved = await this.modelConfigService.getLlmChatConfig('llmwiki-agentic');
    if (!resolved) return null;
    return { baseUrl: resolved.baseUrl, modelName: resolved.modelName, headers: resolved.headers };
  }
}
