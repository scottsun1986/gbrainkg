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
          max_tokens: 500,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload: any = await response.json();
      let content = String(payload?.choices?.[0]?.message?.content || '').trim();
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) content = jsonMatch[1].trim();
      
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
