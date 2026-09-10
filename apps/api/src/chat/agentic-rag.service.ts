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
    if (/比较|对比|区别|不同|差异|vs|versus|相比/u.test(q)) return 'comparative';
    // Global synthesis patterns  
    if (/所有|全部|总结|概述|哪些|列举|汇总|主要.*有/u.test(q) && q.length > 15) return 'global_synthesis';
    // Multi-hop patterns
    if (/(.*的.*的|.*中.*关于|根据.*那么|如果.*则.*怎么)/u.test(q) && q.length > 20) return 'multi_hop';
    // Multiple question marks or conjunctions
    if ((q.match(/？|\?/g) || []).length > 1) return 'multi_hop';
    if (/并且|同时|以及|而且/u.test(q) && q.length > 20) return 'multi_hop';
    
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
3. 对比类问题：分别查询每个比较对象
4. 多跳类问题：按推理链的步骤拆解
5. 综合类问题：按主题或维度拆解

输出 JSON 格式：
{"subQueries": ["子问题1", "子问题2", ...], "reasoning": "拆解理由"}`;

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `请拆解以下问题：${query}` },
          ],
          temperature: 0,
          // Reasoning-capable models may spend tokens on hidden reasoning, so a
          // too-small budget yields empty `content`. Keep enough headroom for
          // the JSON answer.
          max_tokens: Number(process.env.AGENTIC_DECOMPOSE_MAX_TOKENS || 2000),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload: any = await response.json();
      let content = this.assistantText(payload);
      if (!content) throw new Error('empty completion content (token budget or reasoning model)');
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) content = jsonMatch[0];
      
      const parsed = JSON.parse(content);
      const subQueries = Array.isArray(parsed.subQueries) 
        ? parsed.subQueries.filter((q: any) => typeof q === 'string' && q.trim().length > 0).slice(0, 4)
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
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
          max_tokens: Number(process.env.HYDE_MAX_TOKENS || 1200),
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
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            {
              role: 'system',
              content: `你是企业知识库检索助手。针对用户问题，产出有助于检索的同义词、正式/规范表述与相关制度术语，用于弥合口语与制度文本之间的用词差异。
要求：
1. 只输出 JSON：{"expansions": ["词1", "词2", ...]}
2. 3-6 个，每个是简短检索词或短语（不要整句）
3. 覆盖：同义词、正式/行业规范用语、相关制度术语、可能的别名（如季节性作息称"夏令时/冬令时"）
4. 不要解释，不要编号`,
            },
            { role: 'user', content: query },
          ],
          temperature: 0,
          max_tokens: Number(process.env.QUERY_EXPANSION_MAX_TOKENS || 1200),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(Number(process.env.QUERY_EXPANSION_TIMEOUT_MS || 10000)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: any = await response.json();
      let content = this.assistantText(payload);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) content = jsonMatch[0];
      const parsed = JSON.parse(content);
      const terms = Array.isArray(parsed.expansions)
        ? parsed.expansions
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
   * Build the full agentic retrieval plan in one call: complexity, expanded
   * retrieval terms, decomposed sub-queries, and an optional HyDE passage.
   * Expansion runs for every query (cheap, cached); decomposition and HyDE are
   * reserved for complex questions to control cost.
   */
  async planQuery(query: string): Promise<{
    complexity: QueryComplexity;
    expansions: string[];
    subQueries: string[];
    hyde: string | null;
  }> {
    const complexity = await this.classifyQuery(query);
    if (complexity === 'simple') {
      const expansions = await this.expandQuery(query);
      return { complexity, expansions, subQueries: [query], hyde: null };
    }
    const [decomposed, hyde, expansions] = await Promise.all([
      this.decomposeQuery(query, complexity),
      this.generateHypotheticalDocument(query),
      this.expandQuery(query),
    ]);
    return {
      complexity,
      expansions,
      subQueries: decomposed.subQueries.length ? decomposed.subQueries : [query],
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
  ): Promise<RetrievalJudgment> {
    if (!this.enabled || iterationCount >= this.maxHops) {
      return { status: 'sufficient', missingAspects: [], suggestedFollowUp: [], confidence: 0.5 };
    }

    // Quick heuristic: if context is substantial, likely sufficient
    if (retrievedContext.length > 2000 && iterationCount > 0) {
      return { status: 'sufficient', missingAspects: [], suggestedFollowUp: [], confidence: 0.8 };
    }

    // If no context at all, definitely insufficient
    if (!retrievedContext.trim()) {
      return {
        status: 'irrelevant',
        missingAspects: ['No relevant context found'],
        suggestedFollowUp: [],
        confidence: 0.1,
      };
    }

    try {
      const config = await this.getLlmConfig();
      if (!config) {
        return { status: 'sufficient', missingAspects: [], suggestedFollowUp: [], confidence: 0.5 };
      }

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            {
              role: 'system',
              content: `你是一个检索质量评估专家。判断给定的检索结果是否足以回答用户的问题。
输出 JSON: {"status": "sufficient|insufficient|irrelevant", "confidence": 0.0-1.0, "missingAspects": ["缺失的方面"], "suggestedFollowUp": ["建议的补充查询"]}`,
            },
            {
              role: 'user',
              content: `问题: ${query}\n\n检索到的内容 (前2000字):\n${retrievedContext.slice(0, 2000)}\n\n请判断这些内容是否足以回答问题。`,
            },
          ],
          temperature: 0,
          max_tokens: 400,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload: any = await response.json();
      let content = String(payload?.choices?.[0]?.message?.content || '').trim();
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) content = jsonMatch[1].trim();
      
      const parsed = JSON.parse(content);

      const status = ['sufficient', 'insufficient', 'irrelevant'].includes(parsed.status)
        ? parsed.status
        : 'sufficient';

      return {
        status,
        missingAspects: Array.isArray(parsed.missingAspects) ? parsed.missingAspects.slice(0, 3) : [],
        suggestedFollowUp: Array.isArray(parsed.suggestedFollowUp) ? parsed.suggestedFollowUp.slice(0, 3) : [],
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      };
    } catch (err) {
      this.logger.warn(`Retrieval judgment failed: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'sufficient', missingAspects: [], suggestedFollowUp: [], confidence: 0.5 };
    }
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

  private async getLlmConfig(): Promise<{ baseUrl: string; apiKey: string; modelName: string } | null> {
    try {
      const config = await this.modelConfigService.getDefault('llm');
      if (!config) return null;
      return {
        baseUrl: (config.provider.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
        apiKey: config.provider.apiKey || process.env.DEEPSEEK_API_KEY || '',
        modelName: config.modelName || process.env.LLM_MODEL || 'deepseek-chat',
      };
    } catch {
      return null;
    }
  }
}
