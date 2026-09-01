import { Injectable, Logger, MessageEvent, Optional } from "@nestjs/common";
import { Observable, Subscriber } from "rxjs";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { PrismaClient } from "@prisma/client";
import { ModelConfigService } from "../model-config.service";
import { BrainOutboxService } from "../brain-compiler/brain-outbox.service";
import { createHash } from "node:crypto";
import { sourceKeyForKnowledgeBase } from "../brain-compiler/brain-source";

import { BrainScopeService } from "../brain-compiler/brain-scope.service";

type RetrievalRequest = { query: string; breadth: boolean; operation: 'search' | 'query' };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private prisma = new PrismaClient();
  private gbrain = new BrainRepoAdapter(
    process.env.BRAIN_REPO_BASE_PATH || "/tmp/llmwiki/brain_repos",
  );

  constructor(
    private readonly permissionService: PermissionService,
    private readonly compilerService: BrainCompilerService,
    private readonly scopeService: BrainScopeService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() private readonly outboxService?: BrainOutboxService,
  ) {}

  async handleChatStream(
    userId: string,
    question: string,
    requestedKbScope?: string[],
    conversationId?: string,
  ): Promise<Observable<MessageEvent>> {
    return new Observable((subscriber: Subscriber<MessageEvent>) => {
      this.processChat(
        userId,
        question,
        requestedKbScope,
        conversationId,
        subscriber,
      ).catch((err) => {
        this.logger.error(`Chat processing error: ${err.message}`, err.stack);
        subscriber.error(err);
      });
    });
  }

  private async personalSourceRef(userId: string): Promise<string> {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { type: "personal", ownerUserId: userId, status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!kb) throw new Error("请先创建个人知识库后再使用个人记忆。");
    const ref = `gbrain://source/${sourceKeyForKnowledgeBase(kb.id)}`;
    await this.gbrain.initializeSource(sourceKeyForKnowledgeBase(kb.id));
    return ref;
  }

  /** Explicit-only personal memory: normal conversation is never auto-written. */
  async rememberPersonalFact(userId: string, fact: string, entity?: string) {
    const normalized = fact.trim();
    if (!normalized || normalized.length > 2_000) throw new Error("个人记忆内容应为 1–2000 个字符。");
    return this.gbrain.remember(
      await this.personalSourceRef(userId),
      normalized,
      `explicit platform memory by user ${userId} at ${new Date().toISOString()}`,
      entity?.trim() || undefined,
    );
  }

  async recallPersonalFacts(userId: string, query?: string, limit = 20) {
    return this.gbrain.recall(await this.personalSourceRef(userId), {
      ...(query?.trim() ? { query: query.trim() } : {}),
      limit: Math.max(1, Math.min(limit, 100)),
      include_pending: true,
    });
  }

  async forgetPersonalFact(userId: string, factId: string) {
    if (!factId.trim()) throw new Error("缺少个人记忆 ID。");
    return this.gbrain.forget(await this.personalSourceRef(userId), factId.trim());
  }

  async personalContextPack(userId: string, entities: string, sessionId?: string) {
    if (!entities.trim()) throw new Error("请提供要加载的实体名称。");
    return this.gbrain.contextPack(await this.personalSourceRef(userId), {
      entities: entities.trim(),
      ...(sessionId?.trim() ? { session_id: sessionId.trim() } : {}),
      budget_tokens: 800,
      include_private: true,
    });
  }

  private async processChat(
    userId: string,
    question: string,
    requestedKbScope: string[] | string | undefined,
    conversationId: string | undefined,
    subscriber: Subscriber<MessageEvent>,
  ) {
    const retrievalStartedAt = Date.now();
    await this.modelConfigService?.applyRuntimeConfig();
    const visibleKbs =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    const parsedRequestedScope = Array.isArray(requestedKbScope)
      ? requestedKbScope
      : typeof requestedKbScope === "string" && requestedKbScope !== "all"
        ? [requestedKbScope]
        : undefined;
    const scope = parsedRequestedScope
      ? parsedRequestedScope.filter((id) => visibleKbs.includes(id))
      : visibleKbs;

    if (scope.length === 0) {
      subscriber.next({
        data: { type: "error", content: "No visible knowledge bases found." },
      });
      subscriber.complete();
      return;
    }

    const brainRepo = await this.compilerService.ensureUserBrainRepo(userId);
    const userScope = await this.scopeService.resolveUserScope(userId);
    const rawRefs =
      typeof (this.compilerService as any).getUserSourceRefsForKnowledgeBases === "function"
        ? await (this.compilerService as any).getUserSourceRefsForKnowledgeBases(userId, scope)
        : typeof (this.compilerService as any).getUserSourceRefs === "function"
          ? await (this.compilerService as any).getUserSourceRefs(userId)
          : [brainRepo.gitRepoUrl];
    const selectedSourceKeys = rawRefs
      .map((ref: string) => ref.replace(/^gbrain:\/\/source\//, ""))
      .sort();
    const wholeScopeSelected =
      selectedSourceKeys.length === userScope.sourceKeys.length &&
      selectedSourceKeys.every((key, index) => key === userScope.sourceKeys.slice().sort()[index]);

    // Start with source documents. Permission-scoped derived summaries are
    // only useful for broad cross-page questions, never for an exact passage
    // lookup where they could crowd out the primary document.
    const derivedRef = `gbrain://source/llmwiki-d-${userScope.fingerprint}`;
    const sourceRefs = [...rawRefs];

    const conversationHistory = await this.loadConversationHistory(
      userId,
      conversationId,
      question,
    );
    const retrieval = await this.rewriteQueryForRetrieval(
      question,
      conversationHistory,
    );
    // A derived page is valid only for the exact permission/source set from
    // which it was built. Never add a full-scope summary to a user-selected
    // subset of knowledge bases or to a focused fact lookup.
    if (retrieval.breadth && wholeScopeSelected && await this.gbrain.isSourceMaterialized(derivedRef).catch(() => false)) {
      sourceRefs.push(derivedRef);
    }

    this.logger.debug(
      `Querying brain for "${question}" in scope ${scope.join(",")} (Scope fingerprint: ${userScope.fingerprint})...`,
    );
    let queryResult =
      sourceRefs.length > 1
        ? await this.gbrain.queryMany(sourceRefs, retrieval.query, {
            breadth: retrieval.breadth,
            operation: retrieval.operation,
          })
        : await this.gbrain.query(
            sourceRefs[0] || brainRepo.gitRepoUrl,
            retrieval.query,
            { breadth: retrieval.breadth, operation: retrieval.operation },
          );
    queryResult = await this.filterQueryResultByCurrentPermission(
      queryResult,
      scope,
      {
        scopeId: userScope.scopeId,
        sourceKeys: selectedSourceKeys,
        aclEpoch: userScope.aclEpoch,
        knowledgeEpoch: userScope.knowledgeEpoch,
      },
    );
    // 历史文档可能在 BrainRepo 初始化前已经发布，先进行完整同步，再重新通过 BrainRepo 查询。
    if (!queryResult.answer) {
      await this.compilerService.syncUserBrainRepo(userId);
      const refreshedRefs =
        typeof (this.compilerService as any).getUserSourceRefsForKnowledgeBases === "function"
          ? await (this.compilerService as any).getUserSourceRefsForKnowledgeBases(userId, scope)
          : typeof (this.compilerService as any).getUserSourceRefs === "function"
            ? await (this.compilerService as any).getUserSourceRefs(userId)
            : [brainRepo.gitRepoUrl];
      queryResult =
        refreshedRefs.length > 1
          ? await this.gbrain.queryMany(refreshedRefs, retrieval.query, {
              breadth: retrieval.breadth,
              operation: retrieval.operation,
            })
          : await this.gbrain.query(
              refreshedRefs[0] || brainRepo.gitRepoUrl,
              retrieval.query,
            { breadth: retrieval.breadth, operation: retrieval.operation },
            );
      queryResult = await this.filterQueryResultByCurrentPermission(
        queryResult,
        scope,
        {
          scopeId: userScope.scopeId,
          sourceKeys: selectedSourceKeys,
          aclEpoch: userScope.aclEpoch,
          knowledgeEpoch: userScope.knowledgeEpoch,
        },
      );
    }
    // GBrain is the only retrieval path. Empty retrieval triggers source
    // reconciliation above, never a second application-specific search stack.
    // GBrain balanced mode already reranks before autocut. Keep the platform
    // reranker only as a fail-open recovery when GBrain reports no rerank
    // Always apply cross-encoder rerank & relevance filtering across candidate sources
    queryResult = await this.applyRerank(
      retrieval.query || question,
      queryResult,
      retrieval.breadth,
    );
    await this.outboxService?.logOperation("query", {
      scopeId: userScope.scopeId,
      phase: "retrieval_trace",
      counts: {
        questionHash: createHash("sha256").update(question).digest("hex").slice(0, 16),
        rewrittenQueryHash: createHash("sha256").update(retrieval.query || question).digest("hex").slice(0, 16),
        breadth: retrieval.breadth,
        operation: retrieval.operation,
        sourceKeys: selectedSourceKeys,
        candidates: Array.isArray(queryResult.citations) ? queryResult.citations.length : 0,
        evidence: (queryResult.citations || []).map((citation: any) => ({
          sourceKey: citation.sourceKey,
          documentId: citation.docId,
          slug: citation.slug,
          section: citation.section,
          score: citation.score,
          evidence: citation.evidence,
        })),
      },
      durationMs: Date.now() - retrievalStartedAt,
      status: queryResult.answer ? "success" : "warning",
    });
    const hitTopics = queryResult.topics || [];

    subscriber.next({ data: { type: "meta", brain_topics_hit: hitTopics } });

    for (const topicSlug of hitTopics) {
      const topicInfo = await this.prisma.brainTopic.findUnique({
        where: {
          brainRepoId_topicSlug: { brainRepoId: brainRepo.id, topicSlug },
        },
      });
      if (topicInfo && topicInfo.compileStatus === "dirty") {
        this.logger.log(
          `Topic ${topicSlug} is dirty, waiting for lazy compile...`,
        );
        await this.compilerService.triggerLazyCompileAndWait(userId, topicSlug);
      }
    }

    const citations = Array.isArray(queryResult.citations)
      ? queryResult.citations
      : [];
    const compiledTruthContext = citations.length > 0
      ? citations
          .map((cit: any, idx: number) => {
            const title = cit.docTitle || cit.topic || `参考文档 ${idx + 1}`;
            const kbName = cit.kbName ? ` (所属知识库: ${cit.kbName})` : "";
            const section = cit.section ? `\n定位：${cit.section}` : "";
            const content = (cit.context || cit.snippet || "").trim();
            return `【来源 ${idx + 1}】《${title}》${kbName}${section}\n${content}`;
          })
          .join("\n\n---\n\n")
      : (queryResult.answer || "No truth found for this topic.");

    this.logger.debug(
      "Prompting real external LLM API with Compiled Truth context...",
    );

    try {
      // 从数据库中获取用户在后台页面配置的大模型信息
      const modelConfig = this.modelConfigService
        ? await this.modelConfigService.getDefault("llm")
        : null;

      const apiKey =
        modelConfig?.provider.apiKey || process.env.DEEPSEEK_API_KEY || "";
      const baseUrl =
        modelConfig?.provider.baseUrl ||
        process.env.LLM_BASE_URL ||
        "https://api.deepseek.com/v1";
      const modelName =
        modelConfig?.modelName || process.env.LLM_MODEL || "deepseek-chat";

      if (!apiKey) {
        // The compiled truth remains useful when the model gateway is not
        // configured. Return it explicitly instead of inventing an answer or
        // leaving the browser's stream hanging.
        if (compiledTruthContext) {
          subscriber.next({
            data: { type: "delta", content: compiledTruthContext },
          });
        }
        this.emitCitationsAndComplete(
          queryResult.citations || [],
          subscriber,
          0,
          compiledTruthContext,
        );
        return;
      }

      const priorConversation = conversationHistory
        .filter(
          (message) =>
            !(message.role === "user" && message.content === question),
        )
        .slice(-12)
        .map(
          (message) =>
            `${message.role === "assistant" ? "previous assistant reply" : "previous user message"}: ${message.content}`,
        )
        .join("\n");

      const contextMessage = `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【重要回答规范】：
1. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。例如：“中通服节能的核心业务包括数据中心绿色化与液冷技术应用[1]。”
2. 【多源对比与完整呈现】：若提供的参考资料中包含多份涉及该问题的文档（如不同版本制度、不同管理规范），必须分别列出各份文件的具体规定，并说明其版本差异、适用条件或生效背景（例如《详细手册》与《手册V2》的不同作息安排），严禁擅自忽略其中任何一份相关文件。
3. 【多源合并】：若多个来源共同支持某一相同结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号。
4. 【客观真实】：如果参考资料不足以回答用户的问题，请明确客观说明“已知知识库资料中未包含相关信息”，切勿主观编造。

${priorConversation ? `历史对话参考（仅供消歧，以当前知识库资料为准）：\n${priorConversation}\n\n` : ""}【参考知识库资料】：
${compiledTruthContext}`;

      const llmResponse = await fetch(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: "system", content: contextMessage },
              { role: "user", content: question },
            ],
            stream: true,
            temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
          }),
        },
      );

      if (!llmResponse.ok) {
        throw new Error(`LLM API Error: ${llmResponse.statusText}`);
      }

      const reader = llmResponse.body?.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullAnswer = "";
      let totalTokens = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          buffer += chunkStr;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const data = JSON.parse(line.slice(6));
                const content = data.choices[0]?.delta?.content;
                if (content) {
                  totalTokens++;
                  fullAnswer += content;
                  subscriber.next({ data: { type: "delta", content } });
                }
              } catch (e) {}
            }
          }
        }
      }

      const finalLine = buffer.trim();
      if (finalLine.startsWith("data: ") && finalLine !== "data: [DONE]") {
        try {
          const data = JSON.parse(finalLine.slice(6));
          const content = data.choices[0]?.delta?.content;
          if (content) {
            totalTokens++;
            fullAnswer += content;
            subscriber.next({ data: { type: "delta", content } });
          }
        } catch (e) {}
      }

      this.emitCitationsAndComplete(
        queryResult.citations || [],
        subscriber,
        totalTokens,
        fullAnswer,
      );
    } catch (error) {
      subscriber.next({
        data: {
          type: "error",
          content: `LLM Connection Failed: ${error.message}`,
        },
      });
      subscriber.complete();
    }
  }

  private async loadConversationHistory(
    userId: string,
    conversationId: string | undefined,
    question: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const messages = conversationId
      ? await this.prisma.message.findMany({
          where: { conversationId, conversation: { userId } },
          orderBy: { createdAt: "desc" },
          take: 24,
          select: { role: true, content: true },
        })
      : [];
    const history = [...messages]
      .reverse()
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));
    const last = history[history.length - 1];
    if (!last || last.role !== "user" || last.content !== question) {
      history.push({ role: "user", content: question });
    }
    return history;
  }

  private async rewriteQueryForRetrieval(
    question: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<RetrievalRequest> {
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
    const config = this.modelConfigService
      ? await this.modelConfigService.getDefault("llm")
      : null;
    const apiKey =
      config?.provider.apiKey || process.env.DEEPSEEK_API_KEY || "";
    if (!apiKey) return { query: question, breadth: false, operation: 'query' };
    const baseUrl = (
      config?.provider.baseUrl ||
      process.env.LLM_BASE_URL ||
      "https://api.deepseek.com/v1"
    ).replace(/\/$/, "");
    const modelName =
      config?.modelName || process.env.LLM_MODEL || "deepseek-chat";
    const historyWindow = prior.slice(-12000);
    const prompt = `Analyze the current user question for knowledge-base retrieval. Rewrite it into one standalone query. Resolve references such as he/she/it/this policy/the previous item only when the conversation makes the referent unambiguous. If it starts a new topic, do not import unrelated history. Set breadth=true when answering requires broad coverage, enumeration, totals across a document, comparison of multiple sections, or "all/every/complete" evidence; otherwise false. Set operation="search" only for an exact known name, title, identifier, or structured-field lookup; otherwise operation="query" for semantic, paraphrased, relational, or cross-page questions. Do not answer the question. Return JSON only: {"query":"...","breadth":false,"operation":"query"}.\n\nUntrusted conversation history:\n${historyWindow || "(none)"}\n\nCurrent question:\n${question}`;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 160,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return { query: question, breadth: false, operation: 'query' };
      const payload: any = await response.json();
      const content = String(
        payload?.choices?.[0]?.message?.content || "",
      ).trim();
      try {
        const parsed = JSON.parse(
          content.replace(/^```json\s*/i, "").replace(/\s*```$/, ""),
        );
        const rewritten = String(parsed?.query || "").trim();
        return {
          query:
            rewritten.length > 0 && rewritten.length <= 1000
              ? rewritten
              : question,
          breadth: parsed?.breadth === true,
          operation: parsed?.operation === 'search' ? 'search' : 'query',
        };
      } catch {
        return { query: question, breadth: false, operation: 'query' };
      }
    } catch (error) {
      this.logger.debug(
        `Contextual retrieval rewrite unavailable: ${error?.message || "unknown error"}`,
      );
      return { query: question, breadth: false, operation: 'query' };
    }
  }

  /**
   * GBrain source 是按用户编译的缓存，权限变更与索引重建之间可能存在短暂延迟。
   * 每次问答都用文档数据库再次校验命中文档，防止旧索引片段越权进入重排或 LLM 上下文。
   */
  private async filterQueryResultByCurrentPermission(
    result: any,
    visibleKbIds: string[],
    derivedGuard: {
      scopeId: string;
      sourceKeys: string[];
      aclEpoch: number;
      knowledgeEpoch: number;
    },
  ): Promise<any> {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const docIds = citations
      .map((citation: any) => citation.docId)
      .filter(
        (id: any): id is string => typeof id === "string" && id.length > 0,
      );

    const docs = docIds.length
      ? await this.prisma.document.findMany({
          where: {
            id: { in: docIds },
            kbId: { in: visibleKbIds },
            status: "published",
          },
          select: { id: true, kbId: true, title: true },
        })
      : [];
    const allowed = new Map(docs.map((doc) => [doc.id, doc]));
    const sourceKeys = [...new Set(derivedGuard.sourceKeys)].sort();
    const derivedCandidates = citations.filter((citation: any) => !citation.docId && citation.slug);
    const derivedPages = derivedCandidates.length
      ? await (this.prisma as any).brainDerivedPage.findMany({
          where: {
            scopeId: derivedGuard.scopeId,
            slug: { in: derivedCandidates.map((citation: any) => citation.slug) },
            aclEpoch: derivedGuard.aclEpoch,
            knowledgeEpoch: derivedGuard.knowledgeEpoch,
          },
          select: { slug: true, sourceKeys: true, derivedFrom: true },
        })
      : [];
    const validDerived = new Set<string>();
    for (const page of derivedPages) {
      const pageSources = Array.isArray(page.sourceKeys) ? [...page.sourceKeys].sort() : [];
      if (pageSources.length !== sourceKeys.length || pageSources.some((key: string, index: number) => key !== sourceKeys[index])) continue;
      const docIds = (Array.isArray(page.derivedFrom) ? page.derivedFrom : [])
        .map((item: any) => item?.docId)
        .filter((id: any): id is string => typeof id === "string" && id.length > 0);
      if (!docIds.length) continue;
      const allowedCount = await this.prisma.document.count({
        where: { id: { in: docIds }, kbId: { in: visibleKbIds }, status: "published" },
      });
      if (allowedCount === new Set(docIds).size) validDerived.add(page.slug);
    }
    const filtered = citations
      .map((citation: any) => {
        if (!citation.docId) {
          // Derived knowledge never bypasses the document/ACL guard. A page
          // created under a different source set or epoch is simply ignored.
          return citation.slug && validDerived.has(citation.slug) ? citation : null;
        }
        const doc = allowed.get(citation.docId);
        return doc
          ? { ...citation, kbId: doc.kbId, docTitle: doc.title }
          : null;
      })
      .filter(Boolean);
    return {
      ...result,
      topics: filtered.map((citation: any) => citation.topic),
      answer: filtered
        .map((citation: any) => citation.context || citation.snippet)
        .filter(Boolean)
        .join("\n\n"),
      citations: filtered,
    };
  }

  private async applyRerank(
    question: string,
    result: any,
    breadth = false,
  ): Promise<any> {
    // GBrain's balanced query already runs its configured cross-encoder. Do
    // not score the same candidates twice; retain the platform reranker only
    // as a fail-open fallback for older/partially configured GBrain results.
    if (result?.reranked === true) return result;
    const config = this.modelConfigService
      ? await this.modelConfigService.getDefault("rerank")
      : null;
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    if (!config || citations.length < 2) return result;
    const documents = citations
      .map((citation: any) =>
        String(
          citation.snippet || citation.context || citation.docTitle || citation.topic || "",
        ).slice(0, 1000).trim(),
      )
      .filter(Boolean);
    if (documents.length < 2) return result;
    try {
      const response = await fetch(
        `${config.provider.baseUrl.replace(/\/$/, "")}/rerank`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.provider.apiKey
              ? { Authorization: `Bearer ${config.provider.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.modelName,
            query: question,
            documents,
            top_n: documents.length,
            return_documents: false,
          }),
        },
      );
      if (!response.ok) throw new Error(`Rerank API ${response.status}`);
      const payload: any = await response.json();
      const ranked: Array<{ index: number; relevance_score?: number; score?: number }> =
        Array.isArray(payload?.results) ? payload.results : [];
      if (!ranked.length) return result;

      // Extract scored items
      const scoredItems = ranked
        .map((item) => {
          const idx = Number(item.index);
          const cit = citations[idx];
          const score =
            typeof item.relevance_score === "number"
              ? item.relevance_score
              : typeof item.score === "number"
              ? item.score
              : 0;
          return { citation: cit, score };
        })
        .filter((item) => Boolean(item.citation));

      if (!scoredItems.length) return result;

      // Sort strictly by relevance score descending
      scoredItems.sort((a, b) => b.score - a.score);

      const topScore = scoredItems[0].score;
      // Filter out low relevance citations:
      const filtered = scoredItems
        .filter((item, idx) => {
          if (idx === 0) return true; // Always keep the best hit
          if (breadth) return idx < 8 && item.score >= 0.01;
          if (topScore > 0.15 && item.score < 0.08) return false;
          if (topScore > 0.3 && item.score < topScore * 0.25) return false;
          return idx < 4; // Cap focused queries at top 4
        })
        .map((item) => item.citation);

      const answer = filtered
        .map((citation: any) => citation.context || citation.snippet)
        .filter(Boolean)
        .join("\n\n");

      return {
        ...result,
        citations: filtered,
        topics: filtered.map((citation: any) => citation.topic),
        answer: answer || result.answer,
        reranked: true,
      };
    } catch (error) {
      this.logger.warn(
        `Rerank unavailable; retaining GBrain ranking: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
  }

  private emitCitationsAndComplete(
    citations: any[],
    subscriber: Subscriber<MessageEvent>,
    totalTokens: number,
    fullAnswer = "",
  ) {
    // If the LLM cited specific [n] sources, match and retain them
    const citedMatches = fullAnswer.match(/\[(\d+)\]/g) || [];
    const citedIndices = new Set(
      citedMatches.map((m) => parseInt(m.replace(/\D/g, ""), 10)),
    );

    let finalCitations = citations;
    if (citedIndices.size > 0) {
      const referenced = citations.filter((_, idx) =>
        citedIndices.has(idx + 1),
      );
      if (referenced.length > 0) {
        finalCitations = referenced;
      }
    } else if (citations.length > 3) {
      finalCitations = citations.slice(0, 2);
    }

    finalCitations.forEach((cit: any, index: number) => {
      subscriber.next({
        data: {
          type: "citation",
          index: index + 1,
          topic_slug: cit.topic,
          timeline_entry: {
            source_kb: cit.kbId,
            document_id: cit.docId,
            doc_title: cit.docTitle,
            snippet: cit.snippet || '',
          },
        },
      });
    });
    subscriber.next({
      data: { type: "done", total_tokens: totalTokens, latency_ms: 0 },
    });
    subscriber.complete();
  }
}
