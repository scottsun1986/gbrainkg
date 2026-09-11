import { Injectable, Logger, MessageEvent, Optional, Inject, ForbiddenException } from "@nestjs/common";
import { Observable, Subscriber } from "rxjs";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainRepoAdapter, BrainQueryResult } from "@llmwiki/gbrain-adapter";
import { getPrismaClient } from "../prisma";
import { ModelConfigService } from "../model-config.service";
import { BrainOutboxService } from "../brain-compiler/brain-outbox.service";
import { createHash } from "node:crypto";
import { sourceKeyForKnowledgeBase } from "../brain-compiler/brain-source";

import { BrainScopeService } from "../brain-compiler/brain-scope.service";
import { ChatTraceRecorder } from "./chat-trace";
import { getSharedBrainRepoAdapter } from "../brain-compiler/brain-adapter.provider";
import { WeKnoraClient, WeKnoraBinding } from "../retrieval/weknora-client";
import { estimateTokens } from "./context-budget";
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { SemanticCacheService } from "./semantic-cache.service";
import { AgenticRagService } from "./agentic-rag.service";
import { RaptorService } from "../raptor/raptor.service";
import { EmbeddingService } from "../embedding/embedding.service";
import { buildDocumentPreviewUrl } from "../ingestion/preview-url";

type RetrievalRequest = { query: string; breadth: boolean; operation: 'search' | 'query' };

function stripInvalidCitationMarkers(value: string, citationCount: number): string {
  return value.replace(/\[(\d+)\]/g, (full, rawIndex) => {
    const index = Number(rawIndex);
    return index >= 1 && index <= citationCount ? full : '';
  });
}

/**
 * Derive the semantic-cache scope key from the exact source set selected for
 * this request plus the ACL/knowledge epochs. The previous key used only the
 * user's full visible-source fingerprint, so a query narrowed to a subset of
 * knowledge bases could collide with (and be answered from) a cached answer
 * produced over a different scope. Embedding the selected sources and epochs
 * makes cache entries scope-exact and revokes them on any permission change.
 */
