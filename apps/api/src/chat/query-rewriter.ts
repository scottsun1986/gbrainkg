import { Logger } from "@nestjs/common";
import type { ModelConfigService } from "../model-config.service";
import type { AgenticRagService } from "./agentic-rag.service";

export type RetrievalRequest = { query: string; breadth: boolean; operation: "search" | "query" };

export interface QueryRewriterDeps {
  logger: Logger;
  modelConfigService?: ModelConfigService;
  agenticRagService?: AgenticRagService;
  recallPersonalFacts?: (userId: string, query?: string, limit?: number) => Promise<any>;
}

/**
 * Query rewriting, personal-memory gating and LLM entity/search probe planning.
 * Extracted from ChatService; behaviour is unchanged (code move + ctor injection).
 */
export class QueryRewriterService {
  private readonly logger: Logger;
  private readonly modelConfigService?: ModelConfigService;
  private readonly agenticRagService?: AgenticRagService;
  private readonly recallPersonalFacts: NonNullable<QueryRewriterDeps["recallPersonalFacts"]>;

  constructor(deps: QueryRewriterDeps) {
    this.logger = deps.logger;
    this.modelConfigService = deps.modelConfigService;
    this.agenticRagService = deps.agenticRagService;
    this.recallPersonalFacts = deps.recallPersonalFacts ?? (async () => ({ facts: [] }));
  }

