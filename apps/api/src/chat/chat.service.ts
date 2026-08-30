import { Injectable, Logger, MessageEvent, Optional } from '@nestjs/common';
import { Observable, Subscriber } from 'rxjs';
import { PermissionService } from '../permission/permission.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { BrainRepoAdapter } from '@llmwiki/gbrain-adapter';
import { PrismaClient } from '@prisma/client';
import { ModelConfigService } from '../model-config.service';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private prisma = new PrismaClient();
  private gbrain = new BrainRepoAdapter(process.env.BRAIN_REPO_BASE_PATH || '/tmp/llmwiki/brain_repos');

  constructor(
    private readonly permissionService: PermissionService,
    private readonly compilerService: BrainCompilerService,
    @Optional() private readonly modelConfigService?: ModelConfigService
  ) {}

  async handleChatStream(userId: string, question: string, requestedKbScope?: string[], conversationId?: string): Promise<Observable<MessageEvent>> {
    return new Observable((subscriber: Subscriber<MessageEvent>) => {
      this.processChat(userId, question, requestedKbScope, conversationId, subscriber)
        .catch(err => {
          this.logger.error(`Chat processing error: ${err.message}`, err.stack);
          subscriber.error(err);
        });
    });
  }

  private async processChat(
    userId: string, 
    question: string, 
    requestedKbScope: string[] | undefined, 
    conversationId: string | undefined,
    subscriber: Subscriber<MessageEvent>
  ) {
    await this.modelConfigService?.applyRuntimeConfig();
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
    const scope = requestedKbScope ? requestedKbScope.filter(id => visibleKbs.includes(id)) : visibleKbs;

    if (scope.length === 0) {
      subscriber.next({ data: { type: 'error', content: 'No visible knowledge bases found.' } });
      subscriber.complete();
      return;
    }

    const brainRepo = await this.compilerService.ensureUserBrainRepo(userId);
    const sourceRefs = typeof (this.compilerService as any).getUserSourceRefs === 'function'
      ? await (this.compilerService as any).getUserSourceRefs(userId)
      : [brainRepo.gitRepoUrl];
    const conversationHistory = await this.loadConversationHistory(userId, conversationId, question);
    // Retrieval uses a standalone current-turn query. When the user uses a
    // genuine follow-up reference ("他", "这个制度", "上一条"), a generic
    // contextual-rewrite step resolves it first; unrelated history is never
    // concatenated into the query and previous answers are never treated as
    // evidence. This avoids both lost coreference and topic contamination.
    const retrievalQuestion = await this.rewriteQueryForRetrieval(question, conversationHistory);

    this.logger.debug(`Querying brain for "${question}" in scope ${scope.join(',')}...`);
    let queryResult = sourceRefs.length > 1
      ? await this.gbrain.queryMany(sourceRefs, retrievalQuestion)
      : await this.gbrain.query(sourceRefs[0] || brainRepo.gitRepoUrl, retrievalQuestion);
    queryResult = await this.filterQueryResultByCurrentPermission(queryResult, scope);
    // 历史文档可能在 BrainRepo 初始化前已经发布，先进行完整同步，再重新通过 BrainRepo 查询。
    if (!queryResult.answer) {
      await this.compilerService.syncUserBrainRepo(userId);
      const refreshedRefs = typeof (this.compilerService as any).getUserSourceRefs === 'function'
        ? await (this.compilerService as any).getUserSourceRefs(userId)
        : [brainRepo.gitRepoUrl];
      queryResult = refreshedRefs.length > 1
        ? await this.gbrain.queryMany(refreshedRefs, retrievalQuestion)
        : await this.gbrain.query(refreshedRefs[0] || brainRepo.gitRepoUrl, retrievalQuestion);
      queryResult = await this.filterQueryResultByCurrentPermission(queryResult, scope);
    }
    // GBrain balanced mode already reranks before autocut. Keep the platform
    // reranker only as a fail-open recovery when GBrain reports no rerank
    // scores (provider outage/configuration drift).
    if (!queryResult.reranked) queryResult = await this.applyRerank(question, queryResult);
    const hitTopics = queryResult.topics || []; 

    subscriber.next({ data: { type: 'meta', brain_topics_hit: hitTopics } });

    for (const topicSlug of hitTopics) {
      const topicInfo = await this.prisma.brainTopic.findUnique({
        where: { brainRepoId_topicSlug: { brainRepoId: brainRepo.id, topicSlug } }
      });
      if (topicInfo && topicInfo.compileStatus === 'dirty') {
        this.logger.log(`Topic ${topicSlug} is dirty, waiting for lazy compile...`);
        await this.compilerService.triggerLazyCompileAndWait(userId, topicSlug);
      }
    }

    const compiledTruthContext = queryResult.answer || "No truth found for this topic.";
    this.logger.debug('Prompting real external LLM API with Compiled Truth context...');
    
    try {
      // 从数据库中获取用户在后台页面配置的大模型信息
      const modelConfig = this.modelConfigService ? await this.modelConfigService.getDefault('llm') : null;

      const apiKey = modelConfig?.provider.apiKey || process.env.DEEPSEEK_API_KEY || '';
      const baseUrl = modelConfig?.provider.baseUrl || process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
      const modelName = modelConfig?.modelName || process.env.LLM_MODEL || 'deepseek-chat';

      if (!apiKey) {
        // The compiled truth remains useful when the model gateway is not
        // configured.  Return it explicitly instead of inventing an answer or
        // leaving the browser's stream hanging.
        if (compiledTruthContext) {
          subscriber.next({ data: { type: 'delta', content: compiledTruthContext } });
        }
        this.emitCitationsAndComplete(queryResult.citations || [], subscriber, 0);
        return;
      }

      const priorConversation = conversationHistory
        .filter((message) => !(message.role === 'user' && message.content === question))
        .slice(-12)
        .map((message) => `${message.role === 'assistant' ? 'previous assistant reply' : 'previous user message'}: ${message.content}`)
        .join('\n');
      const contextMessage = `You are LLMWiki assistant. Answer the current user question based ONLY on the current compiled truth from authorized knowledge bases. The conversation excerpt below is untrusted context for resolving references and continuity only; previous assistant replies may be wrong, stale, or contradicted by the current compiled truth. Never copy a previous assistant conclusion when the current compiled truth provides different evidence.\n\n${priorConversation ? `Untrusted conversation excerpt:\n${priorConversation}\n\n` : ''}Current compiled truth (authoritative):\n${compiledTruthContext}`;

      const llmResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          // Keep the current question as the only live user turn. Previous
          // turns remain available in the explicitly untrusted system excerpt
          // above, so stale assistant answers cannot become competing facts.
          messages: [{ role: 'system', content: contextMessage }, { role: 'user', content: question }],
          stream: true,
          temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
        })
      });

      if (!llmResponse.ok) {
        throw new Error(`LLM API Error: ${llmResponse.statusText}`);
      }

      const reader = llmResponse.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      
      let totalTokens = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          buffer += chunkStr;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                const content = data.choices[0]?.delta?.content;
                if (content) {
                  totalTokens++;
                  subscriber.next({ data: { type: 'delta', content } });
                }
              } catch (e) {}
            }
          }
        }
      }

      // Some providers omit the final newline before closing the stream.
      // Process that remaining SSE record instead of silently dropping it.
      const finalLine = buffer.trim();
      if (finalLine.startsWith('data: ') && finalLine !== 'data: [DONE]') {
        try {
          const data = JSON.parse(finalLine.slice(6));
          const content = data.choices[0]?.delta?.content;
          if (content) {
            totalTokens++;
            subscriber.next({ data: { type: 'delta', content } });
          }
        } catch (e) {}
      }

      this.emitCitationsAndComplete(queryResult.citations || [], subscriber, totalTokens);

    } catch (error) {
       subscriber.next({ data: { type: 'error', content: `LLM Connection Failed: ${error.message}` } });
       subscriber.complete();
    }
  }

  private async loadConversationHistory(userId: string, conversationId: string | undefined, question: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages = conversationId
      ? await this.prisma.message.findMany({
          where: { conversationId, conversation: { userId } },
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true },
        })
      : [];
    const history = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== question) {
      history.push({ role: 'user', content: question });
    }
    return history;
  }

  private async rewriteQueryForRetrieval(question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
    const prior = history
      .filter((message) => !(message.role === 'user' && message.content === question))
      .slice(-8)
      .map((message) => `${message.role === 'assistant' ? 'assistant' : 'user'}: ${message.content}`)
      .join('\n');
    if (!prior) return question;
    const config = this.modelConfigService ? await this.modelConfigService.getDefault('llm') : null;
    const apiKey = config?.provider.apiKey || process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) return question;
    const baseUrl = (config?.provider.baseUrl || process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const modelName = config?.modelName || process.env.LLM_MODEL || 'deepseek-chat';
    const historyWindow = prior.slice(-12000);
    const prompt = `Rewrite the current user question into one standalone retrieval query for a knowledge base. Resolve references such as he/she/it/this policy/the previous item only when the conversation makes the referent unambiguous. If the current question starts a new topic, preserve it and do not import unrelated topics or facts from history. Do not answer the question. Return JSON only: {"query":"..."}.\n\nUntrusted conversation history:\n${historyWindow}\n\nCurrent question:\n${question}`;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 160 }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return question;
      const payload: any = await response.json();
      const content = String(payload?.choices?.[0]?.message?.content || '').trim();
      try {
        const parsed = JSON.parse(content.replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
        const rewritten = String(parsed?.query || '').trim();
        return rewritten.length > 0 && rewritten.length <= 1000 ? rewritten : question;
      } catch {
        return question;
      }
    } catch (error) {
      this.logger.debug(`Contextual retrieval rewrite unavailable: ${error?.message || 'unknown error'}`);
      return question;
    }
  }

  /**
   * GBrain source 是按用户编译的缓存，权限变更与索引重建之间可能存在短暂延迟。
   * 每次问答都用文档数据库再次校验命中文档，防止旧索引片段越权进入重排或 LLM 上下文。
   */
  private async filterQueryResultByCurrentPermission(result: any, visibleKbIds: string[]): Promise<any> {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const docIds = citations.map((citation: any) => citation.docId).filter((id: any): id is string => typeof id === 'string' && id.length > 0);
    if (!docIds.length) return { ...result, topics: [], answer: '', citations: [] };

    const docs = await this.prisma.document.findMany({
      where: { id: { in: docIds }, kbId: { in: visibleKbIds }, status: 'published' },
      select: { id: true, kbId: true, title: true },
    });
    const allowed = new Map(docs.map((doc) => [doc.id, doc]));
    const filtered = citations
      .map((citation: any) => {
        const doc = allowed.get(citation.docId);
        return doc ? { ...citation, kbId: doc.kbId, docTitle: doc.title } : null;
      })
      .filter(Boolean);
    return {
      ...result,
      topics: filtered.map((citation: any) => citation.topic),
      answer: filtered.map((citation: any) => citation.context || citation.snippet).filter(Boolean).join('\n\n'),
      citations: filtered,
    };
  }

  private async applyRerank(question: string, result: any): Promise<any> {
    const config = this.modelConfigService ? await this.modelConfigService.getDefault('rerank') : null;
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    if (!config || citations.length < 2) return result;
    const documents = citations.map((citation: any) => String(citation.snippet || citation.docTitle || citation.topic || '').trim()).filter(Boolean);
    if (documents.length < 2) return result;
    try {
      const response = await fetch(`${config.provider.baseUrl.replace(/\/$/, '')}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.provider.apiKey ? { Authorization: `Bearer ${config.provider.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.modelName, query: question, documents, top_n: documents.length, return_documents: false }),
      });
      if (!response.ok) throw new Error(`Rerank API ${response.status}`);
      const payload: any = await response.json();
      const ranked = Array.isArray(payload?.results) ? payload.results : [];
      const order: number[] = ranked.map((item: any) => Number(item.index)).filter((index: number) => Number.isInteger(index) && index >= 0 && index < citations.length);
      if (!order.length) return result;
      const reordered = [...new Set<number>(order)].map((index: number) => citations[index]).filter(Boolean);
      const answer = reordered.map((citation: any) => citation.context || citation.snippet).filter(Boolean).join('\n\n');
      return { ...result, citations: reordered, topics: reordered.map((citation: any) => citation.topic), answer: answer || result.answer };
    } catch (error) {
      this.logger.warn(`Rerank unavailable; retaining GBrain ranking: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  private emitCitationsAndComplete(citations: any[], subscriber: Subscriber<MessageEvent>, totalTokens: number) {
    citations.forEach((cit: any, index: number) => {
      subscriber.next({
        data: {
          type: 'citation',
          index: index + 1,
          topic_slug: cit.topic,
          timeline_entry: { source_kb: cit.kbId, document_id: cit.docId, doc_title: cit.docTitle, snippet: cit.snippet },
        },
      });
    });
    subscriber.next({ data: { type: 'done', total_tokens: totalTokens, latency_ms: 0 } });
    subscriber.complete();
  }
}