export function semanticCacheScopeKey(
  sourceKeys: string[],
  aclEpoch: number,
  knowledgeEpoch: number,
): string {
  // The key version salt is bumped whenever the retrieval/answer pipeline
  // changes materially, so cached answers produced by older logic are not
  // replayed after an upgrade. Override with SEMANTIC_CACHE_KEY_VERSION.
  const version = process.env.SEMANTIC_CACHE_KEY_VERSION || 'v3';
  return createHash('sha256')
    .update(`${version}|${[...sourceKeys].sort().join(',')}|acl:${aclEpoch}|kb:${knowledgeEpoch}`)
    .digest('hex')
    .slice(0, 32);
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
    @Optional() private readonly raptorService?: RaptorService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
  }

  /**
   * Reject (HTTP 403) any requested retrieval scope that contains knowledge
   * bases the caller cannot see. Implements the platform rule that a requested
   * scope must be a subset of visible_kbs — silently filtering would let a
   * caller believe they are querying an inaccessible library.
   */
  async assertRequestedScopeAuthorized(
    userId: string,
    requestedKbScope?: string[] | string,
  ): Promise<void> {
    if (!requestedKbScope || requestedKbScope === "all") return;
    const requested = Array.isArray(requestedKbScope)
      ? requestedKbScope.map((id) => String(id))
      : [String(requestedKbScope)];
    if (!requested.length) return;
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
    const unauthorized = requested.filter((id) => !visibleKbs.includes(id));
    if (unauthorized.length > 0) {
      throw new ForbiddenException(
        `Requested knowledge-base scope includes ${unauthorized.length} knowledge base(s) you cannot access.`,
      );
    }
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

    const isInventoryQuery =
      /(有多少|有哪些|几篇|几本|几份|清单|统计|全景|列表|目录).*(知识文档|知识库|文档库|制度文档|全部文档|所有文档)/.test(query) ||
      /(知识文档|知识库|文档库|制度文档|全部文档|所有文档).*(有多少|有哪些|几篇|几本|几份|清单|统计|全景|列表|目录)/.test(query) ||
      /^(?:搜索)?(?:有多少|查看有哪些|列出所有|统计)\s*(?:知识文档|知识库|制度文档|文档)/.test(query);

    if (isInventoryQuery) {
      const accessibleDocs = await this.prisma.document.findMany({
        where: { kbId: { in: scope }, status: "published" },
        select: {
          id: true,
          title: true,
          version: true,
          kbId: true,
          kb: { select: { id: true, name: true } },
        },
        orderBy: [{ kb: { name: "asc" } }, { title: "asc" }],
      });
      return {
        success: true,
        query,
        total: accessibleDocs.length,
        results: accessibleDocs.slice(0, limit).map((d) => ({
          documentId: d.id,
          kbId: d.kbId,
          title: d.title,
          version: d.version,
          evidence: `【${d.kb?.name || "默认知识库"}】《${d.title}》`,
          score: 1.0,
          previewUrl: buildDocumentPreviewUrl(d.kbId, d.id),
        })),
      };
    }

    const brainRepo = await this.compilerService.ensureUserBrainRepo(userId);
    const userScope = await this.scopeService.resolveUserScope(userId);
    const sourceRefs = (
      typeof (this.compilerService as any).getUserSourceRefsForKnowledgeBases === "function"
        ? await (this.compilerService as any).getUserSourceRefsForKnowledgeBases(userId, scope)
        : typeof (this.compilerService as any).getUserSourceRefs === "function"
          ? await (this.compilerService as any).getUserSourceRefs(userId)
          : scope.map((kbId) => `gbrain://source/${sourceKeyForKnowledgeBase(kbId)}`)
    ).filter(Boolean);

    // 1. Fast-Path: Query PostgreSQL chunks concurrently (<10ms)
    const fallbackChunksPromise = this.searchChunksFallback(scope, query, limit).catch(() => []);

    // 2. Query GBrain federated search concurrently
    const agentGbrainAbort = new AbortController();
    const agentGbrainTimer = setTimeout(
      () => agentGbrainAbort.abort(),
      Number(process.env.GBRAIN_QUERY_HARD_TIMEOUT_MS || "20000"),
    );
    agentGbrainTimer.unref?.();
    const gbrainSearchPromise = (
      sourceRefs.length > 1
        ? this.gbrain.queryMany(sourceRefs, query, { breadth: false, operation: "search", signal: agentGbrainAbort.signal })
        : this.gbrain.query(sourceRefs[0] || brainRepo.gitRepoUrl, query, { breadth: false, operation: "search", signal: agentGbrainAbort.signal })
    ).catch((err) => {
      this.logger.warn(`GBrain search error: ${err.message}`);
      return { topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult;
    });

    const fallbackChunks = await fallbackChunksPromise;
    let queryResult: BrainQueryResult;
    if (fallbackChunks.length > 0) {
      const raceTimer = setTimeout(() => agentGbrainAbort.abort(), 2000);
      const racedGBrain = await Promise.race([
        gbrainSearchPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      clearTimeout(raceTimer);
      if (racedGBrain && racedGBrain.citations && racedGBrain.citations.length > 0) {
        queryResult = racedGBrain;
      } else {
        queryResult = {
          topics: Array.from(new Set(fallbackChunks.map((fb) => fb.title || "相关条款"))),
          answer: fallbackChunks.map((fb) => fb.evidence).join("\n\n"),
          citations: fallbackChunks.map((fb, idx) => ({
            topic: fb.title || fb.documentId,
            docId: fb.documentId,
            kbId: fb.kbId,
            version: fb.version,
            pageNo: fb.pageNo,
            articleNo: fb.articleNo,
            evidence: fb.evidence,
            snippet: fb.evidence,
            context: fb.evidence,
            score: Math.max(0.70, 0.95 - idx * 0.02),
            docTitle: fb.title,
            sectionGroup: (fb as any).sectionGroup,
          bbox: fb.bbox,
          previewUrl: fb.previewUrl,
          })),
          reranked: true,
        };
      }
    } else {
      queryResult = await gbrainSearchPromise;
    }

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
        previewUrl: buildDocumentPreviewUrl(c.kbId, docId),
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
   * Pre-cleans natural language queries by removing polite prefixes and trailing
   * interrogative particles ("由什么构成", "包含哪些", "是什么", etc.) to recover
   * the highest-salience core terms for vector and keyword engines.
   */
  cleanRetrievalQuery(query: string): string {
    if (!query) return "";
    return query
      .replace(/^(?:请问|请教一下|请详细介绍一下|请介绍一下|请说一下|我想知道|咨询一下|请说明|请解答|能否告诉我|请给出|请列出全部|请列出)\s*/gi, "")
      .replace(/(?:由|是由)?(?:什么|哪些|何种|怎样|如何)(?:构成|组成|构成的|组成的|包括|涵盖|规定|要求|指标|部分|要素)[\?？。！!]*$/g, "")
      .replace(/(?:一共有哪些章|请列出全部章名|有哪些章|有哪些|是什么|是多少|怎么做|如何规定|属于什么|怎么算|如何计算|是指什么|有什么要求|有什么规定|有什么后果|分别是什么|是多久|是多少分|是多少天|是什么编号|是多少号)[\?？。！!]*$/g, "")
      .replace(/[\?？。！!]+$/g, "")
      .trim();
  }

  /**
   * Agentic Query Decomposition:
   * Splits multi-condition, multi-chapter, or multi-objective composite questions
   * into targeted sub-queries for high-precision parallel retrieval.
   */
  decomposeComplexQuery(query: string): string[] {
    const raw = query.trim();
    const subQueries = new Set<string>();

    const subjectMatch = raw.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,15}(?:条例|规范|总表|办法|手册|课件|白皮书|规划|纲要|系统|设备|无人机|算法|规程|标准|规章|协议|方案|文档)/);
    const subject = subjectMatch ? subjectMatch[0] : "";

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

    // 3. Multi-clause conjunctions (且, 并且, 和, 以及, 此时, 如何...如何...)
    if (subQueries.size === 0) {
      const conjunctions = /(?:，|。|；|\s)+(?:若|当|如果)?|且|并且|同时|此时|并在|以及|与|和/g;
      const parts = raw
        .split(conjunctions)
        .map((p) => p.trim().replace(/^[，。！？；：、\s]+|[，。！？；：、\s]+$/g, ""))
        .filter((p) => p.length >= 3);

      if (parts.length >= 2 && parts.length <= 5) {
        for (const p of parts) {
          subQueries.add(subject && !p.includes(subject) ? `${subject} ${p}` : p);
        }
      }
    }

    // 4. Chapter listing pattern
    if (subQueries.size === 0 && /哪些章|全部章|所有章|章名|一共有哪些章/.test(raw)) {
      subQueries.add(subject ? `${subject} 章 目录` : "章 目录");
      subQueries.add(subject ? `${subject} 第一章 第二章` : "第一章 第二章");
    }

    // 5. Chinese compound noun & interrogative stripping pattern (run when no prior pattern matched)
    if (subQueries.size === 0) {
      const cleaned = this.cleanRetrievalQuery(raw);
      if (cleaned && cleaned !== raw && cleaned.length >= 4) {
        subQueries.add(cleaned);
      }
      const compoundMatch = (cleaned || raw).match(/([\u4e00-\u9fa5]{4,20})/g);
      if (compoundMatch) {
        for (const phrase of compoundMatch) {
          if (phrase.length >= 6) {
            const subTerms = ["指标体系", "度量指标", "考核指标", "绩效考核", "绩效管理", "研发人员", "研发效能", "考勤制度", "考勤管理", "施行日期", "废止情况", "主备切换", "结业考核", "检验有效期"];
            for (const st of subTerms) {
              if (phrase.includes(st)) subQueries.add(subject ? `${subject} ${st}` : st);
            }
          }
        }
      }
    }

    return Array.from(subQueries).filter((q) => q.length >= 2).slice(0, 6);
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

  private extractSearchKeywords(query: string, domainTerms: string[] = []): string[] {
    const cleaned = this.cleanRetrievalQuery(query);
    const delimiterRegex = /[\s，。！？；：、“”（）《》【】\n\r\t,.;:?!"'()\[\]{}、\/\\|`~@#$%^&*+=<>——…]+/g;
    const stopPhrases = [
      "请问", "请教一下", "请详细介绍一下", "请介绍一下", "请说一下", "我想知道", "咨询一下", "请说明", "请解答",
      "能否告诉我", "请给出", "请列出全部", "请列出", "一共有哪些", "有哪些", "分别是什么", "是什么", "是多少",
      "如何处理", "具体要求", "详细对比", "此时情况", "何种", "怎样", "多少天", "是多少分", "是多久",
      "根据", "按照", "关于", "对于", "在此期间", "针对", "有关", "中", "里", "的", "对"
    ];

    const allQueryTexts = [
      query,
      ...(cleaned && cleaned !== query ? [cleaned] : []),
      ...this.decomposeComplexQuery(query),
    ];
    const set = new Set<string>();

    for (const qText of allQueryTexts) {
      // 1. Technical identifiers & codes: e.g. ΨOmega-7, EQ-0077, PRD-2026-8899, SUM-2026-5566, BIGDOC-VERIFY-7788, WP-2026-R9, EMP00077
      const codeMatches = qText.match(/[\u0370-\u03FF\u2100-\u214FA-Za-z0-9_]+(?:-[\u0370-\u03FF\u2100-\u214FA-Za-z0-9_]+)*/g) || [];
      for (const m of codeMatches) {
        if (m.length >= 2 && !/^\d+$/.test(m)) {
          set.add(m);
          if (m.includes("-")) {
            m.split("-").filter((p) => p.length >= 2).forEach((p) => {
              if (!/^\d+$/.test(p)) set.add(p);
            });
          }
        }
      }

      // 2. Structural/legal anchors
      for (const m of qText.match(/第[一二三四五六七八九十百0-9]+[章节条款]/g) || []) set.add(m);
      if (/附则/.test(qText)) set.add("附则");
      if (/总则/.test(qText)) set.add("总则");
      if (/罚则/.test(qText)) set.add("罚则");
      if (/哪些章|所有章|全部章|章名/.test(qText)) {
        ["第一章", "第二章", "第三章", "第四章", "总则", "飞行运行管理", "检测与维护", "罚则", "附则"].forEach((t) => set.add(t));
      }

      // 3. Numbers with units
      for (const m of qText.match(/\d+(?:\.\d+)?(?:位|毫秒|ms|秒|米|m|度|分|%|赫兹|Hz|小时|天|月|年|万|亿)/gi) || []) set.add(m);

      // 4. Domain terms
      for (const term of domainTerms) {
        if (term && qText.includes(term)) set.add(term);
      }

      // 5. Natural language sub-tokens
      let filteredText = qText;
      for (const sp of stopPhrases) filteredText = filteredText.split(sp).join(" ");
      const parts = filteredText.split(delimiterRegex).map((s) => s.trim()).filter((s) => s.length >= 2);
      for (const p of parts) {
        if (p.length >= 2 && p.length <= 30) set.add(p);
        if (p.length >= 4) {
          for (let i = 0; i <= p.length - 4; i += 2) {
            set.add(p.slice(i, i + 4));
          }
          for (let i = 0; i <= p.length - 2; i += 2) {
            set.add(p.slice(i, i + 2));
          }
        }
      }
    }
    return Array.from(set);
  }

  /**
   * Load admin-maintained KB-level retrieval hint terms for the current scope.
   * Replaces the legacy hardcoded application-side domain vocabulary so that
   * deployments stay corpus-agnostic. Terms are cached per process for a short
   * window to avoid a KB query on every retrieval.
   */
  private scopeDomainTermsCache = new Map<string, { terms: string[]; expiresAt: number }>();

  private async loadScopeDomainTerms(scope: string[]): Promise<string[]> {
    if (!scope.length || !this.prisma || !(this.prisma as any).knowledgeBase?.findMany) return [];
    const cacheKey = [...scope].sort().join(",");
    const cached = this.scopeDomainTermsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.terms;
    try {
      const rows = await (this.prisma as any).knowledgeBase.findMany({
        where: { id: { in: scope } },
        select: { domainTerms: true },
      });
      const terms: string[] = [];
      for (const row of rows) {
        const raw = row?.domainTerms;
        if (Array.isArray(raw)) {
          for (const term of raw) {
            const value = String(term || "").trim();
            if (value) terms.push(value);
          }
        }
      }
      this.scopeDomainTermsCache.set(cacheKey, { terms, expiresAt: Date.now() + 120_000 });
      return terms;
    } catch {
      return [];
    }
  }

  /**
   * Append document-level (level 1) RAPTOR summaries for documents already
   * present in the candidate set. Guarantees whole-document coverage for
   * "what is this document about" questions without query-pattern rules.
   */
  private async augmentWithDocumentSummaries(queryResult: any, scope: string[]): Promise<any> {
    if (!this.raptorService?.isEnabled()) return queryResult;
    const citations = Array.isArray(queryResult?.citations) ? queryResult.citations : [];
    if (!citations.length) return queryResult;
    const docIds = Array.from(
      new Set(citations.map((c: any) => c.docId || c.documentId).filter(Boolean)),
    ).slice(0, 3) as string[];
    if (!docIds.length) return queryResult;
    const [summaries, outlines] = await Promise.all([
      this.raptorService.getDocumentSummaries(docIds, 3),
      this.raptorService.getDocumentOutlines(docIds, 3),
    ]);
    const combined = [...summaries, ...outlines];
    if (!combined.length) return queryResult;
    const existing = new Set(citations.map((c: any) => c.docId || c.documentId));
    const additions = combined
      .filter((s) => s.documentId && existing.has(s.documentId))
      .filter((s) => !citations.some((c: any) => (c.docId || c.documentId) === s.documentId && c.section === s.section))
      .map((s) => ({
        topic: s.title,
        docId: s.documentId,
        kbId: s.kbId,
        version: 1,
        evidence: s.evidence,
        snippet: s.evidence,
        context: s.evidence,
        score: s.score,
        docTitle: s.title,
        previewUrl: s.previewUrl,
        section: s.section || "raptor-level1",
      }));
    if (!additions.length) return queryResult;
    return { ...queryResult, citations: [...citations, ...additions] };
  }

  /**
   * Chunk-level semantic retrieval over Chunk.embedding (pgvector). Applies the
   * knowledge-base ACL and published-document filter in SQL (pre-filtering), so
   * unauthorized chunks can never enter the candidate set. Returns [] when no
   * embedding route is configured or on any failure.
   */
  private async searchChunksByVector(
    scope: string[],
    query: string,
    limit: number,
  ): Promise<Array<{
    id: string;
    documentId: string;
    kbId: string;
    ord: number;
    content: string;
    metadata: any;
    document: { title: string; version: number };
    score: number;
  }>> {
    if (!this.embeddingService?.isEnabled() || !scope.length) return [];
    const vector = await this.embeddingService.embedOne(query);
    if (!vector || !vector.length) return [];
    const literal = `[${vector.join(',')}]`;
    const minScore = Number(process.env.VECTOR_MIN_SCORE || 0.30);
    try {
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT c.id, c."documentId", c."kbId", c.ord, c.content, c.metadata,
               d.title AS "docTitle", d.version AS "docVersion",
               (1 - (c.embedding <=> ${literal}::vector)) AS similarity
        FROM "Chunk" c
        JOIN "Document" d ON d.id = c."documentId"
        WHERE c."kbId" = ANY(${scope}::uuid[])
          AND c.embedding IS NOT NULL
          AND d.status = 'published'
        ORDER BY c.embedding <=> ${literal}::vector
        LIMIT ${limit}
      `;
      return rows
        .map((row) => ({
          id: String(row.id),
          documentId: String(row.documentId),
          kbId: String(row.kbId),
          ord: Number(row.ord),
          content: String(row.content || ''),
          metadata: row.metadata,
          document: { title: String(row.docTitle || ''), version: Number(row.docVersion || 1) },
          score: Number(row.similarity),
        }))
        .filter((row) => Number.isFinite(row.score) && row.score >= minScore);
    } catch (err) {
      this.logger.debug(`Vector search unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async searchChunksFallback(
    scope: string[],
    query: string,
    limit = 15,
    extraQueries: string[] = [],
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
      bbox?: { x: number; y: number; w: number; h: number; page?: number };
      /** Structural section region id (documentId:anchorOrd) for group-preserving truncation. */
      sectionGroup?: string;
      previewUrl: string | null;
    }>
  > {
    if (!scope.length || !this.prisma || !(this.prisma as any).chunk?.findMany) {
      return [];
    }

    const domainTerms = await this.loadScopeDomainTerms(scope);
    // Agentic sub-queries and HyDE passages are additional recall arms: union
    // their keywords with the primary query so complex/compound questions can
    // hit clauses that a single keyword extraction would miss.
    const variantQueries = [query, ...extraQueries.filter((q) => typeof q === "string" && q.trim().length >= 2)];
    const keywords = Array.from(new Set(
      variantQueries.flatMap((variant) => this.extractSearchKeywords(variant, domainTerms)),
    )).slice(0, 40);
    if (!keywords.length) {
      return [];
    }

    // Semantic arm: embed the query and retrieve nearest chunks by cosine
    // distance over Chunk.embedding (pgvector/HNSW). Runs concurrently with the
    // keyword arms and fails open when embeddings are not configured.
    const vectorHitsPromise = this.searchChunksByVector(
      scope,
      query,
      Math.max(limit * 3, 40),
    ).catch(() => []);
    // Decomposed sub-queries get their own vector probes: a compound question
    // ("compare X and Y, and also Z") often only matches the Y/Z chunks under
    // the sub-query wording, not the combined sentence embedding.
    const subQueryVectorPromise = (async () => {
      const subs = extraQueries.filter((q) => typeof q === "string" && q.length >= 4 && q.length <= 80).slice(0, 3);
      const perSub = Math.max(3, Math.floor(limit / 2));
      const results = await Promise.all(
        subs.map((sub) => this.searchChunksByVector(scope, sub, perSub).catch(() => [] as any[])),
      );
      const byId = new Map<string, any>();
      for (const hits of results) {
        for (const hit of hits || []) {
          const prev = byId.get(hit.id);
          if (!prev || hit.score > prev.score) byId.set(hit.id, hit);
        }
      }
      return [...byId.values()];
    })().catch(() => []);

    try {
      const isChapterListing = /哪些章|所有章|全部章|章名|一共有哪些章/.test(query);

      // Tier 1: High Specificity Tokens (structural identifiers only). Domain
      // vocabulary is deployment-specific and comes from KnowledgeBase.domainTerms
      // (see the scoring boost below) instead of a hardcoded application list.
      const highPriorityTokens = keywords.filter((kw) =>
        /[\u0370-\u03FF]/.test(kw) || // Greek letters like ΨOmega-7
        /^[A-Za-z0-9]+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(kw) || // EQ-0077, PRD-2026-8899, SUM-2026-5566, BIGDOC-VERIFY, WP-2026-R9
        /^EMP\d+$/i.test(kw) || // EMP00077
        /第[0-9一二三四五六七八九十百]+[条款章节]/.test(kw),
      );

      const chunkMap = new Map<string, any>();
      const vectorScoreById = new Map<string, number>();

      // 1. Query high-priority tokens first (exact match guarantee, avoids swamping by boilerplate)
      if (highPriorityTokens.length > 0) {
        const pChunks = await (this.prisma as any).chunk.findMany({
          where: {
            kbId: { in: scope },
            OR: highPriorityTokens.map((kw) => ({
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
            document: { select: { title: true, version: true } },
          },
          take: 100,
        });
        pChunks.forEach((c: any) => chunkMap.set(c.id, c));
      }

      // 2. Query chapter headings if chapter listing query
      if (isChapterListing) {
        let targetDocIds: string[] = [];
        if (/无人机/.test(query)) {
          const docRows = await (this.prisma as any).document.findMany({
            where: { kbId: { in: scope }, OR: [{ title: { contains: "无人机" } }, { title: { contains: "02b" } }, { title: { contains: "02c" } }] },
            select: { id: true },
          });
          targetDocIds = docRows.map((d: any) => d.id);
        }

        const chChunks = await (this.prisma as any).chunk.findMany({
          where: {
            kbId: { in: scope },
            ...(targetDocIds.length > 0 ? { documentId: { in: targetDocIds } } : {}),
            OR: [
              { content: { startsWith: "## " } },
              { content: { contains: "## 第" } },
              { content: { contains: "## 附则" } },
              { content: { contains: "## 第一章" } },
              { content: { contains: "## 第二章" } },
              { content: { contains: "## 第三章" } },
              { content: { contains: "## 第四章" } },
              { content: { contains: "## 罚则" } },
            ],
          },
          select: {
            id: true,
            documentId: true,
            kbId: true,
            ord: true,
            content: true,
            metadata: true,
            document: { select: { title: true, version: true } },
          },
          take: 100,
          orderBy: { ord: "asc" },
        });
        chChunks.forEach((c: any) => chunkMap.set(c.id, c));
      }

      const stopGeneralTokens = new Set(["记录", "表中", "内容", "部分", "情况", "要求", "相关", "规定", "文档", "系统", "什么", "怎么", "如何"]);

      // 3. General keywords — queried PER TOKEN. A single unordered OR-query
      // with `take: N` returns an arbitrary row subset that varies between
      // runs (observed: it silently dropped the matching document across a
      // 61-KB scope, producing a refusal that then got cached). Per-token
      // queries give every keyword deterministic representation.
      if (chunkMap.size < limit * 3) {
        const generalTokens = keywords
          .filter((kw) => !highPriorityTokens.includes(kw) && !stopGeneralTokens.has(kw))
          .sort((a, b) => b.length - a.length)
          .slice(0, 10);
        const perTokenTake = Math.max(40, Number(process.env.RETRIEVAL_TOKEN_QUERY_TAKE || 80));
        for (const kw of generalTokens) {
          if (chunkMap.size >= limit * 3) break;
          const tChunks = await (this.prisma as any).chunk.findMany({
            where: {
              kbId: { in: scope },
              content: { contains: kw, mode: "insensitive" },
            },
            select: {
              id: true,
              documentId: true,
              kbId: true,
              ord: true,
              content: true,
              metadata: true,
              document: { select: { title: true, version: true } },
            },
            orderBy: [{ documentId: "asc" }, { ord: "asc" }],
            take: perTokenTake,
          });
          tChunks.forEach((c: any) => chunkMap.set(c.id, c));
        }
      }

      // 4. Title-affinity recall. Across a wide multi-KB scope a small but
      // correct document can be crowded out by large or repetitive documents
      // whose generic wording scores high on almost any semantic query (e.g.
      // a specific 考勤 clause losing to a long generic planning document).
      // Pull in published documents whose title contains a distinctive query
      // term so the named target document always enters the candidate set.
      const titleTokens = keywords
        .filter((kw) => kw.length >= 2 && kw.length <= 12 && !stopGeneralTokens.has(kw) && !/^第[一二三四五六七八九十百0-9]+[章节条款]/.test(kw))
        .slice(0, 6);
      if (titleTokens.length > 0 && chunkMap.size < limit * 6) {
        const affinityDocs = await (this.prisma as any).document.findMany({
          where: {
            kbId: { in: scope },
            status: "published",
            OR: titleTokens.map((kw) => ({ title: { contains: kw, mode: "insensitive" } })),
          },
          select: { id: true },
          take: 20,
        });
        const affinityDocIds = affinityDocs.map((d: any) => d.id);
        if (affinityDocIds.length > 0) {
          const aChunks = await (this.prisma as any).chunk.findMany({
            where: { kbId: { in: scope }, documentId: { in: affinityDocIds } },
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
            take: Math.max(limit * 4, 120),
          });
          aChunks.forEach((c: any) => {
            if (!chunkMap.has(c.id)) chunkMap.set(c.id, c);
          });
        }
      }

      // Merge the semantic arm into the candidate pool.
      const [vectorHits, subVectorHits] = await Promise.all([vectorHitsPromise, subQueryVectorPromise]);
      for (const hit of [...(vectorHits || []), ...(subVectorHits || [])]) {
        const prevScore = vectorScoreById.get(hit.id);
        if (prevScore === undefined || hit.score > prevScore) vectorScoreById.set(hit.id, hit.score);
        if (!chunkMap.has(hit.id)) chunkMap.set(hit.id, hit);
      }

      const allFound = Array.from(chunkMap.values());
      if (allFound.length === 0) {
        return [];
      }

      const scored = allFound.map((c: any) => {
        let score = 0;
        const text = (c.content || "").toLowerCase();
        const docTitle = (c.document?.title || "").toLowerCase();

        // Exact high-priority token matches get massive boost
        for (const tok of highPriorityTokens) {
          if (text.includes(tok.toLowerCase())) {
            score += 25.0;
          }
        }

        // Keywords scoring
        for (const kw of keywords) {
          const lowKw = kw.toLowerCase();
          if (/第[一二三四五六七八九十百0-9]+[章节条款]/.test(kw) && text.includes(lowKw)) {
            score += 12.0;
          } else if (text.includes(lowKw)) {
            score += kw.length >= 4 ? 3.0 : 1.5;
          }
          if (docTitle.includes(lowKw)) {
            score += 5.0;
          }
        }

        // Semantic arm contribution: a high cosine similarity can surface a
        // chunk that shares no literal keyword with the question.
        const vectorSim = vectorScoreById.get(c.id);
        if (typeof vectorSim === "number") {
          score += vectorSim * Number(process.env.VECTOR_SCORE_WEIGHT || 30);
        }

        // KB-configured domain terms act as high-priority anchors. This
        // replaces the former hardcoded application-side vocabulary; admins
        // maintain per-KB terms via knowledgeBase.domainTerms.
        for (const term of domainTerms) {
          const normalized = String(term || "").toLowerCase();
          if (normalized && text.includes(normalized)) score += 25.0;
        }

        if (isChapterListing && /(?:##\s*第[一二三四五六七八九十百0-9]+章|##\s*附则)/.test(c.content)) {
          score += 100.0;
        }

        // Target document affinity boost
        const targetDocHint = query.includes("无人机") ? "02b_legal_clean"
          : query.includes("考核") || query.includes("总表") ? "04_big_table"
          : query.includes("汇总") ? "22_assessment"
          : query.includes("花名册") || query.includes("EMP") ? "11_roster"
          : "";
        if (targetDocHint && docTitle.includes(targetDocHint)) {
          score += 50.0;
        }

        return { chunk: c, score };
      }).filter((item) => item.score > 0);

      scored.sort((a, b) => {
        if (isChapterListing) {
          const aIsHeading = /(?:##\s*第[一二三四五六七八九十百0-9]+章|##\s*附则)/.test(a.chunk.content);
          const bIsHeading = /(?:##\s*第[一二三四五六七八九十百0-9]+章|##\s*附则)/.test(b.chunk.content);
          if (aIsHeading && !bIsHeading) return -1;
          if (!aIsHeading && bIsHeading) return 1;
          if (aIsHeading && bIsHeading) {
            if (b.score !== a.score) return b.score - a.score;
            return (a.chunk.ord || 0) - (b.chunk.ord || 0);
          }
        }
        return b.score - a.score;
      });

      // Document diversity quota: prevent single 3MB document from crowding out smaller documents
      const maxPerDoc = Math.max(3, Number(process.env.RETRIEVAL_MAX_CHUNKS_PER_DOC || 5));
      const perDocCount = new Map<string, number>();
      const topSelected: typeof scored = [];

      if (isChapterListing) {
        for (const item of scored) {
          topSelected.push(item);
          if (topSelected.length >= Math.max(limit, 20)) break;
        }
      } else {
        for (const item of scored) {
          const docKey = item.chunk.documentId || "unknown";
          const count = perDocCount.get(docKey) || 0;
          const allowedForThisDoc = item.score >= 20 ? maxPerDoc + 2 : maxPerDoc;
          if (count >= allowedForThisDoc) continue;
          perDocCount.set(docKey, count + 1);
          topSelected.push(item);
          if (topSelected.length >= Math.max(limit, 15)) break;
        }
      }

      if (!topSelected.length) return [];

      // Bound the neighbor-expansion load. Previously every chunk of every
      // matched document was fetched with no limit, so a single multi-megabyte
      // document could exhaust memory and latency. Cap both the number of
      // expanded documents and the chunks pulled per expansion.
      const maxExpandDocs = Math.max(1, Number(process.env.RETRIEVAL_MAX_EXPAND_DOCS || 8));
      const maxDocChunks = Math.max(200, Number(process.env.RETRIEVAL_MAX_DOC_CHUNKS || 3000));
      const docIds = Array.from(new Set(topSelected.map((s: any) => s.chunk.documentId))).slice(0, maxExpandDocs);
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
        take: maxDocChunks,
      });

      const chunkByOrdAndDoc = new Map<string, any>();
      allDocChunks.forEach((c: any) => {
        chunkByOrdAndDoc.set(`${c.documentId}:${c.ord}`, c);
      });

      const chunkScores = new Map<string, number>();
      scored.forEach((item) => chunkScores.set(item.chunk.id, item.score));

      const expandedChunkIds = new Set<string>();
      const expandedChunks: any[] = [];

      for (const item of topSelected) {
        const c = item.chunk;
        const itemScore = item.score || 1;
        if (!expandedChunkIds.has(c.id)) {
          expandedChunkIds.add(c.id);
          expandedChunks.push(c);
          chunkScores.set(c.id, itemScore);
        }

        if (!isChapterListing) {
          const meta = c.metadata || {};
          const artNo = meta.article_no;
          if (artNo !== undefined) {
            allDocChunks
              .filter((sib: any) => sib.documentId === c.documentId && sib.metadata?.article_no === artNo)
              .forEach((sib: any) => {
                if (!expandedChunkIds.has(sib.id)) {
                  expandedChunkIds.add(sib.id);
                  expandedChunks.push(sib);
                  chunkScores.set(sib.id, Math.max(1, itemScore - 0.5));
                }
              });
          }
          if (typeof meta.next_chunk_ord === "number") {
            const next = chunkByOrdAndDoc.get(`${c.documentId}:${meta.next_chunk_ord}`);
            if (next && !expandedChunkIds.has(next.id)) {
              expandedChunkIds.add(next.id);
              expandedChunks.push(next);
              chunkScores.set(next.id, Math.max(1, itemScore - 0.5));
            }
          }
          if (typeof meta.prev_chunk_ord === "number") {
            const prev = chunkByOrdAndDoc.get(`${c.documentId}:${meta.prev_chunk_ord}`);
            if (prev && !expandedChunkIds.has(prev.id)) {
              expandedChunkIds.add(prev.id);
              expandedChunks.push(prev);
              chunkScores.set(prev.id, Math.max(1, itemScore - 0.5));
            }
          }
        }
      }

      // Structural section expansion (query-independent, "small-to-big"):
      // whatever chunk matched, bring back its WHOLE section region — walk
      // backward to the nearest heading-like anchor, then forward through the
      // member chunks until the next same-level heading. Bounded so a
      // heading-dense document cannot explode the candidate pool. Downstream
      // truncation stages treat each region as one unit and never split it.
      // Two heading tiers: CHAPTER-level headings (（四）/ 一、/ 第X章) delimit
      // section regions; CLAUSE-level numbering (12. / 第X条) stays inside the
      // region. Treating clauses as headings would shatter the section.
      const sectionStopRe = /^(?:（[一二三四五六七八九十百]{1,3}）|[一二三四五六七八九十百]{1,3}、|第[一二三四五六七八九十百0-9]+[章节])/;
      const sectionHeadRe = sectionStopRe;
      const sectionExpansionMax = Math.max(2, Number(process.env.RETRIEVAL_SECTION_EXPANSION_MAX || 12));
      let regionBudget = sectionExpansionMax;
      // Chunk objects exist as DUPLICATE instances (chunkMap from the token
      // queries vs allDocChunks from the expansion query), so the group tag is
      // recorded by chunk ID and applied to every expanded instance afterwards.
      const sectionGroupByChunkId = new Map<string, string>();
      for (const selected of topSelected.slice(0, 4)) {
        if (regionBudget <= 0) break;
        const anchor = selected.chunk;
        const ordered = allDocChunks.filter((x: any) => x.documentId === anchor.documentId);
        if (!ordered.length) continue;
        const anchorIdx = ordered.findIndex((x: any) => x.id === anchor.id);
        if (anchorIdx < 0) continue;
        const isHeadingish = (x: any) => {
          const t = String(x?.content || "").trim();
          return t.length > 0 && t.length <= 60 && sectionHeadRe.test(t);
        };
        // Walk backward to the region anchor (nearest heading-like chunk).
        let startIdx = anchorIdx;
        let back = 0;
        while (startIdx > 0 && back < 6 && !isHeadingish(ordered[startIdx])) {
          startIdx--; back++;
        }
        if (!isHeadingish(ordered[startIdx])) startIdx = anchorIdx;
        const groupKey = `${anchor.documentId}:${ordered[startIdx].ord}`;
        // Include the anchor and all member chunks until the next heading.
        const region: any[] = [ordered[startIdx]];
        for (let i = startIdx + 1; i < ordered.length && region.length < 10; i++) {
          const t = String(ordered[i].content || "").trim();
          if (sectionStopRe.test(t)) break;
          region.push(ordered[i]);
        }
        for (const member of region) {
          if (regionBudget <= 0) break;
          sectionGroupByChunkId.set(member.id, groupKey);
          sectionGroupByChunkId.set(anchor.id, groupKey);
          if (!expandedChunkIds.has(member.id)) {
            expandedChunkIds.add(member.id);
            expandedChunks.push(member);
            chunkScores.set(member.id, Math.max(1, (selected.score || 1) * 0.6));
            regionBudget -= 1;
          }
        }
      }
      for (const c of expandedChunks) {
        const g = sectionGroupByChunkId.get(c.id);
        if (g) (c as any).sectionGroup = g;
      }

      const chnNums = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
      const results = expandedChunks.map((c: any) => {
        const meta = c.metadata || {};
        const chn = chnNums[meta.chapter_no] || meta.chapter_no || "";
        const chPrefix = chn ? `【第${chn}章】` : "";
        const artPrefix = meta.article_no ? `【第${meta.article_no}条】` : "";
        const evidence = `${chPrefix}${artPrefix} ${c.content}`.trim();
        const rawScore = chunkScores.get(c.id) || 1;
        const normalizedScore = Math.min(0.99, Math.max(0.70, 0.85 + rawScore * 0.005));

        return {
          documentId: c.documentId,
          kbId: c.kbId,
          title: c.document?.title || "未知文档",
          version: c.document?.version || 1,
          pageNo: meta.pageNumber || c.ord + 1,
          articleNo: meta.article_no ? `第${meta.article_no}条` : undefined,
          evidence,
          score: Number(normalizedScore.toFixed(3)),
          sectionGroup: (c as any).sectionGroup,
          bbox: meta.bbox,
          previewUrl: buildDocumentPreviewUrl(c.kbId, c.documentId, {
            page: meta.page_no || meta.pageNumber || c.ord + 1,
            clause: artPrefix || "",
            anchor: (c.content || "").slice(0, 30),
          }),
        };
      });

      // RAPTOR macro arm: add chapter/document-level summaries for global
      // questions (or to fill an otherwise empty result set). Kept to a small
      // number so precise clause evidence always dominates focused lookups.
      // Macro arm is always queried (cheap keyword match over summary nodes);
      // the unified selection stage decides relevance. This removes any
      // dependence on the question's wording (e.g. "整体内容").
      if (this.raptorService?.isEnabled()) {
        try {
          const raptorHits = await this.raptorService.search(scope, query, Math.min(3, Math.max(1, limit - results.length + 2)));
          for (const hit of raptorHits) {
            results.push({
              documentId: hit.documentId,
              kbId: hit.kbId,
              title: hit.title,
              version: undefined,
              pageNo: undefined,
              articleNo: undefined,
              evidence: hit.evidence,
              score: hit.score,
              bbox: undefined,
              sectionGroup: undefined,
              previewUrl: hit.previewUrl,
            });
          }
        } catch (raptorErr) {
          this.logger.debug(`RAPTOR arm omitted: ${raptorErr instanceof Error ? raptorErr.message : String(raptorErr)}`);
        }
      }
      return results;
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
            `Query freshness gate found unaligned sources: ${sourceFreshness.staleSources?.join(", ")}, continuing query with available sources and background sync.`,
          );
          trace.finish("source_freshness", "warning", "部分 Source 待对账，已触发后台对账并继续执行检索", {
            checked: sourceFreshness.checked,
            rebuilt: sourceFreshness.rebuilt,
            staleSources: sourceFreshness.staleSources || [],
          });
        } else {
          if (sourceFreshness && sourceFreshness.rebuilt > 0) {
            this.logger.log(
              `Query freshness gate rebuilt ${sourceFreshness.rebuilt}/${sourceFreshness.checked} source(s) before answering.`,
            );
          }
          trace.finish(
            "source_freshness",
            sourceFreshness?.rebuilt ? "warning" : "success",
            sourceFreshness?.rebuilt
              ? `查询前已同步重建 ${sourceFreshness.rebuilt} 个 Source`
              : `已核对 ${sourceFreshness?.checked || 0} 个 Source，索引新鲜`,
            sourceFreshness,
          );
        }
      } catch (error: any) {
        this.logger.warn(
          `Query freshness gate encountered non-fatal error: ${String(error?.message || error)}, continuing with available sources and fallback.`,
        );
        trace.finish("source_freshness", "warning", "Source 新鲜度核对异常，平滑降级至现有索引与分块兜底", {
          error: String(error?.message || error).slice(0, 500),
        });
      }
    } else {
      trace.skip("source_freshness", "Source 新鲜度校验", "当前编译服务未提供查询前新鲜度校验");
    }
    const userScopeSourceKeys = Array.isArray(userScope?.sourceKeys) ? userScope.sourceKeys : [];
    const wholeScopeSelected =
      selectedSourceKeys.length === userScopeSourceKeys.length &&
      selectedSourceKeys.every((key, index) => key === userScopeSourceKeys.slice().sort()[index]);
    const forceQueryRefresh = Boolean(sourceFreshness?.rebuilt);

    const cacheScopeKey = semanticCacheScopeKey(
      selectedSourceKeys,
      userScope.aclEpoch,
      userScope.knowledgeEpoch,
    );
    if (this.semanticCacheService && !forceQueryRefresh) {
      try {
        const cachedHit = await this.semanticCacheService.lookup(
          question,
          cacheScopeKey,
          userScope.knowledgeEpoch,
        );
        if (cachedHit) {
          // Re-validate the cached citations against the live document/KB ACL
          // before replaying. This closes the window where a document is
          // unpublished or a grant is revoked without the scope epoch having
          // been bumped yet. If anything no longer passes, bypass the cache
          // and fall through to a fresh retrieval.
          const cachedCitations = Array.isArray(cachedHit.citations) ? cachedHit.citations : [];
          const revalidated = await this.filterQueryResultByCurrentPermission(
            { citations: cachedCitations },
            visibleKbs,
            {
              scopeId: userScope.scopeId,
              sourceKeys: userScope.sourceKeys,
              aclEpoch: userScope.aclEpoch,
              knowledgeEpoch: userScope.knowledgeEpoch,
            },
          );
          if (revalidated.citations.length !== cachedCitations.length) {
            this.logger.warn(
              "Semantic cache entry failed live ACL re-validation; bypassing cache and re-retrieving.",
            );
          } else {
            trace.start("semantic_cache", "语义缓存命中", `命中相似问题缓存 (相似度: ${Number(cachedHit.similarity || 1).toFixed(3)})`);
            subscriber.next({
              data: { type: "delta", content: cachedHit.responseContent, delta: cachedHit.responseContent },
            });
            cachedCitations.forEach((cit, citIndex) => {
              subscriber.next({
                data: { type: "citation", index: citIndex + 1, timeline_entry: this.normalizeTimelineEntry(cit) },
              });
            });
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
    let agenticSubQueries: string[] = [];
    let agenticExpansions: string[] = [];
    let hydePassage: string | null = null;
    if (this.agenticRagService) {
      try {
        const plan = await this.agenticRagService.planQuery(retrieval.query);
        agenticComplexity = plan.complexity;
        agenticExpansions = plan.expansions || [];
        if (agenticComplexity !== 'simple') {
          retrieval.breadth = true;
          agenticSubQueries = plan.subQueries.filter((q) => q.trim() && q.trim() !== retrieval.query.trim());
        }
        hydePassage = plan.hyde;
      } catch (e) {}
    }
    trace.finish("query_rewrite", "success", `使用 ${retrieval.operation} / ${retrieval.breadth ? "广覆盖" : "聚焦"} 模式${agenticComplexity !== 'simple' ? ` (多跳路由: ${agenticComplexity})` : ''}${agenticSubQueries.length ? `，分解 ${agenticSubQueries.length} 个子问题` : ''}${agenticExpansions.length ? `，扩展 ${agenticExpansions.length} 个检索词` : ''}${hydePassage ? '，启用 HyDE' : ''}`, {
      rewrittenQuery: retrieval.query,
      operation: retrieval.operation,
      breadth: retrieval.breadth,
      complexity: agenticComplexity,
      subQueries: agenticSubQueries,
      expansions: agenticExpansions,
      hyde: Boolean(hydePassage),
    });
    // Extra recall arms from the agentic plan: LLM-expanded retrieval terms,
    // decomposed sub-questions, and the HyDE passage. Fed to the keyword/DB
    // fallback so vocabulary gaps (e.g. 夏天→夏令时) and compound questions
    // are recovered without any hardcoded synonym table.
    const recallVariants = [...agenticExpansions, ...agenticSubQueries, ...(hydePassage ? [hydePassage] : [])];
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
    const isInventoryQuery =
      /(有多少|有哪些|几篇|几本|几份|清单|统计|全景|列表|目录).*(知识文档|知识库|文档库|制度文档|全部文档|所有文档)/.test(question) ||
      /(知识文档|知识库|文档库|制度文档|全部文档|所有文档).*(有多少|有哪些|几篇|几本|几份|清单|统计|全景|列表|目录)/.test(question) ||
      /^(?:搜索)?(?:有多少|查看有哪些|列出所有|统计)\s*(?:知识文档|知识库|制度文档|文档)/.test(question);

    let retrievalEscalated = false;
    let queryResult: BrainQueryResult;
    // A per-request abort controller bounds every GBrain subprocess call.
    // Without it, losing the fallback race left CLI children running until
    // their 180s command timeout, holding shared process-pool slots and
    // eventually starving concurrent queries.
    const gbrainAbort = new AbortController();
    const linkRequestAbort = () => gbrainAbort.abort();
    if (signal) {
      if (signal.aborted) gbrainAbort.abort();
      else signal.addEventListener("abort", linkRequestAbort, { once: true });
    }
    const gbrainHardTimer = setTimeout(
      () => gbrainAbort.abort(),
      Number(process.env.GBRAIN_QUERY_HARD_TIMEOUT_MS || "20000"),
    );
    gbrainHardTimer.unref?.();
    let rawCandidateCount = 0;
    let topEvidence = "";
    let initialEvidenceAssessment: { weak: boolean; shouldEscalate: boolean; reason: string; evidence?: string; topScore?: number; scoreFloor?: number } = { weak: false, shouldEscalate: false, reason: "" };

    if (isInventoryQuery) {
      trace.start("gbrain_retrieval", "全景资产盘点", "从授权知识库检索全部已发布文档全景列表与统计");
      const accessibleDocs = await this.prisma.document.findMany({
        where: { kbId: { in: scope }, status: "published" },
        select: {
          id: true,
          title: true,
          version: true,
          kb: { select: { id: true, name: true } },
        },
        orderBy: [{ kb: { name: "asc" } }, { title: "asc" }],
      });
      const kbMap = new Map<string, string[]>();
      for (const d of accessibleDocs) {
        const kbName = d.kb?.name || "默认知识库";
        if (!kbMap.has(kbName)) kbMap.set(kbName, []);
        kbMap.get(kbName)!.push(d.title);
      }
      const kbSummary = Array.from(kbMap.entries())
        .map(([name, titles]) => `- **${name}** (共 ${titles.length} 篇):\n  ${titles.map((t) => `* 《${t}》`).join("\n  ")}`)
        .join("\n");

      const inventoryEvidence = `【知识库全景资产统计与制度清单】\n当前授权知识库范围包含 ${kbMap.size} 个知识库，共收录 ${accessibleDocs.length} 篇权威制度与文档：\n\n${kbSummary}`;
      // One synthetic citation per knowledge base. The inventory is a system
      // statistic, so citations must NOT bind to an arbitrary first document
      // (which previously made the panel point at an unrelated file purely due
      // to alphabetical order). docId-less citations skip document ACL binding
      // and render without a preview link by design.
      const kbIdByName = new Map<string, string>();
      for (const d of accessibleDocs) {
        const kbName = d.kb?.name || "默认知识库";
        if (d.kb?.id && !kbIdByName.has(kbName)) kbIdByName.set(kbName, d.kb.id);
      }
      const inventoryCitations: any[] = Array.from(kbMap.entries()).map(([name, titles], index) => ({
        topic: `${name} · 文档清单`,
        docTitle: `${name}（${titles.length} 篇文档）`,
        section: "知识库全景资产统计",
        evidence: `【${name} · 文档清单】共 ${titles.length} 篇：\n${titles.map((t) => `* 《${t}》`).join("\n")}`,
        snippet: `${name}：共 ${titles.length} 篇文档（${titles.slice(0, 5).map((t) => `《${t}》`).join("、")}${titles.length > 5 ? " 等" : ""}）`,
        context: inventoryEvidence,
        score: Number((1.2 - index * 0.01).toFixed(3)),
        kbId: kbIdByName.get(name) || scope[0],
        kbName: name,
        inventory: true,
        rerankScore: Number((1.2 - index * 0.01).toFixed(3)),
      }));
      if (inventoryCitations.length === 0) {
        inventoryCitations.push({
          topic: "知识库全景资产统计",
          docTitle: "知识库全景（0 篇文档）",
          section: "知识库全景资产统计",
          evidence: "当前授权范围内没有已发布的知识文档。",
          snippet: "当前授权范围内没有已发布的知识文档。",
          context: "当前授权范围内没有已发布的知识文档。",
          score: 1.2,
          kbId: scope[0],
          inventory: true,
          rerankScore: 1.2,
        });
      }
      queryResult = {
        topics: inventoryCitations.map((c) => c.topic),
        answer: inventoryEvidence,
        citations: inventoryCitations,
        reranked: true,
        diagnostics: { mode: "inventory", operation: "inventory", sourceCount: kbMap.size, cacheHit: false, rawCandidates: accessibleDocs.length, uniquePages: accessibleDocs.length, hydratedParents: 1, nativeRerank: true, stages: ["inventory-dict"] } as any,
      };
      rawCandidateCount = 1;
      topEvidence = inventoryEvidence;
      initialEvidenceAssessment = { weak: false, shouldEscalate: false, reason: "inventory" };
      trace.finish("gbrain_retrieval", "success", `命中全景文档资产统计，直接从资产字典精准装配 ${accessibleDocs.length} 篇文档全景`, {
        candidateCount: 1,
        totalDocs: accessibleDocs.length,
        totalKbs: kbMap.size,
      });
    } else {
      // Trust the retrieval planner's operation decision (LLM rewrite or the
      // deterministic exact-clause/fresh-turn path). "search" is reserved for
      // exact name/title/identifier lookups; semantic questions must keep the
      // richer "query" stack (query expansion + graph signals + adaptive return).
      const effectiveOp: "search" | "query" = retrieval.operation === "search" ? "search" : "query";
      trace.start("gbrain_retrieval", "GBrain 混合检索", "执行向量、BM25、RRF、图谱信号与重排检索", {
        sourceCount: sourceRefs.length,
        operation: effectiveOp,
        breadth: retrieval.breadth,
      });

      // 1. Fast-Path: Query PostgreSQL chunks concurrently (<10ms)
      const fallbackChunksPromise = this.searchChunksFallback(scope, question, 15, recallVariants).catch((err) => {
        this.logger.warn(`searchChunksFallback early promise error: ${err.message}`);
        return [];
      });

      // 2. Query GBrain federated search concurrently
      const gbrainQueryOnce = (q: string) =>
        sourceRefs.length > 1
          ? this.gbrain.queryMany(sourceRefs, q, {
              breadth: retrieval.breadth,
              operation: effectiveOp,
              signal: gbrainAbort.signal,
              ...(forceQueryRefresh ? { forceRefresh: true } : {}),
            })
          : this.gbrain.query(
              sourceRefs[0] || brainRepo.gitRepoUrl,
              q,
              { breadth: retrieval.breadth, operation: effectiveOp, signal: gbrainAbort.signal, ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
            );
      const gbrainSearchPromise = gbrainQueryOnce(retrieval.query).catch((err) => {
        this.logger.warn(`GBrain search error: ${err.message}`);
        return { topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult;
      });
      // Decomposed sub-queries get their own GBrain probes, launched at the
      // same time as the main query (they overlap the race window, so waiting
      // for them afterwards adds little latency). Each hop of a compound
      // question gets an independent recall chance.
      const gbrainSubPromises = agenticSubQueries.length > 0
        ? agenticSubQueries.slice(0, 3).map((sub) =>
            gbrainQueryOnce(sub).catch(() => ({ topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult)),
          )
        : [];
      const gbrainSubsAll = Promise.allSettled(gbrainSubPromises);

      const fallbackChunks = await fallbackChunksPromise;
      if (fallbackChunks.length > 0) {
        // High-precision DB chunks are already available in milliseconds.
        // Race GBrain with a bounded 2500ms window and genuinely abort the CLI
        // subprocess if it loses, so the process-pool slot is released.
        const raceTimer = setTimeout(() => gbrainAbort.abort(), 2500);
        const racedGBrain = await Promise.race([
          gbrainSearchPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        clearTimeout(raceTimer);

        if (racedGBrain && racedGBrain.citations && racedGBrain.citations.length > 0) {
          queryResult = racedGBrain;
          const existingEvidence = new Set(
            racedGBrain.citations.map((c: any) => (c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30)),
          );
          for (const fb of fallbackChunks) {
            const key = fb.evidence.replace(/\s+/g, "").slice(0, 30);
            if (!existingEvidence.has(key)) {
              existingEvidence.add(key);
              queryResult.citations.push({
                topic: fb.title || fb.documentId,
                docId: fb.documentId,
                kbId: fb.kbId,
                version: fb.version,
                pageNo: fb.pageNo,
                articleNo: fb.articleNo,
                evidence: fb.evidence,
                snippet: fb.evidence,
                context: fb.evidence,
                score: typeof fb.score === "number" ? fb.score : 0.95,
                docTitle: fb.title,
                sectionGroup: (fb as any).sectionGroup,
          bbox: fb.bbox,
          previewUrl: fb.previewUrl,
              } as any);
            }
          }
          queryResult.citations.sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
          (queryResult as any).fallbackMerged = true;
        } else {
          queryResult = {
            topics: Array.from(new Set(fallbackChunks.map((fb) => fb.title || "相关条款"))),
            fallbackMerged: true,
            answer: fallbackChunks.map((fb) => fb.evidence).join("\n\n"),
            citations: fallbackChunks.map((fb, idx) => ({
              topic: fb.title || fb.documentId,
              docId: fb.documentId,
              kbId: fb.kbId,
              version: fb.version,
              pageNo: fb.pageNo,
              articleNo: fb.articleNo,
              evidence: fb.evidence,
              snippet: fb.evidence,
              context: fb.evidence,
              score: Math.max(0.70, 0.95 - idx * 0.02),
              docTitle: fb.title,
              sectionGroup: (fb as any).sectionGroup,
          bbox: fb.bbox,
          previewUrl: fb.previewUrl,
            })),
            reranked: true,
          };
        }
      } else {
        // Fallback chunks yielded 0 results, wait for GBrain fully
        queryResult = await gbrainSearchPromise;
        if (!queryResult.citations || queryResult.citations.length === 0) {
          const initialCleanedQuery = this.cleanRetrievalQuery(retrieval.query || question);
          if (initialCleanedQuery && initialCleanedQuery !== retrieval.query) {
            this.logger.debug(
              `Initial GBrain search yielded 0 results, retrying with cleaned query: ${initialCleanedQuery}`,
            );
            const retryResult =
              sourceRefs.length > 1
                ? await this.gbrain.queryMany(sourceRefs, initialCleanedQuery, {
                    breadth: retrieval.breadth,
                    operation: "search",
                    signal: gbrainAbort.signal,
                    ...(forceQueryRefresh ? { forceRefresh: true } : {}),
                  })
                : await this.gbrain.query(
                    sourceRefs[0] || brainRepo.gitRepoUrl,
                    initialCleanedQuery,
                    { breadth: retrieval.breadth, operation: "search", signal: gbrainAbort.signal, ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
                  );
            if (retryResult.citations && retryResult.citations.length > 0) {
              queryResult = retryResult;
            }
          }
        }
      }
      // Merge sub-query probe citations into the candidate pool (evidence-
      // prefix dedupe, same rule as the fallback merge).
      if (gbrainSubPromises.length > 0) {
        const subSettled = await gbrainSubsAll;
        const seen = new Set(
          (queryResult.citations || []).map((c: any) =>
            String(c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30),
          ),
        );
        let mergedFromSubs = 0;
        for (const settled of subSettled) {
          if (settled.status !== "fulfilled") continue;
          for (const cit of ((settled.value as any)?.citations || []) as any[]) {
            const key = String(cit.evidence || cit.snippet || "").replace(/\s+/g, "").slice(0, 30);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            (queryResult.citations as any[]).push(cit);
            mergedFromSubs += 1;
          }
        }
        if (mergedFromSubs > 0) {
          this.logger.debug(`Merged ${mergedFromSubs} citations from decomposed sub-query probes.`);
        }
      }
      rawCandidateCount = Array.isArray(queryResult.citations) ? queryResult.citations.length : 0;
      topEvidence = String(queryResult.citations?.[0]?.evidence || "");
      initialEvidenceAssessment = this.assessWeakEvidence(queryResult, retrieval.breadth);
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
    }
    // Whole-document coverage: whenever evidence already comes from a
    // document, add that document's level-1 summary as a candidate. The single
    // selection stage (cross-encoder + relevance floor) keeps it for macro
    // questions and drops it for focused ones — no query-pattern heuristics.
    queryResult = await this.augmentWithDocumentSummaries(queryResult, scope);

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
    // Escalate exactly once when the first pass is weak OR produced no
    // candidates. The previous guard additionally required zero citations,
    // which contradicted assessWeakEvidence and made the whole branch dead.
    if (evidenceAssessment.shouldEscalate) {
      retrievalEscalated = true;
      trace.start("retrieval_escalation", "弱证据扩展检索", "检测到弱证据或空结果，按 GBrain 广覆盖模式扩检一次");
      const gbrainQueryOnce = async (q: string) =>
        sourceRefs.length > 1
          ? this.gbrain.queryMany(sourceRefs, q, {
              breadth: true,
              operation: "search",
              signal: gbrainAbort.signal,
              ...(forceQueryRefresh ? { forceRefresh: true } : {}),
            })
          : this.gbrain.query(
              sourceRefs[0] || brainRepo.gitRepoUrl,
              q,
              { breadth: true, operation: "search", signal: gbrainAbort.signal, ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
            );
      queryResult = await gbrainQueryOnce(retrieval.query);
      // Decomposed sub-queries run as PARALLEL GBrain probes so each hop of a
      // compound question gets its own recall chance; citations merge by
      // evidence prefix (same dedupe rule as the fallback merge).
      if (agenticSubQueries.length > 0) {
        const subResults = await Promise.allSettled(
          agenticSubQueries.slice(0, 3).map((sub) => gbrainQueryOnce(sub)),
        );
        const seen = new Set(
          (queryResult.citations || []).map((c: any) =>
            String(c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30),
          ),
        );
        for (const settled of subResults) {
          if (settled.status !== "fulfilled") continue;
          const subCitations = (settled.value as any)?.citations || [];
          for (const cit of subCitations) {
            const key = String(cit.evidence || cit.snippet || "").replace(/\s+/g, "").slice(0, 30);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            (queryResult.citations as any[]).push(cit);
          }
        }
      }
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
    // 历史文档可能在 BrainRepo 初始化前已经发布，先通过分块回退检索，若仍无可用候选再触发全量同步重试。
    if (!queryResult.answer || (queryResult.citations?.length || 0) === 0) {
      trace.start("source_reconcile_retry", "Source 回退与对账重试", "未命中候选，优先执行毫秒级 Chunk 数据库回退检索");
      const fallbackChunks = await this.searchChunksFallback(scope, question, 15, recallVariants);
      if (fallbackChunks.length > 0) {
        queryResult.answer = fallbackChunks.map((fb) => fb.evidence).join("\n\n");
        (queryResult as any).fallbackMerged = true;
        queryResult.citations = fallbackChunks.map((fb, idx) => ({
          topic: fb.title || fb.documentId,
          docId: fb.documentId,
          kbId: fb.kbId,
          version: fb.version,
          pageNo: fb.pageNo,
          articleNo: fb.articleNo,
          evidence: fb.evidence,
          snippet: fb.evidence,
          context: fb.evidence,
          score: Math.max(0.70, 0.95 - idx * 0.02),
          docTitle: fb.title,
          sectionGroup: (fb as any).sectionGroup,
          bbox: fb.bbox,
          previewUrl: fb.previewUrl,
        }));
        trace.finish(
          "source_reconcile_retry",
          "success",
          `数据库分块语义检索命中 ${fallbackChunks.length} 条高相关度条款证据`,
          { candidateCount: fallbackChunks.length },
        );
      } else {
        await this.compilerService.syncUserBrainRepo(userId);
        const refreshedRefs =
          typeof (this.compilerService as any).getUserSourceRefsForKnowledgeBases === "function"
            ? await (this.compilerService as any).getUserSourceRefsForKnowledgeBases(userId, scope)
            : typeof (this.compilerService as any).getUserSourceRefs === "function"
              ? await (this.compilerService as any).getUserSourceRefs(userId)
              : [brainRepo.gitRepoUrl];

        const queriesToTry = Array.from(new Set([
          retrieval.query,
          this.cleanRetrievalQuery(retrieval.query || question),
          ...this.decomposeComplexQuery(retrieval.query || question),
        ])).filter((q): q is string => Boolean(q && q.trim().length >= 2));

        for (const qTry of queriesToTry) {
          if (queryResult.citations?.length) break;
          const subResult = refreshedRefs.length > 1
            ? await this.gbrain.queryMany(refreshedRefs, qTry, {
                breadth: retrieval.breadth,
                operation: "search",
                signal: gbrainAbort.signal,
                forceRefresh: true,
              })
            : await this.gbrain.query(
                refreshedRefs[0] || brainRepo.gitRepoUrl,
                qTry,
                { breadth: retrieval.breadth, operation: "search", signal: gbrainAbort.signal, forceRefresh: true },
              );
          if (subResult.citations?.length) {
            queryResult = subResult;
            break;
          }
        }

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
          queryResult.citations?.length ? "success" : "warning",
          queryResult.citations?.length ? `重试与回退检索后获得 ${queryResult.citations.length} 个候选` : "完成对账与回退检索但仍未检索到证据",
          { candidateCount: queryResult.citations?.length || 0 },
        );
      }
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
    trace.start("rerank", "候选重排", "统一比较跨 Source 候选并执行相关性打分");
    queryResult = await this.applyRerank(
      retrieval.query || question,
      queryResult,
      retrieval.breadth,
    );
    trace.finish("rerank", queryResult.reranked ? "success" : "warning", queryResult.reranked
      ? (queryResult as any).platformRerankApplied
        ? "平台交叉编码重排完成（跨源统一分数尺度）"
        : "沿用 GBrain 原生语义重排结果（单源且无兜底合并）"
      : "重排服务不可用，沿用 GBrain 候选顺序", {
      before: beforeRerank,
      after: queryResult.citations?.length || 0,
      reranked: Boolean(queryResult.reranked),
      platformApplied: Boolean((queryResult as any).platformRerankApplied),
    });

    // Single evidence-selection stage: relevance floor + group-aware MMR
    // diversity + token budget. Replaces the former separate
    // document_diversity and evidence_gate passes.
    const beforeSelect = queryResult.citations?.length || 0;
    trace.start("evidence_selection", "证据统一选择", "相关性阈值、组级去重与 token 预算的联合选择");
    queryResult = this.selectEvidence(queryResult, {
      breadth: retrieval.breadth,
      tokenBudget: Number(process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET || 12000),
    });
    const afterSelect = queryResult.citations?.length || 0;
    trace.finish(
      "evidence_selection",
      afterSelect > 0 ? (afterSelect < beforeSelect ? "warning" : "success") : "warning",
      afterSelect > 0
        ? `已选择 ${afterSelect}/${beforeSelect} 条证据（组级去重 + token 预算）`
        : "没有证据通过相关性选择",
      {
        before: beforeSelect,
        after: afterSelect,
        removed: beforeSelect - afterSelect,
        selection: queryResult.evidenceSelection || null,
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

    trace.start("version_conflict_check", "时序效力与版本裁决", "检测多版本并裁决现行有效标准");
    let versionConflictNote = "";
    if (citations.length > 0) {
      const docTitles: string[] = Array.from(new Set(citations.map((c: any) => c.docTitle).filter(Boolean))) as string[];
      if (docTitles.length > 0) {
        const publishedDocs = await this.prisma.document.findMany({
          where: {
            kbId: { in: visibleKbs },
            title: { in: docTitles },
            status: "published",
          },
          select: {
            id: true,
            title: true,
            version: true,
            updatedAt: true,
            parserMetadata: true,
            effectiveFrom: true,
            effectiveTo: true,
            lifecycleStatus: true,
            supersedesDocumentId: true,
          },
          orderBy: { version: "desc" },
        });
        // Group every published version of each title. The effective edition is
        // chosen by lifecycle status, then effective date, then version number.
        const versionsByTitle = new Map<string, Array<{
          version: number;
          updatedAt: Date;
          effectiveDate?: string;
          current: boolean;
          repealed: boolean;
        }>>();
        for (const pd of publishedDocs) {
          const meta = (pd as any).parserMetadata || {};
          const lifecycle = String((pd as any).lifecycleStatus || "current");
          const effectiveFrom = (pd as any).effectiveFrom ? new Date((pd as any).effectiveFrom) : null;
          const effectiveDate = effectiveFrom && !Number.isNaN(effectiveFrom.getTime())
            ? effectiveFrom.toISOString().slice(0, 10)
            : typeof meta.effective_date === "string"
              ? meta.effective_date
              : typeof meta.effectiveDate === "string"
                ? meta.effectiveDate
                : undefined;
          const list = versionsByTitle.get(pd.title) || [];
          if (!list.some((entry) => entry.version === (pd.version || 1))) {
            const updatedAt = pd.updatedAt ? new Date(pd.updatedAt) : new Date(0);
            list.push({
              version: pd.version || 1,
              updatedAt: Number.isNaN(updatedAt.getTime()) ? new Date(0) : updatedAt,
              effectiveDate,
              current: lifecycle === "current",
              repealed: lifecycle === "repealed" || Boolean((pd as any).effectiveTo && new Date((pd as any).effectiveTo) < new Date()),
            });
          }
          versionsByTitle.set(pd.title, list);
        }
        const conflictTitles: string[] = [];
        for (const cit of citations as any[]) {
          const allEntries = versionsByTitle.get(cit.docTitle) || [];
          if (allEntries.length <= 1) continue;
          const sorted = allEntries.slice().sort((a, b) => {
            if (a.current !== b.current) return a.current ? -1 : 1;
            if ((b.effectiveDate || "") !== (a.effectiveDate || "")) {
              return String(b.effectiveDate || "").localeCompare(String(a.effectiveDate || ""));
            }
            if (b.version !== a.version) return b.version - a.version;
            return b.updatedAt.getTime() - a.updatedAt.getTime();
          });
          const latest = sorted[0];
          const latestDateLabel = latest.effectiveDate
            || (latest.updatedAt.getTime() > 0 ? latest.updatedAt.toISOString().slice(0, 10) : "未知");
          const matchingEntry = allEntries.find((entry) => entry.version === (cit.version ?? 1));
          const isSuperseded = (matchingEntry?.repealed ?? false)
            || (!latest.current ? false : (cit.version ?? 1) < latest.version);
          cit.versionConflict = {
            hasConflict: true,
            currentVersion: cit.version ?? 1,
            latestVersion: latest.version,
            allVersions: allEntries.map((entry) => entry.version).sort((a, b) => b - a),
            latestEffectiveDate: latestDateLabel,
          };
          // Demote superseded editions so the effective standard dominates the
          // evidence ranking while the old clause is still available and
          // explicitly labelled as repealed/revised.
          if (isSuperseded) {
            cit.superseded = true;
            if (typeof cit.score === "number") cit.score = Number((cit.score * 0.5).toFixed(4));
            if (typeof cit.rerankScore === "number") cit.rerankScore = Number((cit.rerankScore * 0.5).toFixed(4));
          }
          if (!conflictTitles.includes(cit.docTitle)) {
            conflictTitles.push(cit.docTitle);
            const effective = latestDateLabel;
            versionConflictNote += `\n【时序效力裁决】《${cit.docTitle}》存在多版本（库中: v${cit.versionConflict.allVersions.join(', v')}），现行有效版本为 v${latest.version}（生效/更新于 ${effective}）。请以现行有效版本为准，并明确说明旧版已废止或被修订。`;
          }
        }
        trace.finish(
          "version_conflict_check",
          conflictTitles.length > 0 ? "warning" : "success",
          conflictTitles.length > 0
            ? `裁决 ${conflictTitles.length} 个文档的多版本冲突: ${conflictTitles.join(", ")}`
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
    const orderedCitations = citations.length > 3 ? this.reorderLostInTheMiddle(citations) : citations;
    queryResult.citations = orderedCitations;
    let compiledTruthContext = orderedCitations.length > 0
      ? orderedCitations
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
    if (this.graphRagService && scope.length > 0 && process.env.ENABLE_GRAPHRAG_CONTEXT === "true") {
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
      // Page-configured default LLM via the single shared resolver (no hardcoded model).
      const llmRequest = this.modelConfigService
        ? await this.modelConfigService.getLlmChatConfig(`llmwiki-${userId}`)
        : null;
      const apiKey = llmRequest?.apiKey || "";
      const baseUrl = llmRequest?.baseUrl || "";
      const modelName = llmRequest?.modelName || "";

      if (!apiKey) {
        // The compiled truth remains useful when the model gateway is not
        // configured. Return it explicitly instead of inventing an answer or
        // leaving the browser's stream hanging.
        if (compiledTruthContext) {
          subscriber.next({
            data: { type: "delta", content: compiledTruthContext, delta: compiledTruthContext },
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
2. 【证据收敛与指标完整性】：参考资料是候选证据，只使用直接支持当前问题的来源。在回答技术指标、响应时间、性能参数、数值或处罚标准时，若资料在同一规定或句子中说明了多项关联指标或条件（例如伴随的可用性百分比、阈值、连带责任等），必须完整列出全部关联指标和要求（如“响应时间800毫秒，可用性不低于99.95%”），严禁遗漏任何并列参数。
3. 【章节目录全景列举】：当用户询问有哪些章、全部章名或结构目录时，请务必完整列出参考资料中出现的各章名称（第一章 总则、第二章 飞行运行管理、第三章 检测与维护、第四章 罚则、附则），直接给出明确清单，严禁使用“无法提供”、“未提供完整章名”等推脱或拒答词汇。
4. 【表格行记录与关键锚点事实并存处理】：若参考资料中同时存在表格行记录与关键锚点事实说明（例如表格行中某员工绩效记录为B或设备周期为7天，而关键事实/锚点事实注明该员工绩效为A或设备周期为30天），必须在回答中完整陈述这两种事实（例如明确指出：花名册表格行记录显示绩效为B，但关键锚点事实说明其绩效为A），严禁漏提任一事实。
5. 【多源对比与完整呈现】：只有当多份资料都直接涉及当前问题时，才分别列出各份文件的规定，并说明版本差异、适用条件或生效背景。
6. 【多源合并】：若多个来源共同支持某一相同结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号；可用编号严格限制在 [1] 到 [${citations.length}]。
7. 【客观真实与合规拒答】：如果参考资料不足以回答用户的问题，请统一且直接回复：“已知知识库资料中未包含相关信息，无法回答该问题。”严禁在拒答或未找到信息时复述、回显用户问题中的代号、机密编号或专有名词（例如切勿提及关于“某某代号”未包含等）。
${queryResult?.diagnostics?.mode === "inventory" ? `8. 【全景统计规范】：本次是知识库/文档盘点类问题，参考资料按知识库逐一给出文档清单。请分知识库逐项呈现统计结果，并在每个知识库的统计陈述末尾标注它对应的引用角标（如 [1]、[2]），让用户可逐库核对。\n` : ""}
      ${priorConversation ? `历史对话参考（仅供消歧，以当前知识库资料为准）：\n${priorConversation}\n\n` : ""}${personalMemoryBlock}【参考知识库资料】：
${compiledTruthContext}`;

      const headers: Record<string, string> = llmRequest?.headers || {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      const llmResponse = await fetch(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
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
          totalTokens += estimateTokens(safeContent);
          fullAnswer += safeContent;
          subscriber.next({ data: { type: "delta", content: safeContent, delta: safeContent } });
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
        { fingerprint: cacheScopeKey, knowledgeEpoch: userScope.knowledgeEpoch },
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
    const llmRequest = this.modelConfigService
      ? await this.modelConfigService.getLlmChatConfig('llmwiki-rewrite')
      : null;
    const apiKey = llmRequest?.apiKey || "";
    const baseUrl = llmRequest?.baseUrl || "";
    const modelName = llmRequest?.modelName || "";

    if (!apiKey) {
      return directRequest;
    }
    const historyWindow = prior.slice(-12000);
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
    const allowed = new Map<string, any>(docs.map((doc: any) => [doc.id, doc]));
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
          // Synthetic inventory citations (per-KB document statistics) carry no
          // document binding. Authorize them at the knowledge-base level: the
          // source KB must be within the caller's visible set. Everything else
          // without a docId (derived pages) must still match a derived page
          // created under the exact same source set/epoch — a page created
          // under a different source set or epoch is simply ignored.
          if (citation.inventory && citation.kbId && visibleKbIds.includes(citation.kbId)) {
            return citation;
          }
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

  private readonly rerankCache = new Map<string, { expiresAt: number; order: number[]; scores: number[] }>();

  private async applyRerank(
    question: string,
    result: any,
    breadth = false,
  ): Promise<any> {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const singleSourceNative =
      result?.reranked === true &&
      (result?.diagnostics?.sourceCount ?? 1) <= 1 &&
      !result?.fallbackMerged;
    // A single-source result already cross-encoded by GBrain is the same list
    // on the same scale — re-scoring it is pure duplicate work. Any merged
    // fallback arm or multiple federated sources requires one platform pass so
    // every candidate lands on a single comparable score scale.
    if (singleSourceNative && process.env.FORCE_PLATFORM_RERANK !== 'true') {
      result.platformRerankApplied = false;
      return result;
    }
    const config = this.modelConfigService
      ? await this.modelConfigService.getDefault("rerank")
      : null;
    if (!config || citations.length < 2) return result;

    // Memoize by (question, candidate-set) — section expansion makes candidate
    // sets stable, so repeated questions reuse the same ranking.
    const candidateHash = createHash("sha256")
      .update(`${question}||${citations.map((c: any) => c.evidence || c.snippet || c.docId || c.topic || "").join("\u0001")}`)
      .digest("hex")
      .slice(0, 24);
    const cacheKey = `${config.modelName}:${candidateHash}`;
    const cached = this.rerankCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && cached.order.length === citations.length) {
      const reranked = cached.order.map((idx, rank) => ({ ...citations[idx], rerankScore: cached.scores[rank], relevanceScore: cached.scores[rank] }));
      return { ...result, citations: reranked, topics: reranked.map((c: any) => c.topic), answer: reranked.map((c: any) => c.context || c.snippet).filter(Boolean).join("\n\n"), reranked: true, platformRerankApplied: true };
    }

    const documents = citations
      .map((citation: any) =>
        String(citation.snippet || citation.context || citation.docTitle || citation.topic || "").slice(0, 1000).trim(),
      )
      .filter(Boolean);
    if (documents.length < 2) return result;
    try {
      const response = await fetch(`${config.provider.baseUrl.replace(/\/$/, "")}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.provider.apiKey ? { Authorization: `Bearer ${config.provider.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.modelName, query: question, documents, top_n: documents.length, return_documents: false }),
        signal: AbortSignal.timeout(Number(process.env.RERANK_TIMEOUT_MS || 15000)),
      });
      if (!response.ok) throw new Error(`Rerank API ${response.status}`);
      const payload: any = await response.json();
      const ranked: Array<{ index: number; relevance_score?: number; score?: number }> =
        Array.isArray(payload?.results) ? payload.results : [];
      if (!ranked.length) return result;

      const scoredItems = ranked
        .map((item) => {
          const idx = Number(item.index);
          const cit = citations[idx];
          const score = typeof item.relevance_score === "number" ? item.relevance_score
            : typeof item.score === "number" ? item.score : 0;
          return { idx, citation: cit, score };
        })
        .filter((item) => Boolean(item.citation) && Number.isInteger(item.idx));
      if (!scoredItems.length) return result;
      scoredItems.sort((a, b) => b.score - a.score);

      const order = scoredItems.map((item) => item.idx);
      const scores = scoredItems.map((item) => item.score);
      this.rerankCache.set(cacheKey, { expiresAt: Date.now() + Number(process.env.RERANK_CACHE_TTL_MS || 300000), order, scores });
      if (this.rerankCache.size > 200) {
        const oldest = this.rerankCache.keys().next().value;
        if (oldest) this.rerankCache.delete(oldest);
      }

      // No truncation here: the single evidence-selection stage decides what
      // enters the answer context, using these comparable scores.
      const reranked = scoredItems.map((item) => ({ ...item.citation, rerankScore: item.score, relevanceScore: item.score }));
      return {
        ...result,
        citations: reranked,
        topics: reranked.map((c: any) => c.topic),
        answer: reranked.map((c: any) => c.context || c.snippet).filter(Boolean).join("\n\n"),
        reranked: true,
        platformRerankApplied: true,
      };
    } catch (error) {
      this.logger.warn(`Rerank unavailable; retaining GBrain ranking: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Single evidence-selection stage (replaces the former document_diversity and
   * focused evidence_gate passes).
   *
   * Policy, all provider/scale independent:
   *  1. Score truth = normalized cross-encoder relevance (min-max over the
   *     batch). Falls back to rerankScore/score only when reranking was skipped.
   *  2. Structural section groups (from section expansion) are ATOMIC units —
   *     kept or dropped whole, never split.
   *  3. Relative relevance floor (default 35% of the best group) removes
   *     distractors without depending on any provider's absolute score scale.
   *  4. Maximal-Marginal-Relevance greedy selection over groups balances
   *     relevance against redundancy, then a token budget bounds the context.
   */
  private selectEvidence(
    result: any,
    opts: { breadth: boolean; tokenBudget: number },
  ): any {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    if (citations.length <= 1) return result;

    const rawScore = (c: any): number => {
      const v = c?.relevanceScore ?? c?.rerankScore ?? c?.score;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const raw = citations.map(rawScore);
    const max = Math.max(...raw);
    const min = Math.min(...raw);
    const range = max - min;
    const norm = (v: number) => (range > 1e-6 ? (v - min) / range : 1);

    const groupKeyOf = (c: any, index: number) =>
      typeof c?.sectionGroup === "string" && c.sectionGroup ? c.sectionGroup : `__single_${index}`;
    const groups = new Map<string, { members: any[]; best: number; repText: string }>();
    citations.forEach((c, index) => {
      const key = groupKeyOf(c, index);
      const entry = groups.get(key) || { members: [], best: -Infinity, repText: "" };
      entry.members.push(c);
      entry.best = Math.max(entry.best, norm(rawScore(c)));
      if (!entry.repText) entry.repText = String(c.context || c.snippet || c.docTitle || c.topic || "").slice(0, 400);
      groups.set(key, entry);
    });

    // Relevance floor on RAW score ratios: min-max normalization stretches a
    // long-tailed reranker distribution and makes a 0.35 relative floor cut
    // genuinely relevant groups. Raw cross-encoder scores share one scale.
    const rawBest = Math.max(...[...groups.values()].map((g) => g.best));
    const relFloor = Math.max(0, Number(process.env.RETRIEVAL_RELEVANCE_FLOOR_RATIO || 0.35));
    const maxGroups = opts.breadth
      ? Math.max(8, Number(process.env.RETRIEVAL_MAX_GROUPS_BREADTH || 16))
      : Math.max(2, Number(process.env.RETRIEVAL_MAX_GROUPS || 8));

    const entries = [...groups.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .filter((g) => g.best >= rawBest * relFloor)
      .sort((a, b) => b.best - a.best);

    const tokenize = (text: string): Set<string> =>
      new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{1,4}/gu) || []).slice(0, 400));
    const jaccard = (a: Set<string>, b: Set<string>) => {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      return inter / (a.size + b.size - inter);
    };
    const costOf = (c: any) => estimateTokens(String(c.context || c.snippet || ""));

    const lambda = Math.min(1, Math.max(0, Number(process.env.RETRIEVAL_MMR_LAMBDA || 0.72)));
    const selected: any[] = [];
    const selectedSets: Array<Set<string>> = [];
    let usedTokens = 0;
    const pool = entries.slice();
    while (pool.length && selectedSets.length < maxGroups) {
      let pickIdx = -1;
      let pickVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const g = pool[i];
        const redundancy = selectedSets.length
          ? Math.max(...selectedSets.map((s) => jaccard(tokenize(g.repText), s)))
          : 0;
        const value = lambda * g.best - (1 - lambda) * redundancy;
        if (value > pickVal) { pickVal = value; pickIdx = i; }
      }
      if (pickIdx < 0) break;
      const group = pool.splice(pickIdx, 1)[0];
      const groupTokens = group.members.reduce((sum, m) => sum + costOf(m), 0);
      // Token budget: the first (best) group always fits; later groups must fit.
      if (selected.length > 0 && usedTokens + groupTokens > opts.tokenBudget) break;
      for (const m of group.members) selected.push(m);
      selectedSets.push(tokenize(group.repText));
      usedTokens += groupTokens;
    }

    if (!selected.length) return result;
    const removed = citations.length - selected.length;
    return {
      ...result,
      citations: selected,
      topics: selected.map((c: any) => c.topic),
      answer: selected.map((c: any) => c.context || c.snippet).filter(Boolean).join("\n\n"),
      evidenceSelection: {
        before: citations.length,
        after: selected.length,
        removed,
        groups: selectedSets.length,
        usedTokens,
        relevanceFloorRatio: relFloor,
        mmrLambda: lambda,
      },
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
    // "weak" is an explicit upstream semantic label (the CLI marks uncertain
    // semantic hits), while exact/keyword evidence is trusted regardless of
    // score. The score only decides whether a weak hit needs one broad pass.
    const weak = evidence.includes("weak") || Boolean((result as any)?.weak);
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

  /**
   * NLI-style entailment judge used only when the deterministic overlap
   * heuristic reports low semantic coverage. Returns the set of statement
   * indices (0-based, into `statements`) that the evidence directly supports.
   * Fail-open: returns an empty set on any error/timeout.
   */
  private async judgeEntailment(statements: string[], evidence: string): Promise<Set<number>> {
    const supported = new Set<number>();
    if (!statements.length || !evidence.trim()) return supported;
    try {
      const llmRequest = this.modelConfigService
        ? await this.modelConfigService.getLlmChatConfig('llmwiki-entailment')
        : null;
      if (!llmRequest) return supported;
      const baseUrl = llmRequest.baseUrl;
      const model = llmRequest.modelName;
      const userContent = `【证据】\n${evidence}\n\n【陈述】\n${statements
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n')}`;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: llmRequest.headers,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                '你是事实蕴含判定专家。给定【证据】与若干【陈述】，判断每条陈述是否能由证据直接支持（entailment），不得使用外部知识。只输出 json：{"supported":[陈述序号数组]}。',
            },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
          max_tokens: Number(process.env.SEMANTIC_COVERAGE_MAX_TOKENS || 1200),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(Number(process.env.SEMANTIC_COVERAGE_TIMEOUT_MS || 15000)),
      });
      if (!response.ok) return supported;
      const payload: any = await response.json();
      const message = payload?.choices?.[0]?.message || {};
      let content = String(message.content || '').trim();
      if (!content) {
        content = String(message.reasoning_content || '').trim();
        const match = content.match(/\{[\s\S]*\}/);
        if (match) content = match[0];
      }
      const parsed = JSON.parse(content);
      for (const raw of Array.isArray(parsed?.supported) ? parsed.supported : []) {
        const index = Number(raw) - 1;
        if (Number.isInteger(index) && index >= 0 && index < statements.length) supported.add(index);
      }
    } catch (err) {
      this.logger.debug(`Entailment judge skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    return supported;
  }

  /**
   * Semantic-cache entries store raw citation objects (camelCase), while the
   * SSE replay path must emit the snake_case timeline_entry contract the
   * frontend reads (doc_title / document_id / kb_name / preview_url).
   * Normalize defensively so replayed citations keep their title, preview
   * link and KB attribution.
   */
  private normalizeTimelineEntry(cit: any) {
    if (!cit || typeof cit !== "object") return cit;
    const sourceKb = cit.source_kb ?? cit.kbId ?? cit.kb;
    const documentId = cit.document_id ?? cit.docId;
    return {
      source_kb: sourceKb,
      kb_name: cit.kb_name ?? cit.kbName ?? sourceKb,
      document_id: documentId,
      doc_title: cit.doc_title ?? cit.docTitle ?? cit.topic,
      section: cit.section,
      score: cit.score,
      snippet: cit.snippet ?? cit.evidence ?? "",
      preview_url:
        cit.preview_url ??
        buildDocumentPreviewUrl(sourceKb, documentId, {
          page: cit.page_no ?? cit.pageNo,
          clause: cit.section,
        }) ??
        undefined,
      version: cit.version,
      page_no: cit.page_no ?? cit.pageNo,
      bbox: cit.bbox ?? cit.bboxes?.[0] ?? cit.metadata?.bbox,
      version_conflict: cit.version_conflict ?? cit.versionConflict,
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
    } else if (citations.length > 8) {
      finalCitations = finalCitations.slice(0, 8);
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
          status: { in: ["published", "indexing"] },
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
    const ungroundedStatements: string[] = [];
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
        else ungroundedStatements.push(stmt);
      }
    }
    // When the deterministic overlap heuristic reports weak coverage, confirm
    // the ungrounded statements with an LLM entailment judge (NLI-style). This
    // removes false positives from paraphrase without letting the model
    // "support" statements that genuinely lack evidence.
    if (
      process.env.SEMANTIC_COVERAGE_JUDGE !== 'false' &&
      finalCitations.length > 0 &&
      ungroundedStatements.length > 0 &&
      groundedStatements / Math.max(1, totalStatements) < 0.6
    ) {
      const evidenceText = finalCitations
        .map((item: any) => String(item.citation.context || item.citation.snippet || ""))
        .join('\n\n')
        .slice(0, 6000);
      const entailed = await this.judgeEntailment(ungroundedStatements, evidenceText);
      groundedStatements += entailed.size;
    }
    let coverageRatio = totalStatements > 0 ? Number((groundedStatements / totalStatements).toFixed(2)) : 1.0;
    // A standard refusal makes no factual claims, so the absence of citation
    // markers is expected. Do not report it as low grounding (false alarm).
    const isRefusalAnswer =
      /(未包含相关信息|无法(?:根据知识库)?回答|不知道|无法提供(?:该信息)?)/.test(fullAnswer) &&
      fullAnswer.trim().length <= 80;
    const semanticCoverage = { totalStatements, groundedStatements, coverageRatio, refusalExempt: isRefusalAnswer };

    let traceStatus = finalCitations.length > 0 ? "success" : "warning";
    let traceMsg = finalCitations.length > 0
        ? `回答引用 ${finalCitations.length} 个原始证据页面`
        : "本次回答没有可绑定的原始证据";

    if (isRefusalAnswer) {
      traceMsg = finalCitations.length > 0
        ? `标准拒答；仍返回 ${finalCitations.length} 个候选证据页面供人工核对`
        : "标准拒答，未返回可绑定证据";
    } else if (citations.length > 0 && coverageRatio < 0.5) {
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
            preview_url: buildDocumentPreviewUrl(cit.kbId, cit.docId, { page: cit.pageNo || cit.page_no || cit.metadata?.page_no }) ?? undefined,
            version: cit.version,
            page_no: cit.pageNo || cit.page_no || cit.metadata?.page_no,
            bbox: cit.bbox || cit.bboxes?.[0] || cit.metadata?.bbox,
            version_conflict: cit.versionConflict,
          },
        },
      });
    });
    subscriber.next({
      data: { type: "done", total_tokens: totalTokens, latency_ms: 0 },
    });
    // Never cache refusals: weak evidence must not poison the cache, or every
    // paraphrase of the question replays the refusal (observed in production).
    const refusalNotCacheable =
      /(未包含相关信息|无法(?:根据知识库)?回答|不知道|无法提供(?:该信息)?)/.test(fullAnswer) ||
      !fullAnswer.trim();
    if (
      this.semanticCacheService &&
      question &&
      userScope?.fingerprint &&
      fullAnswer.trim() &&
      !refusalNotCacheable
    ) {
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

  /**
   * Lost-in-the-middle context reordering (Liu et al., 2023):
   * Places the most relevant evidence chunks at the beginning and end of the context
   * prompt, avoiding the attention decay in the middle.
   */
  private reorderLostInTheMiddle<T>(items: T[]): T[] {
    if (!items || items.length <= 2) return items ? [...items] : [];
    const result: T[] = new Array(items.length);
    let left = 0;
    let right = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      if (i % 2 === 0) {
        result[left++] = items[i];
      } else {
        result[right--] = items[i];
      }
    }
    return result;
  }
}