  /**
   * Ask the model to *name* the entities the first-hop evidence leaves unresolved.
   *
   * This is deliberately not a "decompose the question" step: sub-questions stay
   * question-shaped and rarely name the intermediate entity, while a *named* entity
   * retrieves its own page at rank 1 (measured: 36/40 of the gold paragraphs this
   * pipeline misses are rank-1 retrievable when used directly as the query). The model
   * only sees the question and the retrieved passages, so it cannot invent unrelated
   * world knowledge, and the returned names are used as ordinary probes — banded below
   * primary evidence and cross-encoded against themselves.
   *
   * Bounded and fail-open: no route, a timeout or unparsable output yields no probes.
   */
  async planEntityProbesWithLlm(question: string, evidenceTexts: string[]): Promise<string[]> {
    if (process.env.RETRIEVAL_LLM_ENTITY_PROBES !== 'true') return [];
    const maxProbes = Math.max(0, Number(process.env.RETRIEVAL_LLM_ENTITY_PROBES_MAX || 3));
    if (maxProbes === 0) return [];
    const evidence = evidenceTexts
      .map((text) => String(text || '').trim())
      .filter(Boolean)
      .join('\n---\n')
      .slice(0, 4000);
    if (!evidence) return [];
    try {
      const llm = this.modelConfigService
        ? (await this.modelConfigService.getDefault('fast_llm')) ?? (await this.modelConfigService.getDefault('llm'))
        : null;
      if (!llm) return [];
      const baseUrl = String(llm.provider?.baseUrl || '').replace(/\/$/, '');
      if (!baseUrl) return [];
      const timeoutMs = Math.max(500, Number(process.env.RETRIEVAL_LLM_ENTITY_PROBES_TIMEOUT_MS || 6000));
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(llm.provider?.apiKey ? { Authorization: `Bearer ${llm.provider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llm.modelName,
          messages: [
            {
              role: 'system',
              content:
                '你是检索助手。给定问题和已检索到的资料片段，列出为了完整回答问题还需要单独检索的**具体实体名称**（人名/机构/作品/地点等专有名词）。只允许使用问题或资料中出现的名称，不要编造，也不要输出解释。只输出 JSON：{"entities":["..."]}',
            },
            { role: 'user', content: `问题：${question}\n\n资料片段：\n${evidence}` },
          ],
          temperature: 0,
          max_tokens: 200,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return [];
      const payload: any = await response.json();
      const content = String(payload?.choices?.[0]?.message?.content || '');
      const json = content.match(/\{[\s\S]*\}/);
      if (!json) return [];
      const parsed = JSON.parse(json[0]);
      const names: string[] = Array.isArray(parsed?.entities) ? parsed.entities : [];
      const questionLower = question.trim().toLowerCase();
      const seen = new Set<string>();
      const result: string[] = [];
      for (const raw of names) {
        const name = String(raw || '').trim();
        if (name.length < 3 || name.length > 80) continue;
        const lower = name.toLowerCase();
        if (lower === questionLower || seen.has(lower)) continue;
        seen.add(lower);
        result.push(name);
        if (result.length >= maxProbes) break;
      }
      return result;
    } catch (err) {
      this.logger.debug(
        `LLM entity probes skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  async planSearchProbes(query: string, alreadyPlanned: string[]): Promise<string[]> {
    if (!this.agenticRagService) return [];
    if (process.env.RETRIEVAL_LLM_PROBES === 'false') return [];
    const maxProbes = Math.max(0, Number(process.env.RETRIEVAL_LLM_PROBES_MAX || 3));
    if (maxProbes === 0) return [];
    try {
      const timeoutMs = Math.max(500, Number(process.env.RETRIEVAL_LLM_PROBES_TIMEOUT_MS || 4000));
      const plan = await Promise.race([
        this.agenticRagService.planQuery(query),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (!plan) return [];
      const known = new Set(alreadyPlanned.map((q) => q.trim().toLowerCase()));
      const queryLower = query.trim().toLowerCase();
      return (plan.subQueries || [])
        .map((q) => String(q || '').trim())
        .filter((q) => q.length >= 4 && q.toLowerCase() !== queryLower && !known.has(q.toLowerCase()))
        .slice(0, maxProbes);
    } catch (err) {
      this.logger.debug(
        `LLM probe planning skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  async rewriteQueryForRetrieval(
    question: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    signal?: AbortSignal,
  ): Promise<RetrievalRequest> {
    signal?.throwIfAborted();
    const prior = history
      .filter(
        (message) => !(message.role === "user" && message.content === question),
      )
      .slice(-8)
      .map(
        (message) =>
          `${message.role === "assistant" ? "assistant" : "user"}: ${message.content}`,
      )
      .join("\n");
    const isExactClause = /第\s*[\d一二三四五六七八九十百千万〇零两]+\s*[章节条款项]|附件\s*[\d一二三四五六七八九十百千万〇零两]+/.test(question);
    const isBroadQuery = /(一共有|总共|全部|清单|有哪些|所有|多少|几[个项条部篇]|对比|区别|概览|汇总)/.test(question);
    const directRequest: RetrievalRequest = {
      query: question,
      breadth: isBroadQuery,
      operation: isExactClause ? 'search' : 'query',
    };
    // A fresh turn has no antecedent to resolve. Calling an LLM to paraphrase
    // it delays retrieval and can only add another interpretation layer; the
    // original user wording is the highest-fidelity GBrain query. Historical
    // turns still use the contextual rewrite below.
    if (!prior) return directRequest;

    // Anaphora / referential detection: if the question is self-contained (no pronouns or deictic references)
    // and of sufficient length (>= 8 chars), it does not depend on prior history and does not need an LLM rewrite.
    const hasReferentialMarkers = /(?:他|她|它|这|那|该|其|上述|前述|之前|刚才|继续|同一个|这个|那个|还有呢|第几|为什么|怎么回事)/u.test(question);
    if (!hasReferentialMarkers && question.trim().length >= 8) {
      return directRequest;
    }

    const llmRequest = this.modelConfigService
      ? await this.modelConfigService.getLlmChatConfig('llmwiki-rewrite')
      : null;
    const apiKey = llmRequest?.apiKey || "";
    const baseUrl = llmRequest?.baseUrl || "";
    const modelName = llmRequest?.modelName || "";

    if (!apiKey) {
      return directRequest;
    }
    const historyWindow = prior.slice(-3000);
    const prompt = `Analyze the current user question for knowledge-base retrieval. Rewrite it into one standalone query. Resolve references such as he/she/it/this policy/the previous item only when the conversation makes the referent unambiguous. If it starts a new topic, do not import unrelated history. Set breadth=true when answering requires broad coverage, enumeration, totals across a document, comparison of multiple sections, or "all/every/complete" evidence; otherwise false. Set operation="search" only for an exact known name, title, identifier, or structured-field lookup; otherwise operation="query" for semantic, paraphrased, relational, or cross-page questions. Do not answer the question. Return JSON only: {"query":"...","breadth":false,"operation":"query"}.\n\nUntrusted conversation history:\n${historyWindow || "(none)"}\n\nCurrent question:\n${question}`;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      if (baseUrl.includes("opencode.ai")) {
        headers["x-opencode-session"] = "llmwiki-rewrite";
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 160,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        return directRequest;
      }
      const payload: any = await response.json();
      const content = String(
        payload?.choices?.[0]?.message?.content || "",
      ).trim();
      try {
        const parsed = JSON.parse(
          content.replace(/^```json\s*/i, "").replace(/\s*```$/, ""),
        );
        const rewritten = String(parsed?.query || "").trim();
        const operation: 'search' | 'query' = isExactClause
          ? 'search'
          : parsed?.operation === 'search'
          ? 'search'
          : 'query';
        const breadth = isBroadQuery || parsed?.breadth === true;
        return {
          query:
            rewritten.length > 0 && rewritten.length <= 1000
              ? rewritten
              : question,
          breadth,
          operation,
        };
      } catch {
        return directRequest;
      }
    } catch (error) {
      this.logger.debug(
        `Contextual retrieval rewrite unavailable: ${error?.message || "unknown error"}`,
      );
      return directRequest;
    }
  }

  async loadPersonalMemoryContext(
    userId: string,
    query: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    sessionId?: string,
  ): Promise<{ text: string; count: number }> {
    try {
      // context_pack is a session-boundary assembly operation. The web app
      // does not maintain a trusted standing-entity bank yet, so passing an
      // arbitrary whole user question as its `entities` argument is both
      // semantically wrong and expensive. For an explicit memory need, the
      // official recall verb is the precise, budgeted read primitive.
      const result = await this.recallPersonalFacts(userId, query, 8);
      const facts = Array.isArray(result?.facts) ? result.facts : [];
      if (!facts.length) return { text: String(result?.text || "").trim(), count: 0 };
      const text = facts
        .slice(0, 8)
        .map((fact: any) => {
          const value = String(fact.fact || fact.content || "").trim();
          const entity = String(fact.entity_slug || "").trim();
          return value ? `- ${value}${entity ? ` [${entity}]` : ""}` : "";
        })
        .filter(Boolean)
        .join("\n");
      return { text: text || String(result?.text || "").trim(), count: facts.length };
    } catch (error) {
      // A user without a personal KB, or a temporarily unavailable memory
      // verb, must not make ordinary knowledge retrieval fail.
      this.logger.debug(`Personal memory retrieval unavailable: ${error?.message || "unknown error"}`);
      return { text: "", count: 0 };
    }
  }

  shouldLoadPersonalMemory(
    question: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): boolean {
    const normalized = question.trim();
    if (!normalized) return false;
    // Manual personal memories are private preferences/facts, not a second
    // enterprise-document corpus. Consult them when the user explicitly asks
    // about self/context, or when a follow-up is linguistically referential.
    // Ordinary policy lookups stay on the authoritative knowledge Sources.
    const asksPersonalMemory = /(?:我的|我自己|个人(?:偏好|习惯|信息|记忆)|记住(?:了|的)?|我(?:曾|之前|刚才).{0,12}(?:说|提|告诉)|偏好|习惯|账号|密码)/u.test(normalized);
    const hasPriorTurns = history.some((message) => message.role === "assistant") || history.length > 1;
    const refersToPriorContext = /^(?:他|她|它|这|那|该|上述|前面|之前|刚才|继续|同一个|这个|那个)/u.test(normalized);
    return asksPersonalMemory || (hasPriorTurns && refersToPriorContext);
  }

  /**
   * CRAG corrective step: one LLM call producing alternative search phrasings
   * for a query that retrieved nothing (synonyms, broader terms, or the
   * formal terminology a policy document would use). Returns at most 2
   * queries; [] on any failure so callers fall through to honest refusal.
   */
  async rewriteQueryForRetry(query: string): Promise<string[]> {
    try {
      const llmRequest = this.modelConfigService
        ? await this.modelConfigService.getLlmChatConfig('llmwiki-retry-rewrite')
        : null;
      if (!llmRequest?.apiKey) return [];
      const response = await fetch(`${llmRequest.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: llmRequest.headers,
        body: JSON.stringify({
          model: llmRequest.modelName,
          messages: [
            {
              role: 'system',
              content: '你是检索查询改写器。给定一个在知识库中检索不到任何结果的查询，给出 2 个替代检索措辞：同义词、更宽泛的上位词、或正式制度文档会使用的术语。只输出 JSON：{"queries":["...","..."]}',
            },
            { role: 'user', content: query },
          ],
          temperature: 0,
          max_tokens: 600,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return [];
      const payload: any = await response.json();
      const message = payload?.choices?.[0]?.message || {};
      let content = String(message.content || '').trim();
      if (!content) content = String(message.reasoning_content || '').trim();
      const parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]);
      return (Array.isArray(parsed?.queries) ? parsed.queries : [])
        .map((q: any) => String(q || '').trim())
        .filter((q: string) => q.length >= 2 && q.length <= 100)
        .slice(0, 2);
    } catch (err) {
      this.logger.debug(`Retry rewrite unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

}
