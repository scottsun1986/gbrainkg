import { Injectable, Logger, MessageEvent, Optional } from "@nestjs/common";
import { Observable, Subscriber } from "rxjs";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { PrismaClient } from "@prisma/client";
import { ModelConfigService } from "../model-config.service";

type RetrievalRequest = { query: string; breadth: boolean };

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
    @Optional() private readonly modelConfigService?: ModelConfigService,
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

  private async processChat(
    userId: string,
    question: string,
    requestedKbScope: string[] | string | undefined,
    conversationId: string | undefined,
    subscriber: Subscriber<MessageEvent>,
  ) {
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
    const sourceRefs =
      typeof (this.compilerService as any).getUserSourceRefs === "function"
        ? await (this.compilerService as any).getUserSourceRefs(userId)
        : [brainRepo.gitRepoUrl];
    const conversationHistory = await this.loadConversationHistory(
      userId,
      conversationId,
      question,
    );
    // Retrieval uses a standalone current-turn query. When the user uses a
    // genuine follow-up reference ("他", "这个制度", "上一条"), a generic
    // contextual-rewrite step resolves it first; unrelated history is never
    // concatenated into the query and previous answers are never treated as
    // evidence. This avoids both lost coreference and topic contamination.
    const retrieval = await this.rewriteQueryForRetrieval(
      question,
      conversationHistory,
    );

    this.logger.debug(
      `Querying brain for "${question}" in scope ${scope.join(",")}...`,
    );
    let queryResult =
      sourceRefs.length > 1
        ? await this.gbrain.queryMany(sourceRefs, retrieval.query, {
            breadth: retrieval.breadth,
          })
        : await this.gbrain.query(
            sourceRefs[0] || brainRepo.gitRepoUrl,
            retrieval.query,
            { breadth: retrieval.breadth },
          );
    queryResult = await this.filterQueryResultByCurrentPermission(
      queryResult,
      scope,
    );
    // 历史文档可能在 BrainRepo 初始化前已经发布，先进行完整同步，再重新通过 BrainRepo 查询。
    if (!queryResult.answer) {
      await this.compilerService.syncUserBrainRepo(userId);
      const refreshedRefs =
        typeof (this.compilerService as any).getUserSourceRefs === "function"
          ? await (this.compilerService as any).getUserSourceRefs(userId)
          : [brainRepo.gitRepoUrl];
      queryResult =
        refreshedRefs.length > 1
          ? await this.gbrain.queryMany(refreshedRefs, retrieval.query, {
              breadth: retrieval.breadth,
            })
          : await this.gbrain.query(
              refreshedRefs[0] || brainRepo.gitRepoUrl,
              retrieval.query,
              { breadth: retrieval.breadth },
            );
      queryResult = await this.filterQueryResultByCurrentPermission(
        queryResult,
        scope,
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
            const content = (cit.context || cit.snippet || "").trim();
            return `【来源 ${idx + 1}】《${title}》${kbName}\n${content}`;
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
2. 【多源合并】：若多个来源共同支持某一结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号。
3. 【强相关性与去伪存真】：仅依据与当前问题直接相关的参考资料回答，忽略无关的参考材料。
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
    if (!apiKey) return { query: question, breadth: false };
    const baseUrl = (
      config?.provider.baseUrl ||
      process.env.LLM_BASE_URL ||
      "https://api.deepseek.com/v1"
    ).replace(/\/$/, "");
    const modelName =
      config?.modelName || process.env.LLM_MODEL || "deepseek-chat";
    const historyWindow = prior.slice(-12000);
    const prompt = `Analyze the current user question for knowledge-base retrieval. Rewrite it into one standalone query. Resolve references such as he/she/it/this policy/the previous item only when the conversation makes the referent unambiguous. If it starts a new topic, do not import unrelated history. Set breadth=true when answering requires broad coverage, enumeration, totals across a document, comparison of multiple sections, or "all/every/complete" evidence; otherwise false. Do not answer the question. Return JSON only: {"query":"...","breadth":false}.\n\nUntrusted conversation history:\n${historyWindow || "(none)"}\n\nCurrent question:\n${question}`;
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
      if (!response.ok) return { query: question, breadth: false };
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
        };
      } catch {
        return { query: question, breadth: false };
      }
    } catch (error) {
      this.logger.debug(
        `Contextual retrieval rewrite unavailable: ${error?.message || "unknown error"}`,
      );
      return { query: question, breadth: false };
    }
  }

  /**
   * GBrain source 是按用户编译的缓存，权限变更与索引重建之间可能存在短暂延迟。
   * 每次问答都用文档数据库再次校验命中文档，防止旧索引片段越权进入重排或 LLM 上下文。
   */
  private async filterQueryResultByCurrentPermission(
    result: any,
    visibleKbIds: string[],
  ): Promise<any> {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const docIds = citations
      .map((citation: any) => citation.docId)
      .filter(
        (id: any): id is string => typeof id === "string" && id.length > 0,
      );
    if (!docIds.length)
      return { ...result, topics: [], answer: "", citations: [] };

    const docs = await this.prisma.document.findMany({
      where: {
        id: { in: docIds },
        kbId: { in: visibleKbIds },
        status: "published",
      },
      select: { id: true, kbId: true, title: true },
    });
    const allowed = new Map(docs.map((doc) => [doc.id, doc]));
    const filtered = citations
      .map((citation: any) => {
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
          citation.context || citation.snippet || citation.docTitle || citation.topic || "",
        ).trim(),
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
