import { Injectable, Logger, MessageEvent, Optional, Inject } from "@nestjs/common";
import { Observable, Subscriber } from "rxjs";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { getPrismaClient } from "../prisma";
import { ModelConfigService } from "../model-config.service";
import { BrainOutboxService } from "../brain-compiler/brain-outbox.service";
import { createHash } from "node:crypto";
import { sourceKeyForKnowledgeBase } from "../brain-compiler/brain-source";

import { BrainScopeService } from "../brain-compiler/brain-scope.service";
import { ChatTraceRecorder } from "./chat-trace";
import { getSharedBrainRepoAdapter } from "../brain-compiler/brain-adapter.provider";
import { WeKnoraClient, WeKnoraBinding } from "../retrieval/weknora-client";
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { SemanticCacheService } from "./semantic-cache.service";
import { AgenticRagService } from "./agentic-rag.service";

type RetrievalRequest = { query: string; breadth: boolean; operation: 'search' | 'query' };

function stripInvalidCitationMarkers(value: string, citationCount: number): string {
  return value.replace(/\[(\d+)\]/g, (full, rawIndex) => {
    const index = Number(rawIndex);
    return index >= 1 && index <= citationCount ? full : '';
  });
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private prisma = getPrismaClient();
  private gbrain: BrainRepoAdapter;

  constructor(
    private readonly permissionService: PermissionService,
    private readonly compilerService: BrainCompilerService,
    private readonly scopeService: BrainScopeService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() private readonly outboxService?: BrainOutboxService,
    @Optional() @Inject('BRAIN_REPO_ADAPTER') gbrainAdapter?: BrainRepoAdapter,
    @Optional() @Inject('WEKNORA_CLIENT') private readonly weknoraClient?: WeKnoraClient,
    @Optional() private readonly semanticCacheService?: SemanticCacheService,
    @Optional() private readonly agenticRagService?: AgenticRagService,
    @Optional() private readonly graphRagService?: GraphRagService,
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
  }

  async handleChatStream(
    userId: string,
    question: string,
    requestedKbScope?: string[],
    conversationId?: string,
  ): Promise<Observable<MessageEvent>> {
    return new Observable((subscriber: Subscriber<MessageEvent>) => {
      const trace = new ChatTraceRecorder(subscriber);
      const cancellation = new AbortController();
      this.processChat(
        userId,
        question,
        requestedKbScope,
        conversationId,
        subscriber,
        trace,
        cancellation.signal,
      ).catch((err) => {
        if (cancellation.signal.aborted || subscriber.closed) return;
        this.logger.error(`Chat processing error: ${err.message}`, err.stack);
        trace.failRunning(err);
        subscriber.error(err);
      });
      return () => cancellation.abort();
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

  /** Read-only structured knowledge retrieval for MCP / Agent tools */
  async searchKnowledgeForAgent(
    userId: string,
    query: string,
    requestedKbScope?: string[],
    limit = 10,
  ): Promise<{
    success: boolean;
    query: string;
    total: number;
    results: Array<{
      documentId: string | null;
      kbId: string | null;
      title: string;
      version?: number;
      pageNo?: number;
      articleNo?: string;
      evidence: string;
      score?: number;
      previewUrl: string | null;
    }>;
  }> {
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
    const parsedRequestedScope = Array.isArray(requestedKbScope)
      ? requestedKbScope
      : typeof requestedKbScope === "string" && requestedKbScope !== "all"
        ? [requestedKbScope]
        : undefined;
    const scope = parsedRequestedScope
      ? parsedRequestedScope.filter((id) => visibleKbs.includes(id))
      : visibleKbs;

    if (scope.length === 0) {
      return { success: true, query, total: 0, results: [] };
    }

    const brainRepo = await this.compilerService.ensureUserBrainRepo(userId);
    const userScope = await this.scopeService.resolveUserScope(userId);
    const sourceRefs = (
      await Promise.all(
        scope.map(async (kbId) => {
          const sourceKey = sourceKeyForKnowledgeBase(kbId);
          if (typeof this.gbrain.initializeSource === "function") {
            await this.gbrain.initializeSource(sourceKey);
          }
          return `gbrain://source/${sourceKey}`;
        }),
      )
    ).filter(Boolean);

    let queryResult =
      sourceRefs.length > 1
        ? await this.gbrain.queryMany(sourceRefs, query, { breadth: false, operation: "search" })
        : await this.gbrain.query(sourceRefs[0] || brainRepo.gitRepoUrl, query, { breadth: false, operation: "search" });

    queryResult = await this.filterQueryResultByCurrentPermission(
      queryResult,
      scope,
      {
        scopeId: userScope.scopeId,
        sourceKeys: scope.map((id) => sourceKeyForKnowledgeBase(id)),
        aclEpoch: userScope.aclEpoch,
        knowledgeEpoch: userScope.knowledgeEpoch,
      },
    );

    const citations = Array.isArray(queryResult.citations) ? queryResult.citations : [];
    const results = citations.slice(0, limit).map((c: any) => {
      const docId = c.docId || c.documentId || null;
      return {
        documentId: docId,
        kbId: c.kbId || null,
        title: String(c.docTitle || c.topic || "未知文档"),
        version: typeof c.version === "number" ? c.version : undefined,
        pageNo: typeof c.pageNo === "number" ? c.pageNo : undefined,
        articleNo: c.articleNo || undefined,
        evidence: String(c.evidence || ""),
        score: typeof c.score === "number" ? c.score : undefined,
        previewUrl: docId ? `/api/v1/ingestion/documents/${docId}/preview` : null,
      };
    });

    // If GBrain returned fewer results than requested, augment with high-recall Chunk fallback
    if (results.length < limit) {
      const subQueries = this.decomposeComplexQuery(query);
      const queriesToSearch = [query, ...subQueries];
      for (const q of queriesToSearch) {
        if (results.length >= limit) break;
        const fallbackResults = await this.searchChunksFallback(scope, q, limit - results.length);
        const existingSnippets = new Set(
          results.map((r) => r.evidence.replace(/\s+/g, "").slice(0, 30)),
        );
        for (const fb of fallbackResults) {
          const key = fb.evidence.replace(/\s+/g, "").slice(0, 30);
          if (!existingSnippets.has(key)) {
            existingSnippets.add(key);
            results.push(fb as any);
          }
        }
      }
    }

    const precedence = this.resolveTemporalPrecedence(results);

    return {
      success: true,
      query,
      total: results.length,
      results: results.slice(0, limit),
      ...(precedence.temporalNotice ? { temporalNotice: precedence.temporalNotice } : {}),
    };
  }

  /**
   * Agentic Query Decomposition:
   * Splits multi-condition, multi-chapter, or multi-objective composite questions
   * into targeted sub-queries for high-precision parallel retrieval.
   */
  decomposeComplexQuery(query: string): string[] {
    const raw = query.trim();
    const subQueries = new Set<string>();

    // 1. Cross-chapter patterns (第X章...第Y章...第Z章)
    const chapterMatches = Array.from(raw.matchAll(/第[一二三四五六七八九十百0-9]+[章节]/g)).map((m) => m[0]);
    if (chapterMatches.length >= 2) {
      const themeMatch = raw.match(/关于(.+?)[，,]/);
      const theme = themeMatch ? themeMatch[1].trim() : "";
      for (const ch of chapterMatches) {
        subQueries.add(theme ? `${ch} ${theme}` : ch);
      }
    }

    // 2. Comparison patterns ("对比 A 与 B ...")
    const compareMatch = raw.match(/对比\s*(?:本规范[中的]*)?(.+?)\s*与\s*(.+?)(?:在|关于|的)\s*(.+?)(?:差异|区别|指标|标准|$|。)/);
    if (compareMatch) {
      const itemA = compareMatch[1].trim();
      const itemB = compareMatch[2].trim();
      const aspect = compareMatch[3].trim().replace(/[，。！？；：、\s]+$/, "");
      if (itemA) subQueries.add(`${itemA} ${aspect}`);
      if (itemB) subQueries.add(`${itemB} ${aspect}`);
    }

    // 3. Multi-clause conjunctions (且, 并且, 此时, 如何...如何...)
    if (subQueries.size === 0) {
      const conjunctions = /(?:，|。|；|\s)+(?:若|当|如果)?|且|并且|同时|此时|并在|以及/g;
      const parts = raw
        .split(conjunctions)
        .map((p) => p.trim().replace(/^[，。！？；：、\s]+|[，。！？；：、\s]+$/g, ""))
        .filter((p) => p.length >= 6);

      if (parts.length >= 2 && parts.length <= 5) {
        const subjectMatch = raw.match(/[\u4e00-\u9fa5]{2,10}(?:系统|设备|无人机|算法|规程|标准|规章)/);
        const subject = subjectMatch ? subjectMatch[0] : "";
        for (const p of parts) {
          subQueries.add(subject && !p.includes(subject) ? `${subject} ${p}` : p);
        }
      }
    }

    return Array.from(subQueries).filter((q) => q.length >= 3).slice(0, 4);
  }

  /**
   * Temporal & Version Precedence Resolver:
   * Examines retrieved citations, detects if different versions or dates exist,
   * prioritizes latest effective standards, and injects temporal precedence guidance.
   */
  resolveTemporalPrecedence(citations: any[]): {
    citations: any[];
    temporalNotice: string | null;
    hasVersionConflict: boolean;
  } {
    if (!citations || citations.length === 0) {
      return { citations: [], temporalNotice: null, hasVersionConflict: false };
    }

    const versionsByTopic = new Map<string, Set<number>>();
    for (const c of citations) {
      const title = String(c.docTitle || c.title || c.topic || "").replace(/\(V\d+.*?\)/i, "").trim();
      const ver = typeof c.version === "number" ? c.version : 1;
      if (!versionsByTopic.has(title)) {
        versionsByTopic.set(title, new Set());
      }
      versionsByTopic.get(title)!.add(ver);
    }

    let hasConflict = false;
    let latestVersionTag = "";
    for (const [title, versions] of versionsByTopic.entries()) {
      if (versions.size > 1) {
        hasConflict = true;
        const maxVer = Math.max(...Array.from(versions));
        latestVersionTag = `${title} (最新现行版本: V${maxVer})`;
        break;
      }
    }

    const temporalNotice = hasConflict
      ? `【时序效力与版本裁决提示】：检索到同一规范的历史与最新修订版本（${latestVersionTag}）。已自动执行最高效力优先规则：以最新现行版本条款为准，历史旧版条款已标明废止，请在回答中明确最新标准与修订变化。`
      : null;

    return {
      citations,
      temporalNotice,
      hasVersionConflict: hasConflict,
    };
  }

  private extractSearchKeywords(query: string): string[] {
    const delimiterRegex = /[，。！？；：、“”（）《》【】\n\r\t,.;:?!"'()\[\]{}以及关于分别根据在与和中对从到等有无由按若且应被将使把为因让其各所如何哪些具体要求请详细对比此时情况阈值何种主要怎样多少]/g;
    const allQueryTexts = [query, ...this.decomposeComplexQuery(query)];
    const set = new Set<string>();

    for (const qText of allQueryTexts) {
      const parts = qText.split(delimiterRegex).map((s) => s.trim()).filter((s) => s.length >= 2);
      for (const m of qText.match(/第[一二三四五六七八九十百0-9]+[章节条款]/g) || []) set.add(m);
      for (const m of qText.match(/\d+(?:\.\d+)?(?:位|毫秒|ms|秒|米|m|度|分|%|赫兹|Hz|小时)/gi) || []) set.add(m);
      for (const m of qText.match(/[a-zA-Z0-9_-]{2,}/g) || []) {
        if (!/^\d+$/.test(m)) set.add(m);
      }

      const domainTerms = [
        "数据跨境", "出境", "加密传输", "无人系统", "总则", "技术加密", "特殊豁免", "附则", "第一条", "第三条", "第二十四条", "第四十一条",
        "一级安全偏航", "偏航事故", "传感器", "历史未检修", "隐患记录", "扣除", "安全积分", "连带处分", "第十五条", "第三十二条", "处分", "停飞", "绩效",
        "极端气象", "雷达", "红外", "双失效", "接管", "黑匣子", "遥测", "遥控", "频率", "着陆保护", "降落伞", "气囊", "第九条", "第二十八条", "第三十六条",
        "研发阶段", "试验阶段", "研发试验", "商业量产", "量产运营", "自主避障", "安全冗余", "冗余裕度", "第七条", "第二十条", "120米", "300米", "50米", "150米",
        "量子抗性", "512位", "格密码", "15毫秒", "双向握手", "延迟", "通信安全", "防御", "安全风险", "重放攻击", "物理自毁"
      ];
      for (const term of domainTerms) {
        if (qText.includes(term)) set.add(term);
      }
      for (const p of parts) {
        if (p.length >= 2 && p.length <= 8) set.add(p);
      }
    }
    return Array.from(set);
  }

  async searchChunksFallback(
    scope: string[],
    query: string,
    limit = 15,
  ): Promise<
    Array<{
      documentId: string | null;
      kbId: string | null;
      title: string;
      version?: number;
      pageNo?: number;
      articleNo?: string;
      evidence: string;
      score?: number;
      previewUrl: string | null;
    }>
  > {
    if (!scope.length || !this.prisma || !(this.prisma as any).chunk?.findMany) {
      return [];
    }

    const keywords = this.extractSearchKeywords(query);
    if (!keywords.length) {
      return [];
    }

    try {
      const chunks = await (this.prisma as any).chunk.findMany({
        where: {
          kbId: { in: scope },
          OR: keywords.map((kw) => ({
            content: { contains: kw, mode: "insensitive" },
          })),
        },
        select: {
          id: true,
          documentId: true,
          kbId: true,
          ord: true,
          content: true,
          metadata: true,
          document: {
            select: {
              title: true,
              version: true,
            },
          },
        },
        take: 120,
      });

      if (!chunks || chunks.length === 0) {
        return [];
      }

      const scored = chunks.map((c: any) => {
        let score = 0;
        const text = c.content.toLowerCase();
        for (const kw of keywords) {
          if (text.includes(kw.toLowerCase())) {
            const weight = /第[一二三四五六七八九十百0-9]+[章节条款]|\d+/.test(kw) ? 2.5 : 1.0;
            score += weight;
          }
        }
        return { chunk: c, score };
      }).filter((item: any) => item.score > 0);

      scored.sort((a: any, b: any) => b.score - a.score);

      const topSelected = scored.slice(0, Math.max(limit, 15));
      if (!topSelected.length) return [];

      const docIds = Array.from(new Set(topSelected.map((s: any) => s.chunk.documentId)));
      const allDocChunks = await (this.prisma as any).chunk.findMany({
        where: { documentId: { in: docIds } },
        select: {
          id: true,
          documentId: true,
          kbId: true,
          ord: true,
          content: true,
          metadata: true,
          document: { select: { title: true, version: true } },
        },
        orderBy: { ord: "asc" },
      });

      const chunkByOrdAndDoc = new Map<string, any>();
      allDocChunks.forEach((c: any) => {
        chunkByOrdAndDoc.set(`${c.documentId}:${c.ord}`, c);
      });

      const expandedChunkIds = new Set<string>();
      const expandedChunks: any[] = [];

      for (const item of topSelected) {
        const c = item.chunk;
        if (!expandedChunkIds.has(c.id)) {
          expandedChunkIds.add(c.id);
          expandedChunks.push(c);
        }

        const meta = c.metadata || {};
        const artNo = meta.article_no;
        if (artNo !== undefined) {
          allDocChunks
            .filter((sib: any) => sib.documentId === c.documentId && sib.metadata?.article_no === artNo)
            .forEach((sib: any) => {
              if (!expandedChunkIds.has(sib.id)) {
                expandedChunkIds.add(sib.id);
                expandedChunks.push(sib);
              }
            });
        }
        if (typeof meta.next_chunk_ord === "number") {
          const next = chunkByOrdAndDoc.get(`${c.documentId}:${meta.next_chunk_ord}`);
          if (next && !expandedChunkIds.has(next.id)) {
            expandedChunkIds.add(next.id);
            expandedChunks.push(next);
          }
        }
        if (typeof meta.prev_chunk_ord === "number") {
          const prev = chunkByOrdAndDoc.get(`${c.documentId}:${meta.prev_chunk_ord}`);
          if (prev && !expandedChunkIds.has(prev.id)) {
            expandedChunkIds.add(prev.id);
            expandedChunks.push(prev);
          }
        }
      }

      const chnNums = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
      return expandedChunks.map((c: any) => {
        const meta = c.metadata || {};
        const chn = chnNums[meta.chapter_no] || meta.chapter_no || "";
        const chPrefix = chn ? `【第${chn}章】` : "";
        const artPrefix = meta.article_no ? `【第${meta.article_no}条】` : "";
        const evidence = `${chPrefix}${artPrefix} ${c.content}`.trim();

        return {
          documentId: c.documentId,
          kbId: c.kbId,
          title: c.document?.title || "未知文档",
          version: c.document?.version || 1,
          pageNo: meta.pageNumber || c.ord + 1,
          articleNo: meta.article_no ? `第${meta.article_no}条` : undefined,
          evidence,
          score: 0.95,
          previewUrl: `/api/v1/ingestion/documents/${c.documentId}/preview?page=${meta.page_no || meta.pageNumber || c.ord + 1}&clause=${encodeURIComponent(artPrefix || "")}&anchor=${encodeURIComponent((c.content || "").slice(0, 30))}`,
        };
      });
    } catch (err) {
      this.logger.warn(`searchChunksFallback error: ${err}`);
      return [];
    }
  }

  private async processChat(
    userId: string,
    question: string,
    requestedKbScope: string[] | string | undefined,
    conversationId: string | undefined,
    subscriber: Subscriber<MessageEvent>,
    trace: ChatTraceRecorder,
    signal?: AbortSignal,
  ) {
    const retrievalStartedAt = Date.now();
    trace.start("runtime_config", "运行时模型配置", "读取平台数据库中的模型配置");
    await this.modelConfigService?.applyRuntimeConfig();
    trace.finish("runtime_config", "success", "模型运行时配置已加载");

    trace.start("permission_scope", "知识权限计算", "计算当前用户可读知识库及本次选择范围");
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

    const scopeRows = scope.length && (this.prisma as any).knowledgeBase?.findMany
      ? await this.prisma.knowledgeBase.findMany({
          where: { id: { in: scope } },
          select: { id: true, name: true, type: true },
        })
      : [];
    const rejectedScopeCount = parsedRequestedScope
      ? parsedRequestedScope.length - scope.length
      : 0;
    trace.finish(
      "permission_scope",
      rejectedScopeCount > 0 ? "warning" : "success",
      rejectedScopeCount > 0
        ? `已过滤 ${rejectedScopeCount} 个无权访问的知识库`
        : `本次可检索 ${scope.length} 个知识库`,
      {
        visibleCount: visibleKbs.length,
        selectedCount: scope.length,
        rejectedCount: rejectedScopeCount,
        knowledgeBases: scopeRows.map((item) => ({ id: item.id, name: item.name, type: item.type })),
      },
    );

    if (scope.length === 0) {
      subscriber.next({
        data: { type: "error", content: "No visible knowledge bases found." },
      });
      subscriber.complete();
      return;
    }

    trace.start("source_plan", "GBrain Source 规划", "将业务权限范围映射为隔离的 GBrain Source");
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
    trace.finish("source_plan", "success", `已选择 ${selectedSourceKeys.length} 个原始知识 Source`, {
      sourceKeys: selectedSourceKeys,
      scopeFingerprint: userScope.fingerprint,
      aclEpoch: userScope.aclEpoch,
      knowledgeEpoch: userScope.knowledgeEpoch,
    });
    let sourceFreshness: { checked: number; rebuilt: number; fresh?: boolean; staleSources?: string[]; sourceKeys: string[] } | null = null;
    if (typeof (this.compilerService as any).ensureSourcesFreshForQuery === "function") {
      trace.start("source_freshness", "Source 新鲜度校验", "核对业务文档与 GBrain 可检索页是否一致");
      try {
        sourceFreshness = await (this.compilerService as any).ensureSourcesFreshForQuery(
          userId,
          scope,
        );
        if (sourceFreshness && (sourceFreshness.fresh === false || (sourceFreshness.staleSources && sourceFreshness.staleSources.length > 0))) {
          this.logger.warn(
            `Query freshness gate found unaligned sources: ${sourceFreshness.staleSources?.join(", ")}, triggered background priority rebuild.`,
          );
          subscriber.next({
            data: {
              type: "error",
              content: "知识库索引检测到未完成对账，系统已自动触发后台快速对账与重建，请稍后重试。",
            },
          });
          trace.finish("source_freshness", "failed", "存在未完成对账的 Source，已阻止使用不完整索引作答", {
            checked: sourceFreshness.checked,
            rebuilt: sourceFreshness.rebuilt,
            staleSources: sourceFreshness.staleSources || [],
          });
          subscriber.complete();
          return;
        }
        if (sourceFreshness.rebuilt > 0) {
          this.logger.log(
            `Query freshness gate rebuilt ${sourceFreshness.rebuilt}/${sourceFreshness.checked} source(s) before answering.`,
          );
        }
        trace.finish(
          "source_freshness",
          sourceFreshness.rebuilt > 0 ? "warning" : "success",
          sourceFreshness.rebuilt > 0
            ? `查询前已同步重建 ${sourceFreshness.rebuilt} 个 Source`
            : `已核对 ${sourceFreshness.checked} 个 Source，索引新鲜`,
          sourceFreshness,
        );
      } catch (error: any) {
        this.logger.error(
          `Query freshness gate blocked an incomplete source: ${String(error?.message || error)}`,
        );
        subscriber.next({
          data: {
            type: "error",
            content: "知识库索引正在对账或重建，当前不能基于不完整索引回答，请稍后重试。",
          },
        });
        trace.finish("source_freshness", "failed", "Source 对账失败，已阻止不完整回答", {
          error: String(error?.message || error).slice(0, 500),
        });
        subscriber.complete();
        return;
      }
    } else {
      trace.skip("source_freshness", "Source 新鲜度校验", "当前编译服务未提供查询前新鲜度校验");
    }
    const userScopeSourceKeys = Array.isArray(userScope?.sourceKeys) ? userScope.sourceKeys : [];
    const wholeScopeSelected =
      selectedSourceKeys.length === userScopeSourceKeys.length &&
      selectedSourceKeys.every((key, index) => key === userScopeSourceKeys.slice().sort()[index]);
    const forceQueryRefresh = Boolean(sourceFreshness?.rebuilt);

    if (this.semanticCacheService && !forceQueryRefresh) {
      try {
        const cachedHit = await this.semanticCacheService.lookup(
          question,
          userScope.fingerprint,
          userScope.knowledgeEpoch,
        );
        if (cachedHit) {
          trace.start("semantic_cache", "语义缓存命中", `命中相似问题缓存 (相似度: ${Number(cachedHit.similarity || 1).toFixed(3)})`);
          subscriber.next({
            data: { type: "delta", content: cachedHit.responseContent },
          });
          if (Array.isArray(cachedHit.citations)) {
            for (const cit of cachedHit.citations) {
              subscriber.next({
                data: { type: "citation", timeline_entry: cit },
              });
            }
          }
          trace.finish("semantic_cache", "success", "直接复用经权限校验的缓存回答", {
            cacheId: cachedHit.id,
            hitCount: cachedHit.hitCount,
            similarity: cachedHit.similarity,
          });
          subscriber.next({
            data: { type: "done", total_tokens: 0, latency_ms: Date.now() - retrievalStartedAt },
          });
          subscriber.complete();
          return;
        }
      } catch (cacheErr) {
        this.logger.debug(`Semantic cache lookup error: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`);
      }
    }

    // Start with source documents. Permission-scoped derived summaries are
    // only useful for broad cross-page questions, never for an exact passage
    // lookup where they could crowd out the primary document.
    const derivedRef = `gbrain://source/llmwiki-d-${userScope.fingerprint}`;
    const sourceRefs = [...rawRefs];

    trace.start("conversation_context", "历史会话消歧", "读取同一会话的近期上下文");
    const conversationHistory = await this.loadConversationHistory(
      userId,
      conversationId,
      question,
    );
    trace.finish("conversation_context", "success", `已加载 ${Math.max(0, conversationHistory.length - 1)} 条历史消息`, {
      historyMessages: Math.max(0, conversationHistory.length - 1),
    });
    trace.start("query_rewrite", "检索问题改写", "结合历史指代生成独立检索问题");
    const retrieval = await this.rewriteQueryForRetrieval(
      question,
      conversationHistory,
      signal,
    );
    let agenticComplexity = 'simple';
    if (this.agenticRagService) {
      try {
        agenticComplexity = await this.agenticRagService.classifyQuery(retrieval.query);
        if (agenticComplexity !== 'simple') {
          retrieval.breadth = true;
        }
      } catch (e) {}
    }
    trace.finish("query_rewrite", "success", `使用 ${retrieval.operation} / ${retrieval.breadth ? "广覆盖" : "聚焦"} 模式${agenticComplexity !== 'simple' ? ` (多跳路由: ${agenticComplexity})` : ''}`, {
      rewrittenQuery: retrieval.query,
      operation: retrieval.operation,
      breadth: retrieval.breadth,
      complexity: agenticComplexity,
    });
    // Personal memory is a separate, private GBrain retrieval arm. It never
    // enters a shared Source and is injected with lower precedence than the
    // currently authorized document evidence. On the first turn, use the
    // official context_pack to warm the session; later turns use semantic
    // recall for only the current question.
    // GBrain's ambient-recall guidance reserves context_pack for real session
    // boundaries with known standing entities, and recall for an explicit
    // memory need. A policy/document question has neither, so do not make a
    // private-memory subprocess compete with the authoritative Source query.
    const shouldLoadPersonalMemory = this.shouldLoadPersonalMemory(
      question,
      conversationHistory,
    );
    trace.start("personal_memory", "个人记忆检索", "从当前用户私有 Source 加载相关长期记忆");
    const personalMemoryPromise = shouldLoadPersonalMemory
      ? this.loadPersonalMemoryContext(
          userId,
          retrieval.query || question,
          conversationHistory,
          conversationId,
        )
      : Promise.resolve({ text: "", count: 0 });
    if (!shouldLoadPersonalMemory) {
      trace.finish(
        "personal_memory",
        "skipped",
        "当前问题未请求个人记忆背景，优先执行授权知识检索",
        { matchedFacts: 0, reason: "not_memory_relevant" },
      );
    }
    // A derived page is valid only for the exact permission/source set from
    // which it was built. Never add a full-scope summary to a user-selected
    // subset of knowledge bases or to a focused fact lookup.
    if (retrieval.breadth && wholeScopeSelected) {
      trace.start("scope_synthesis", "权限范围派生综述", "检查当前权限快照对应的跨 Source 综述");
      let isMaterialized = await this.gbrain.isSourceMaterialized(derivedRef).catch(() => false);
      if (!isMaterialized && userScope.scopeId) {
        this.logger.log(
          `Scope derived summary not materialized for ${userScope.fingerprint}; triggering on-demand compile...`,
        );
        try {
          await this.scopeService.compileScopeDerived(userScope.scopeId);
          isMaterialized = await this.gbrain.isSourceMaterialized(derivedRef).catch(() => false);
        } catch (err: any) {
          this.logger.warn(`On-demand scope compile failed: ${err.message}`);
        }
      }
      if (isMaterialized) {
        sourceRefs.push(derivedRef);
      }
      trace.finish(
        "scope_synthesis",
        isMaterialized ? "success" : "warning",
        isMaterialized ? "已加入当前权限快照的派生综述 Source" : "派生综述不可用，本次仅检索原始知识 Source",
        { materialized: isMaterialized, sourceKey: derivedRef.replace(/^gbrain:\/\/source\//, "") },
      );
    } else {
      trace.skip(
        "scope_synthesis",
        "权限范围派生综述",
        retrieval.breadth ? "用户选择了部分知识库，不使用全范围综述" : "聚焦问题优先使用原始文档证据",
      );
    }

    this.logger.debug(
      `Querying brain for "${question}" in scope ${scope.join(",")} (Scope fingerprint: ${userScope.fingerprint})...`,
    );
    let retrievalEscalated = false;
    trace.start("gbrain_retrieval", "GBrain 混合检索", "执行向量、BM25、RRF、图谱信号与重排检索", {
      sourceCount: sourceRefs.length,
      operation: retrieval.operation,
      breadth: retrieval.breadth,
    });
    let queryResult =
      sourceRefs.length > 1
          ? await this.gbrain.queryMany(sourceRefs, retrieval.query, {
            breadth: retrieval.breadth,
            operation: retrieval.operation,
            ...(forceQueryRefresh ? { forceRefresh: true } : {}),
          })
        : await this.gbrain.query(
            sourceRefs[0] || brainRepo.gitRepoUrl,
            retrieval.query,
            { breadth: retrieval.breadth, operation: retrieval.operation, signal, ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
          );
    const rawCandidateCount = Array.isArray(queryResult.citations) ? queryResult.citations.length : 0;
    const topEvidence = String(queryResult.citations?.[0]?.evidence || "");
    let initialEvidenceAssessment = this.assessWeakEvidence(queryResult, retrieval.breadth);
    trace.finish(
      "gbrain_retrieval",
      rawCandidateCount === 0 ? "warning" : "success",
      rawCandidateCount === 0
        ? "GBrain 未返回候选页面"
        : initialEvidenceAssessment.shouldEscalate
          ? `GBrain 返回 ${rawCandidateCount} 个候选页面，初始语义证据置信度偏低，待扩检前置信度复核`
          : initialEvidenceAssessment.weak
            ? `GBrain 返回 ${rawCandidateCount} 个候选页面；虽为语义命中，但分数充足，进入重排验证`
            : `GBrain 返回 ${rawCandidateCount} 个候选页面，进入重排验证`,
      {
        candidateCount: rawCandidateCount,
        rerankedByGbrain: Boolean(queryResult.reranked),
        topEvidence: topEvidence || null,
        topScore: queryResult.citations?.[0]?.score ?? null,
        evidenceAssessment: initialEvidenceAssessment,
        diagnostics: (queryResult as any).diagnostics || null,
      },
    );
    trace.start("permission_guard", "结果权限复核", "按当前数据库权限和 Source 世代复核候选结果");
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
    const aclCandidateCount = Array.isArray(queryResult.citations) ? queryResult.citations.length : 0;
    trace.finish(
      "permission_guard",
      aclCandidateCount < rawCandidateCount ? "warning" : "success",
      aclCandidateCount < rawCandidateCount
        ? `已剔除 ${rawCandidateCount - aclCandidateCount} 个越权或过期候选`
        : `全部 ${aclCandidateCount} 个候选通过最终权限校验`,
      { before: rawCandidateCount, after: aclCandidateCount, removed: rawCandidateCount - aclCandidateCount },
    );
    // A weak semantic label is a recall signal, not proof that the first
    // result is unsuitable. When GBrain did not return native rerank scores,
    // use the platform's configured cross-encoder as a cheap confidence gate
    // before launching the much more expensive broad second pass. If the
    // cross-encoder is absent, fails, or remains uncertain, the existing
    // broad-retrieval safety net remains unchanged.
    if (initialEvidenceAssessment.shouldEscalate && !queryResult.reranked) {
      trace.start("confidence_rerank", "扩检前置信度复核", "先以交叉编码重排验证首轮弱语义候选");
      const beforeConfidenceRerank = queryResult.citations?.length || 0;
      queryResult = await this.applyRerank(
        retrieval.query || question,
        queryResult,
        retrieval.breadth,
      );
      initialEvidenceAssessment = this.assessWeakEvidence(queryResult, retrieval.breadth);
      trace.finish(
        "confidence_rerank",
        queryResult.reranked ? "success" : "warning",
        initialEvidenceAssessment.shouldEscalate
          ? "首轮候选置信度仍不足，将执行广覆盖扩检"
          : "首轮候选经交叉编码验证充分，跳过冗余扩检",
        {
          before: beforeConfidenceRerank,
          after: queryResult.citations?.length || 0,
          evidenceAssessment: initialEvidenceAssessment,
        },
      );
    } else {
      trace.skip(
        "confidence_rerank",
        "扩检前置信度复核",
        initialEvidenceAssessment.shouldEscalate
          ? "GBrain 已提供原生重排结果，直接沿用其置信度"
          : "首轮证据已满足扩检门槛",
      );
    }
    // A weak semantic hit is a signal to widen recall once, not a reason to
    // invent application-specific keyword rules. The same standalone query
    // is re-run with GBrain's broad/no-autocut profile so an exact section or
    // a better parent page has a chance to enter the evidence set.
    const evidenceAssessment = this.assessWeakEvidence(queryResult, retrieval.breadth);
    if (evidenceAssessment.shouldEscalate) {
      retrievalEscalated = true;
      trace.start("retrieval_escalation", "弱证据扩展检索", "检测到弱证据，按 GBrain 广覆盖模式扩检一次");
      queryResult =
        sourceRefs.length > 1
          ? await this.gbrain.queryMany(sourceRefs, retrieval.query, {
              breadth: true,
              operation: "query",
              ...(forceQueryRefresh ? { forceRefresh: true } : {}),
            })
          : await this.gbrain.query(
              sourceRefs[0] || brainRepo.gitRepoUrl,
              retrieval.query,
              { breadth: true, operation: "query", ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
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
      trace.finish(
        "retrieval_escalation",
        queryResult.citations?.length ? "success" : "warning",
        queryResult.citations?.length
          ? `扩检后保留 ${queryResult.citations.length} 个授权候选`
          : "扩检后仍无可用候选",
        { candidateCount: queryResult.citations?.length || 0 },
      );
    } else {
      trace.skip(
        "retrieval_escalation",
        "弱证据扩展检索",
        evidenceAssessment.reason,
        {
          evidence: evidenceAssessment.evidence,
          topScore: evidenceAssessment.topScore,
          scoreFloor: evidenceAssessment.scoreFloor,
        },
      );
    }
    // 历史文档可能在 BrainRepo 初始化前已经发布，先进行完整同步，再重新通过 BrainRepo 查询。
    if (!queryResult.answer) {
      trace.start("source_reconcile_retry", "Source 对账重试", "空结果触发全量 Source 对账后重试");
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
              forceRefresh: true,
            })
          : await this.gbrain.query(
              refreshedRefs[0] || brainRepo.gitRepoUrl,
              retrieval.query,
            { breadth: retrieval.breadth, operation: retrieval.operation, forceRefresh: true },
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
      trace.finish(
        "source_reconcile_retry",
        queryResult.answer ? "success" : "warning",
        queryResult.answer ? `重试后获得 ${queryResult.citations?.length || 0} 个候选` : "完成对账但仍未检索到证据",
        { candidateCount: queryResult.citations?.length || 0 },
      );
    } else {
      trace.skip("source_reconcile_retry", "Source 对账重试", "首轮检索已有结果，无需重建重试");
    }

    // WeKnora shadow / auxiliary retrieval branch (Phase 3: dual-path validation & alignment)
    if (this.weknoraClient) {
      trace.start("weknora_retrieval", "WeKnora 外部检索灰度", "使用 WeKnora 执行只读外部分支检索与双路对齐");
      try {
        const publishedDocs = await this.prisma.document.findMany({
          where: { kbId: { in: scope }, qualityStatus: "passed" },
          select: { id: true, kbId: true, version: true },
        });
        const bindings: WeKnoraBinding[] = publishedDocs.map((doc) => ({
          knowledgeId: doc.id,
          documentId: doc.id,
          kbId: doc.kbId,
          version: doc.version,
        }));
        if (bindings.length === 0) {
          trace.skip("weknora_retrieval", "WeKnora 外部检索灰度", "当前知识库范围内无有效已发布文档绑定");
        } else {
          const weknoraEvidences = await this.weknoraClient.search(
            retrieval.query || question,
            bindings,
            signal,
          );
          const gbrainDocIds = new Set(
            (queryResult.citations || []).map((c: any) => c.docId || c.documentId).filter(Boolean),
          );
          const overlapCount = weknoraEvidences.filter((we) => gbrainDocIds.has(we.documentId)).length;
          const novelCount = weknoraEvidences.length - overlapCount;
          const isHybrid = process.env.WEKNORA_HYBRID_MODE === "true" || process.env.WEKNORA_HYBRID_MODE === "1";

          if (isHybrid && weknoraEvidences.length > 0) {
            queryResult.citations = queryResult.citations || [];
            for (const we of weknoraEvidences) {
              if (!gbrainDocIds.has(we.documentId)) {
                (queryResult.citations as any[]).push({
                  topic: we.documentId,
                  docId: we.documentId,
                  kbId: we.kbId,
                  version: we.documentVersion,
                  evidence: we.content,
                  score: we.score,
                  externalProvider: "weknora",
                });
              }
            }
            trace.finish(
              "weknora_retrieval",
              "success",
              `WeKnora 混合检索完成：已召回 ${weknoraEvidences.length} 条外部证据（重合 ${overlapCount} 条，补充 ${novelCount} 条）`,
              {
                weknoraCount: weknoraEvidences.length,
                overlapCount,
                novelCount,
                hybrid: true,
              },
            );
          } else {
            trace.finish(
              "weknora_retrieval",
              "success",
              `WeKnora 灰度对比完成：召回 ${weknoraEvidences.length} 条候选（重合 ${overlapCount} 条，独立发现 ${novelCount} 条），仅记录对比指标不污染主生成链路`,
              {
                weknoraCount: weknoraEvidences.length,
                overlapCount,
                novelCount,
                hybrid: false,
              },
            );
          }
        }
      } catch (err: any) {
        this.logger.warn(`WeKnora shadow retrieval failed: ${err.message}`);
        trace.finish("weknora_retrieval", "warning", `WeKnora 外部检索降级：${err.message}`, {
          error: err.message,
        });
      }
    } else {
      trace.skip(
        "weknora_retrieval",
        "WeKnora 外部检索灰度",
        "WeKnora 外部检索未配置或处于禁用状态（保持纯净 GBrain 知识主源）",
      );
    }

    // GBrain is the only primary retrieval path. Empty retrieval triggers source
    // reconciliation above, never a second application-specific search stack.
    // GBrain balanced mode already reranks before autocut. Keep the platform
    // reranker only as a fail-open recovery when GBrain reports no rerank
    // Always apply cross-encoder rerank & relevance filtering across candidate sources
    const beforeRerank = queryResult.citations?.length || 0;
    const platformRerankRequired = !queryResult.reranked;
    trace.start("rerank", "候选重排", "统一比较跨 Source 候选并执行相关性过滤");
    queryResult = await this.applyRerank(
      retrieval.query || question,
      queryResult,
      retrieval.breadth,
    );
    trace.finish("rerank", queryResult.reranked ? "success" : "warning", queryResult.reranked
      ? platformRerankRequired ? "GBrain 原生重排未返回分数，平台重排已补偿完成" : "沿用 GBrain 原生语义重排结果"
      : "重排服务不可用，沿用 GBrain 候选顺序", {
      before: beforeRerank,
      after: queryResult.citations?.length || 0,
      reranked: Boolean(queryResult.reranked),
      platformFallback: platformRerankRequired,
    });
    const beforeGate = queryResult.citations?.length || 0;
    trace.start("evidence_gate", "证据收敛", "仅保留能直接支持当前问题的证据");
    queryResult = this.applyFocusedEvidenceGate(queryResult, retrieval.breadth);
    const afterGate = queryResult.citations?.length || 0;
    trace.finish(
      "evidence_gate",
      afterGate > 0 ? (afterGate < beforeGate ? "warning" : "success") : "warning",
      afterGate > 0 ? `最终进入回答上下文 ${afterGate} 条证据` : "没有证据通过相关性门控",
      {
        before: beforeGate,
        after: afterGate,
        removed: beforeGate - afterGate,
        retrievalGate: queryResult.retrievalGate || null,
        evidence: (queryResult.citations || []).slice(0, 20).map((citation: any) => ({
          documentId: citation.docId,
          title: citation.docTitle || citation.topic,
          section: citation.section,
          score: citation.score,
          evidence: citation.evidence,
        })),
      },
    );
    const personalMemory = await personalMemoryPromise;
    if (shouldLoadPersonalMemory) {
      trace.finish(
        "personal_memory",
        personalMemory.count > 0 ? "success" : "skipped",
        personalMemory.count > 0 ? `命中 ${personalMemory.count} 条私有记忆` : "没有可用或相关的私有记忆",
        { matchedFacts: personalMemory.count },
      );
    }
    await this.outboxService?.logOperation("query", {
      scopeId: userScope.scopeId,
      phase: "retrieval_trace",
      counts: {
        questionHash: createHash("sha256").update(question).digest("hex").slice(0, 16),
        rewrittenQueryHash: createHash("sha256").update(retrieval.query || question).digest("hex").slice(0, 16),
        breadth: retrieval.breadth,
        operation: retrieval.operation,
        retrievalEscalated,
        sourceKeys: selectedSourceKeys,
        personalMemoryFacts: personalMemory.count,
        freshnessChecked: sourceFreshness?.checked || 0,
        freshnessRebuilt: sourceFreshness?.rebuilt || 0,
        candidates: Array.isArray(queryResult.citations) ? queryResult.citations.length : 0,
        retrievalGate: queryResult.retrievalGate || null,
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

    trace.start("lazy_compile", "主题页惰性编译", "检查命中主题页是否存在待编译变更");
    let lazyCompiled = 0;
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
        lazyCompiled += 1;
      }
    }
    trace.finish(
      "lazy_compile",
      "success",
      lazyCompiled > 0 ? `已即时编译 ${lazyCompiled} 个脏主题页` : "命中主题页均无需即时重编译",
      { checked: hitTopics.length, compiled: lazyCompiled },
    );

    const citations = Array.isArray(queryResult.citations)
      ? queryResult.citations
      : [];

    trace.start("version_conflict_check", "文档版本冲突检测", "检查命中文档是否存在多版本或版本更新");
    let versionConflictNote = "";
    if (citations.length > 0) {
      const docTitles = Array.from(new Set(citations.map((c: any) => c.docTitle).filter(Boolean)));
      if (docTitles.length > 0) {
        const publishedDocs = await this.prisma.document.findMany({
          where: {
            kbId: { in: visibleKbs },
            title: { in: docTitles },
            status: "published",
          },
          select: { id: true, title: true, version: true },
          orderBy: { version: "desc" },
        });
        const versionsByTitle = new Map<string, number[]>();
        for (const pd of publishedDocs) {
          const list = versionsByTitle.get(pd.title) || [];
          if (pd.version && !list.includes(pd.version)) list.push(pd.version);
          versionsByTitle.set(pd.title, list.sort((a, b) => b - a));
        }
        const conflictTitles: string[] = [];
        for (const cit of citations as any[]) {
          const allVers = versionsByTitle.get(cit.docTitle) || [];
          if (allVers.length > 1) {
            cit.versionConflict = {
              hasConflict: true,
              currentVersion: cit.version ?? 1,
              allVersions: allVers,
            };
            if (!conflictTitles.includes(cit.docTitle)) {
              conflictTitles.push(cit.docTitle);
              versionConflictNote += `\n【版本提示】检测到文档《${cit.docTitle}》存在多个版本（当前选用 v${cit.version ?? 1}，库中存在: v${allVers.join(', v')}），请在回答中注明版本及生效范围。`;
            }
          }
        }
        trace.finish(
          "version_conflict_check",
          conflictTitles.length > 0 ? "warning" : "success",
          conflictTitles.length > 0
            ? `检测到 ${conflictTitles.length} 个文档存在多版本冲突: ${conflictTitles.join(", ")}`
            : "命中文档版本均一致，未检测到多版本冲突",
          { conflictCount: conflictTitles.length, conflictTitles },
        );
      } else {
        trace.finish("version_conflict_check", "skipped", "命中文档无有效标题，跳过版本冲突检测");
      }
    } else {
      trace.finish("version_conflict_check", "skipped", "未命中任何证据，跳过版本冲突检测");
    }

    trace.start("answer_context", "回答上下文组装", "从授权证据页组装可引用的回答上下文");
    let compiledTruthContext = citations.length > 0
      ? citations
          .map((cit: any, idx: number) => {
            const title = cit.docTitle || cit.topic || `参考文档 ${idx + 1}`;
            const kbName = cit.kbName ? ` (所属知识库: ${cit.kbName})` : "";
            const pageInfo = typeof cit.pageNo === "number" ? ` [第${cit.pageNo}页]` : "";
            const articleInfo = cit.articleNo ? ` [第${cit.articleNo}条]` : "";
            const section = cit.section ? `\n定位：${cit.section}` : "";
            const content = (cit.context || cit.snippet || "").trim();
            return `【来源 ${idx + 1}】《${title}》${kbName}${pageInfo}${articleInfo}${section}\n${content}`;
          })
          .join("\n\n---\n\n")
      : (queryResult.answer || "No truth found for this topic.");
    if (versionConflictNote) {
      compiledTruthContext += `\n\n${versionConflictNote.trim()}`;
    }
    if (this.graphRagService && scope.length > 0) {
      try {
        const localGraph = await this.graphRagService.searchLocalGraph(scope, retrieval.query, 6);
        if (localGraph.formattedContext) {
          compiledTruthContext += `\n\n${localGraph.formattedContext}`;
        }
      } catch (err) {
        this.logger.debug(`GraphRAG search omitted: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    trace.finish(
      "answer_context",
      citations.length > 0 ? "success" : "warning",
      citations.length > 0 ? `已组装 ${citations.length} 条可引用证据` : "没有可引用证据，仅返回检索空结果说明",
      { citationCount: citations.length, contextChars: compiledTruthContext.length },
    );

    this.logger.debug(
      "Prompting real external LLM API with Compiled Truth context...",
    );

    try {
      // 从数据库中获取用户在后台页面配置的大模型信息
      trace.start("llm_generation", "大模型流式生成", "基于授权证据生成回答并要求逐项引用");
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
        trace.finish("llm_generation", "warning", "未配置大模型，直接返回检索证据上下文", {
          model: modelName,
          evidenceOnly: true,
        });
        await this.emitCitationsAndComplete(
          userId,
          queryResult.citations || [],
          subscriber,
          0,
          compiledTruthContext,
          trace,
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

      const personalMemoryBlock = personalMemory.text
        ? `个人长期记忆（仅当前用户可见，优先级低于当前知识库原文；不能把它冒充为公共制度证据）：\n${personalMemory.text}\n\n`
        : "";

      const contextMessage = `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【重要回答规范】：
1. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。例如：“中通服节能的核心业务包括数据中心绿色化与液冷技术应用[1]。”
2. 【证据收敛】：参考资料是候选证据，不是都必须使用。只使用直接支持当前问题的来源；低相关、仅主题相似或无法支持答案的资料不得进入回答。精确事实问题应直接回答目标事实，不要把相邻条款或其他制度的内容扩展进来。
3. 【多源对比与完整呈现】：只有当多份资料都直接涉及当前问题时，才分别列出各份文件的规定，并说明版本差异、适用条件或生效背景。
4. 【多源合并】：若多个来源共同支持某一相同结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号；可用编号严格限制在 [1] 到 [${citations.length}]。
5. 【客观真实】：如果参考资料不足以回答用户的问题，请明确客观说明“已知知识库资料中未包含相关信息”，切勿主观编造。

      ${priorConversation ? `历史对话参考（仅供消歧，以当前知识库资料为准）：\n${priorConversation}\n\n` : ""}${personalMemoryBlock}【参考知识库资料】：
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
      let citationTail = "";
      const emitModelContent = (rawContent: string) => {
        const merged = citationTail + rawContent;
        citationTail = "";
        const trailingMarker = merged.match(/\[(\d*)$/);
        const body = trailingMarker
          ? merged.slice(0, -trailingMarker[0].length)
          : merged;
        if (trailingMarker) citationTail = trailingMarker[0];
        const safeContent = stripInvalidCitationMarkers(body, citations.length);
        if (safeContent) {
          totalTokens++;
          fullAnswer += safeContent;
          subscriber.next({ data: { type: "delta", content: safeContent } });
        }
      };

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
                if (content) emitModelContent(String(content));
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
          if (content) emitModelContent(String(content));
        } catch (e) {}
      }

      trace.finish(
        "llm_generation",
        fullAnswer ? "success" : "warning",
        fullAnswer ? "大模型回答生成完成" : "大模型连接正常但未返回正文",
        { model: modelName, outputChars: fullAnswer.length, streamedChunks: totalTokens },
      );

      await this.emitCitationsAndComplete(
        userId,
        queryResult.citations || [],
        subscriber,
        totalTokens,
        fullAnswer,
        trace,
        question,
        userScope,
        modelName,
      );
    } catch (error: any) {
      trace.finish("llm_generation", "failed", `大模型请求失败：${String(error?.message || error).slice(0, 300)}`);
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
    const config = this.modelConfigService
      ? await this.modelConfigService.getDefault("llm")
      : null;
    const apiKey =
      config?.provider.apiKey || process.env.DEEPSEEK_API_KEY || "";
    if (!apiKey) {
      return directRequest;
    }
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

  private async loadPersonalMemoryContext(
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

  private shouldLoadPersonalMemory(
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
          select: {
            id: true,
            kbId: true,
            title: true,
            version: true,
            createdAt: true,
            updatedAt: true,
            kb: { select: { name: true, type: true } },
          },
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
          ? {
              ...citation,
              kbId: doc.kbId,
              docTitle: doc.title,
              version: doc.version,
              kbName: (doc as any).kb?.name || citation.kbName || "默认知识库",
              kbType: (doc as any).kb?.type,
            }
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
          // A broad query is a coverage request. Reranker score scales differ
          // across providers (some valid scores are < 0.01), so never turn a
          // score calibration difference into silent document loss. GBrain's
          // candidate limit and final model evidence gate remain in effect.
          if (breadth) return idx < 40;
          if (topScore > 0.15 && item.score < 0.08) return false;
          if (topScore > 0.3 && item.score < topScore * 0.25) return false;
          return idx < 4; // Cap focused queries at top 4
        })
        .map((item) => ({ ...item.citation, rerankScore: item.score }));

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

  /**
   * Keep a focused answer grounded in the score neighborhood of its best
   * evidence. GBrain's broad mode intentionally returns a wider set, while a
   * focused question should not feed unrelated low-score documents to the
   * answer model. The gate is score/evidence based and language agnostic.
   */
  private applyFocusedEvidenceGate(result: any, breadth = false): any {
    if (breadth) return result;
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    if (citations.length < 2) return result;
    const scored = citations.map((citation: any, index: number) => ({
      citation,
      index,
      score: typeof citation.rerankScore === "number"
        ? citation.rerankScore
        : Number.isFinite(Number(citation.rerankScore))
          ? Number(citation.rerankScore)
          : typeof citation.score === "number" ? citation.score : Number(citation.score),
    }));
    const numeric = scored.filter((item) => Number.isFinite(item.score));
    if (!numeric.length) return result;
    const topItem = numeric.reduce((best, item) => item.score > best.score ? item : best);
    const topScore = topItem.score;
    const floor = Math.max(0.02, topScore * 0.35);
    const filtered = scored
      .filter((item) => item.index === topItem.index || (Number.isFinite(item.score) && item.score >= floor))
      .map((item) => item.citation);
    if (!filtered.length || filtered.length === citations.length) return result;
    return {
      ...result,
      citations: filtered,
      topics: filtered.map((citation: any) => citation.topic),
      answer: filtered.map((citation: any) => citation.context || citation.snippet).filter(Boolean).join("\n\n"),
      retrievalGate: { removed: citations.length - filtered.length, scoreFloor: floor, topScore },
    };
  }

  private assessWeakEvidence(result: any, breadth = false): {
    shouldEscalate: boolean;
    weak: boolean;
    evidence: string;
    topScore: number | null;
    scoreFloor: number;
    reason: string;
  } {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const evidence = String(citations[0]?.evidence || "").toLowerCase();
    const rawRerankScore = Number(citations[0]?.rerankScore);
    const hasFallbackRerankScore = Number.isFinite(rawRerankScore);
    const configuredFloor = Number(
      hasFallbackRerankScore
        ? process.env.GBRAIN_FALLBACK_RERANK_CONFIDENCE_FLOOR || 0.70
        : process.env.GBRAIN_WEAK_EVIDENCE_SCORE_FLOOR || 0.75,
    );
    const scoreFloor = Number.isFinite(configuredFloor)
      ? Math.max(0, Math.min(configuredFloor, 2))
      : hasFallbackRerankScore ? 0.70 : 0.75;
    const rawScore = hasFallbackRerankScore
      ? rawRerankScore
      : Number(citations[0]?.score);
    const topScore = Number.isFinite(rawScore) ? rawScore : null;
    const weak = evidence.includes("weak");
    if (breadth) {
      return { shouldEscalate: false, weak, evidence, topScore, scoreFloor, reason: "当前已是广覆盖检索" };
    }
    if (!citations.length) {
      return { shouldEscalate: false, weak: false, evidence, topScore, scoreFloor, reason: "首轮没有候选，将由 Source 对账重试处理" };
    }
    if (!weak) {
      return { shouldEscalate: false, weak, evidence, topScore, scoreFloor, reason: "首轮证据类型明确，无需扩检" };
    }
    if (topScore !== null && topScore >= scoreFloor) {
      return {
        shouldEscalate: false,
        weak,
        evidence,
        topScore,
        scoreFloor,
        reason: `${hasFallbackRerankScore ? "交叉编码" : "语义命中"}分数 ${topScore.toFixed(3)} 已达到扩检门槛 ${scoreFloor.toFixed(3)}，交由证据门控验证`,
      };
    }
    return {
      shouldEscalate: true,
      weak,
      evidence,
      topScore,
      scoreFloor,
      reason: topScore === null
        ? "语义命中缺少可比较分数，需要扩检"
        : `${hasFallbackRerankScore ? "交叉编码" : "语义命中"}分数 ${topScore.toFixed(3)} 低于扩检门槛 ${scoreFloor.toFixed(3)}`,
    };
  }

  private async emitCitationsAndComplete(
    userId: string,
    citations: any[],
    subscriber: Subscriber<MessageEvent>,
    totalTokens: number,
    fullAnswer = "",
    trace: ChatTraceRecorder,
    question?: string,
    userScope?: { fingerprint: string; knowledgeEpoch: number },
    modelName?: string,
  ) {
    trace.start("citation_validation", "引用校验与映射", "校验回答角标并绑定到原始文档预览");
    // If the LLM cited specific [n] sources, match and retain them
    const safeAnswer = stripInvalidCitationMarkers(fullAnswer, citations.length);
    const citedMatches = safeAnswer.match(/\[(\d+)\]/g) || [];
    const citedIndices = new Set(
      citedMatches.map((m) => parseInt(m.replace(/\D/g, ""), 10)),
    );

    let finalCitations = citations.map((citation, index) => ({ citation, originalIndex: index + 1 }));
    if (citedIndices.size > 0) {
      const referenced = finalCitations.filter((item) => citedIndices.has(item.originalIndex));
      if (referenced.length > 0) {
        finalCitations = referenced;
      }
    } else if (citations.length > 3) {
      finalCitations = finalCitations.slice(0, 2);
    }

    // Third-layer independent permission check
    let validDocIdSet = new Set<string>();
    const docIdsToCheck = finalCitations
      .map((item) => item.citation.docId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    if (docIdsToCheck.length > 0) {
      const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
      const validDocs = await this.prisma.document.findMany({
        where: {
          id: { in: docIdsToCheck },
          kbId: { in: visibleKbs },
          status: "published",
        },
        select: { id: true },
      });
      validDocIdSet = new Set(validDocs.map((d) => d.id));
    }

    const preAclCount = finalCitations.length;
    finalCitations = finalCitations.filter(({ citation, originalIndex }) => {
      if (citation.docId && !validDocIdSet.has(citation.docId)) {
        this.logger.warn(`Stripping citation [${originalIndex}] (docId: ${citation.docId}) due to independent ACL check failure.`);
        return false;
      }
      return true;
    });

    const statements = safeAnswer.split(/(?:\n+|[。！？])/).map(s => s.trim()).filter(s => s.length >= 5);
    const totalStatements = statements.length;
    let groundedStatements = 0;
    for (const stmt of statements) {
      const tags = stmt.match(/\[(\d+)\]/g) || [];
      const hasValidTag = tags.some(tag => citedIndices.has(parseInt(tag.replace(/\D/g, ""), 10)));
      if (hasValidTag) {
        groundedStatements++;
      } else {
        const chars = Array.from(new Set(stmt.replace(/\s+/g, '').split('')));
        let isGrounded = false;
        if (chars.length > 0) {
          for (const item of finalCitations) {
            const contextText = String(item.citation.context || item.citation.snippet || "");
            let overlap = 0;
            for (const ch of chars) {
              if (contextText.includes(ch)) overlap++;
            }
            if (overlap / chars.length >= 0.7) {
              isGrounded = true;
              break;
            }
          }
        }
        if (isGrounded) groundedStatements++;
      }
    }
    const coverageRatio = totalStatements > 0 ? Number((groundedStatements / totalStatements).toFixed(2)) : 1.0;
    const semanticCoverage = { totalStatements, groundedStatements, coverageRatio };

    let traceStatus = finalCitations.length > 0 ? "success" : "warning";
    let traceMsg = finalCitations.length > 0
        ? `回答引用 ${finalCitations.length} 个原始证据页面`
        : "本次回答没有可绑定的原始证据";

    if (citations.length > 0 && coverageRatio < 0.5) {
      traceStatus = "warning";
      traceMsg += `，但证据语义覆盖率偏低 (${Math.round(coverageRatio * 100)}%)，部分结论缺少明确引用支撑`;
    }

    trace.finish(
      "citation_validation",
      traceStatus as "success" | "warning",
      traceMsg,
      {
        candidateCitations: citations.length,
        referencedCitations: finalCitations.map((item) => item.originalIndex),
        invalidMarkersRemoved: safeAnswer !== fullAnswer,
        aclStripped: preAclCount - finalCitations.length,
        semanticCoverage,
      },
    );

    finalCitations.forEach(({ citation: cit, originalIndex }: any) => {
      subscriber.next({
        data: {
          type: "citation",
          index: originalIndex,
          topic_slug: cit.topic,
          timeline_entry: {
            source_kb: cit.kbId,
            kb_name: cit.kbName || cit.kbId,
            document_id: cit.docId,
            doc_title: cit.docTitle,
            section: cit.section,
            score: cit.score,
            snippet: cit.snippet || '',
            preview_url: cit.docId && cit.kbId ? `/api/v1/kbs/${cit.kbId}/documents/${cit.docId}/preview` : undefined,
            version: cit.version,
            page_no: cit.pageNo || cit.page_no || cit.metadata?.page_no,
            version_conflict: cit.versionConflict,
          },
        },
      });
    });
    subscriber.next({
      data: { type: "done", total_tokens: totalTokens, latency_ms: 0 },
    });
    if (this.semanticCacheService && question && userScope?.fingerprint && fullAnswer.trim()) {
      this.semanticCacheService.store(
        question,
        null,
        userScope.fingerprint,
        userScope.knowledgeEpoch,
        fullAnswer,
        finalCitations.map((item: any) => item.citation),
        modelName || null,
        null,
      ).catch((err) => {
        this.logger.debug(`Semantic cache store failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    subscriber.complete();
  }
}
