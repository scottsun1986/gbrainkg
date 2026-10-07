import { hydrateOriginalSnapshots } from '../ingestion/original-block-snapshot';
import { rethrowAuthorizationFailure } from '../permission/authorization-revision';
import { requestFetch } from '../retrieval/request-signal';
import { assertRequestAuthorization } from '../permission/authorization-revision';
import { Logger, type MessageEvent } from "@nestjs/common";
import type { Subscriber } from "rxjs";
import { getPrismaClient } from "../prisma";
import type { PermissionService } from "../permission/permission.service";
import { DocumentAclService } from "../permission/document-acl.service";
import { getRequestContext } from "../observability/request-context";
import type { ModelConfigService } from "../model-config.service";
import type { SemanticCacheService } from "./semantic-cache.service";
import type { ChatTraceRecorder } from "./chat-trace";
import { estimateTokens } from "./context-budget";
import { measuredScoreOf } from "../retrieval/score-contract";
import { retrievalConfigFingerprint } from "../retrieval/retrieval-config";
import { buildDocumentPreviewUrl } from "../ingestion/preview-url";
import { isProviderErrorText } from "./output-hygiene";
import { classifyTableRole, extractSectionAnchors } from './section-align';
import {
  calibratedScoreOf,
  documentCurrentlyEffective,
  isRefusalAnswerText,
  semanticCacheScopeKey,
  statementSupportedBy,
  stripInvalidCitationMarkers,
} from "./retrieval-arms";

/**
 * Whether the pre-cache entailment gate runs. On by default because it only
 * costs one batched fast-model call per cache write and the downside it guards
 * is a poisoned entry replayed for the whole TTL; operators can disable it when
 * the fast model is unavailable and lexical grounding is the only bar.
 */
function cacheEntailmentGateEnabled(): boolean {
  const raw = String(process.env.CACHE_ENTAILMENT_GATE ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

export interface CitationAssemblyDeps {
  logger: Logger;
  prisma?: any;
  permissionService?: PermissionService;
  modelConfigService?: ModelConfigService;
  semanticCacheService?: SemanticCacheService;
  documentAclService?: DocumentAclService;
}

/** 解析当前请求用户：显式参数 > derivedGuard.userId > 请求上下文。 */
function resolveEffectiveUserId(
  userId: string | undefined,
  derivedGuard?: { userId?: string },
): string | undefined {
  if (userId && typeof userId === "string") return userId;
  const fromGuard = (derivedGuard as any)?.userId;
  if (typeof fromGuard === "string" && fromGuard) return fromGuard;
  try {
    return getRequestContext()?.userId;
  } catch {
    return undefined;
  }
}

/**
 * 整篇回答是否为「标准拒答形态」。
 *
 * 标准拒答经常附带逐来源的不相关说明（"来源 3 为《…总表》，记录的是 … [3]"、
 * "其余来源均与该问题无关"）。缺席声明无法引用任何证据原文，按普通语句做语义
 * 覆盖率核验必然报"覆盖率偏低"的误导性告警。仅靠 80 字符上限识别拒答会把这类
 * 带说明的长拒答误判为低置信回答。这里按语句形态分类：至少一句命中严格拒答词
 * 汇，且其余语句全部是拒答句、缺席声明、来源说明行或短引导语，才视为标准拒答。
 * 含未引用事实陈述的回答不会命中该判定，覆盖率告警照常生效。
 */
export function isRefusalShapedAnswer(fullAnswer: string, statements: string[]): boolean {
  const text = String(fullAnswer || '').trim();
  if (!text) return true;
  if (!isRefusalAnswerText(text)) return false;
  if (text.length <= 80) return true;
  if (statements.length === 0) return false;
  const absenceClaim =
    /(不涉及|未涉及|未包含|未记载|未找到|未检索到|未提供|未提及|没有相关|无相关|无关|均不|不包含)/u;
  const sourceExplanation = /^(?:[-*•]\s*)?(?:来源\s*\d|其余来源|其余参考|其余证据|其余文档|以上来源)/u;
  const filler = (s: string) => s.replace(/\s+/g, '').length <= 12 && !/\d/.test(s);
  const isStrictRefusal = (s: string) => s.trim().length > 0 && isRefusalAnswerText(s);
  if (!statements.some(isStrictRefusal)) return false;
  return statements.every(
    (s) => isStrictRefusal(s) || absenceClaim.test(s) || sourceExplanation.test(s.trim()) || filler(s),
  );
}

/**
 * Remove [n] markers whose citation was dropped by the independent ACL pass.
 * Surviving markers keep their ORIGINAL indices, so only membership in
 * survivingIndices decides: comparing against survivingIndices.size would
 * wrongly strip a trailing citation whenever a middle one is removed
 * (citations [1,2,3] with [2] ACL-dropped → [3] compared against size 2 and
 * lost, leaving a surviving citation unreferenceable in the answer).
 */
export function stripMarkersOfDroppedCitations(
  answer: string,
  survivingIndices: Set<number>,
): string {
  return String(answer || '').replace(/\[(\d+)\]/g, (full, rawIndex) =>
    survivingIndices.has(Number(rawIndex)) ? full : '',
  );
}

/**
 * Evidence selection, weak-evidence assessment, permission filtering,
 * passage/entailment judges and citation emission. Extracted from ChatService.
 */
export class CitationAssemblyService {
  private readonly logger: Logger;
  private prisma: any;
  private readonly permissionService!: PermissionService;
  private readonly modelConfigService?: ModelConfigService;
  private readonly semanticCacheService?: SemanticCacheService;
  private readonly documentAclService: DocumentAclService;

  constructor(deps: CitationAssemblyDeps) {
    this.logger = deps.logger;
    this.prisma = deps.prisma ?? getPrismaClient();
    this.permissionService = deps.permissionService as PermissionService;
    this.modelConfigService = deps.modelConfigService;
    this.semanticCacheService = deps.semanticCacheService;
    this.documentAclService =
      deps.documentAclService ??
      new DocumentAclService(deps.permissionService as PermissionService);
  }

  /**
   * GBrain source 是按用户编译的缓存，权限变更与索引重建之间可能存在短暂延迟。
   * 每次问答都用文档数据库再次校验命中文档，防止旧索引片段越权进入重排或 LLM 上下文。
   */
  async filterQueryResultByCurrentPermission(
    result: any,
    visibleKbIds: string[],
    derivedGuard: {
      scopeId: string;
      sourceKeys: string[];
      aclEpoch: number;
      knowledgeEpoch: number;
      userId?: string;
    },
    explicitUserId?: string,
  ): Promise<any> {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const docIds = citations
      .map((citation: any) => citation.docId)
      .filter(
        (id: any): id is string => typeof id === "string" && id.length > 0,
      );
    const userId = resolveEffectiveUserId(explicitUserId, derivedGuard);

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
            aclMode: true,
            title: true,
            version: true,
            activeVersionId: true,
            createdAt: true,
            updatedAt: true,
            effectiveFrom: true,
            effectiveTo: true,
            lifecycleStatus: true,
            kb: { select: { name: true, type: true } },
          },
        })
      : [];
    // Temporal effectiveness gate (default asOf = now): repealed editions and
    // editions not yet in force must never enter the candidate set, regardless
    // of which retrieval arm produced them. Documents without effective-date
    // metadata stay eligible (unknown is not asserted as invalid).
    const now = getRequestContext()?.asOf ?? Date.now();
    let allowed = new Map<string, any>(
      docs.filter((doc: any) => documentCurrentlyEffective(doc, now)).map((doc: any) => [doc.id, doc]),
    );
    // Document-level ACL (P1): KB membership is necessary but not sufficient when
    // DocumentAcl rows exist for a document. Batch check — never N+1 — and drop
    // citations whose document the caller may not read. Empty ACL inherits the KB.
    if (!userId) {
      allowed.clear();
    } else if (allowed.size > 0) {
      try {
        const readable = await this.documentAclService.filterReadableDocuments(
          userId,
          [...allowed.keys()],
          { docs: [...allowed.values()] },
        );
        if (readable.size !== allowed.size) {
          for (const id of [...allowed.keys()]) {
            if (!readable.has(id)) allowed.delete(id);
          }
        }
      } catch (err) { rethrowAuthorizationFailure(err);
        // Fail-open on ACL service errors would leak; fail-closed drops the
        // contested docs but keeps the rest of the answer path alive.
        this.logger.warn(
          `document ACL filter failed, dropping doc citations: ${err instanceof Error ? err.message : String(err)}`,
        );
        allowed = new Map();
      }
    }
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
      if (!userId) continue;
      const sourceDocs = await this.prisma.document.findMany({
        where: { id: { in: docIds }, kbId: { in: visibleKbIds }, status: "published" },
        select: { id: true, kbId: true, aclMode: true, version: true, activeVersionId: true, contentHash: true },
      });
      if (sourceDocs.length !== new Set(docIds).size) continue;
      type DerivedSource = { id: string; kbId: string; version: number; activeVersionId: string | null; contentHash: string | null };
      const sourcesById = new Map<string, DerivedSource>(sourceDocs.map((doc: DerivedSource) => [doc.id, doc]));
      const sourceManifest = Array.isArray(page.derivedFrom) ? page.derivedFrom : [];
      if (sourceManifest.some((item: any) => {
        const doc = sourcesById.get(item.docId);
        return !doc || (item.version != null && item.version !== doc.version)
          || (item.documentVersionId != null && item.documentVersionId !== doc.activeVersionId)
          || (item.sourceHash != null && item.sourceHash !== doc.contentHash);
      })) continue;
      const readableSources = await this.documentAclService.filterReadableDocuments(userId, docIds, {
        docs: sourceDocs,
        visibleKbIds,
      });
      if (readableSources.size === new Set(docIds).size) validDerived.add(page.slug);
    }
    const raptorKbIds: string[] = [...new Set<string>(citations.filter((citation: any) => (citation.raptor || citation.inventory) && !citation.docId)
      .map((citation: any) => citation.kbId).filter((id: any): id is string => typeof id === 'string' && visibleKbIds.includes(id)))];
    const allowedRaptorKbIds = new Set<string>();
    if (userId && raptorKbIds.length) {
      try {
        const restricted = await this.prisma.documentAcl.findMany({
          where: { document: { kbId: { in: raptorKbIds }, status: 'published' } },
          select: { documentId: true, document: { select: { kbId: true } } },
        });
        const restrictedIds: string[] = [...new Set<string>(restricted.map((entry: any) => String(entry.documentId)))];
        const readable = await this.documentAclService.filterReadableDocuments(userId, restrictedIds, {
          visibleKbIds,
          docs: restricted.map((entry: any) => ({ id: entry.documentId, kbId: entry.document.kbId })),
        });
        for (const kbId of raptorKbIds) {
          if (restricted.every((entry: any) => entry.document.kbId !== kbId || readable.has(entry.documentId))) {
            allowedRaptorKbIds.add(kbId);
          }
        }
      } catch (err) { rethrowAuthorizationFailure(err);
        this.logger.warn(`RAPTOR ACL check failed, dropping global summaries: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const immutableRefs = citations.filter((c: any) => allowed.get(c.docId)?.activeVersionId && (c.chunkId || Number.isInteger(c.ord)));
    let blocks: Array<{ id: string; versionId: string; ord: number; rawHash: string; charStart: number; charEnd: number; rawContent: string | null }> = immutableRefs.length && (this.prisma as any).blockArtifact?.findMany
      ? await this.prisma.blockArtifact.findMany({ where: { OR: immutableRefs.map((c: any) => ({ versionId: allowed.get(c.docId).activeVersionId, ...(c.chunkId ? { id: c.chunkId } : { ord: c.ord }) })) }, select: { id: true, versionId: true, ord: true, rawHash: true, charStart: true, charEnd: true, rawContent: true } }) : [];
    blocks = await hydrateOriginalSnapshots(this.prisma, blocks);
    const blockByOrd = new Map(blocks.map(b => [`${b.versionId}:${b.ord}`, b]));
    const blockById = new Map(blocks.map(b => [b.id,b]));
    const filtered = citations
      .map((citation: any) => {
        if (!citation.docId) {
          // KB-wide summaries have no document binding. They are usable only
          // when every ACL-restricted published document in that KB is readable.
          if (citation.inventory && citation.kbId && allowedRaptorKbIds.has(citation.kbId)) {
            return citation;
          }
          // RAPTOR Level-2 summaries are KB-global and require the same guard.
          if (citation.raptor && citation.kbId && allowedRaptorKbIds.has(citation.kbId)) {
            return citation;
          }
          if (
            citation.isCompiledDerived &&
            citation.scopeId === derivedGuard.scopeId &&
            citation.aclEpoch === derivedGuard.aclEpoch &&
            citation.slug && validDerived.has(citation.slug)
          ) {
            return citation;
          }
          return citation.slug && validDerived.has(citation.slug) ? citation : null;
        }
        const doc = allowed.get(citation.docId);
        // Do not relabel old evidence as the current document version.
        if (doc && citation.version != null && Number(citation.version) !== doc.version) return null;
        const block = citation.chunkId ? blockById.get(citation.chunkId) : blockByOrd.get(`${doc?.activeVersionId}:${citation.ord}`);
        if (doc?.activeVersionId && (citation.chunkId || Number.isInteger(citation.ord)) && (!block || block.rawContent == null) && process.env.CORE_VERSIONING_ENABLED === '1') return null;
        return doc
          ? {
              ...citation,
              kbId: doc.kbId,
              docTitle: doc.title,
              version: doc.version,
              documentVersionId: doc.activeVersionId,
              ...(block ? { ...(block.rawContent != null ? { context: block.rawContent, evidence: block.rawContent, snippet: block.rawContent.slice(0, 1000) } : {}), chunkId: block.id, ord: block.ord, span: { charStart: block.charStart, charEnd: block.charEnd }, contentHash: block.rawHash } : {}),
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
  selectEvidence(
    result: any,
    opts: { breadth: boolean; tokenBudget: number; subQueries?: string[]; question?: string },
  ): any {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    if (citations.length <= 1) return result;

    const rawScore = (c: any): number => {
      const v = c?.relevanceScore ?? c?.rerankScore ?? c?.score;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    // Unified score contract (retrieval/score-contract.ts): thresholds act only
    // on MEASURED scores (cross-encoder raw / Platt probability / engine rerank
    // that actually scored this passage). Synthetic arm scores (min-max 0.05-
    // 0.95 whose top hit is ~0.95 by construction, rescue constants) and
    // rerank-cap overflow candidates (`rerankSkipped`) carry no measurement and
    // may only fill leftover slots. Previously the floor anchor and the
    // guaranteed slots were computed over ALL scores: a pool of synthetic 0.95s
    // the cross-encoder never saw normalised to ~1, dragged the floor onto a
    // fake scale and took the guaranteed slots from genuinely scored evidence
    // (review P0-2).
    const hasCalibrated = citations.some((c: any) => c?.scoreSource !== 'synthetic' && c?.rerankSkipped !== true
      && typeof c?.calibratedProbability === 'number' && Number.isFinite(c.calibratedProbability)
      && c.calibratedProbability >= 0 && c.calibratedProbability <= 1);
    // Hosted reranker scores are ordering signals unless a matching held-out
    // calibration exists. In quality-first mode, a steep raw-score tail must
    // not erase the answer before the original-evidence grounding gate sees it.
    const rankOnly = getRequestContext()?.execution?.qualityFirst === true && !hasCalibrated
      && citations.some((c: any) => c?.scoreSource === 'rerank' && c?.rerankSkipped !== true
        && Number.isFinite(Number(c?.relevanceScore ?? c?.rerankScore ?? c?.score)));
    const measuredOfCitation = citations.map((c: any) => rankOnly
      ? c?.scoreSource === 'rerank' && c?.rerankSkipped !== true && Number.isFinite(Number(c?.relevanceScore ?? c?.rerankScore ?? c?.score))
        ? rawScore(c) : null
      : measuredScoreOf(c));
    const rerankOrdinal = new Map(citations.map((c: any, index: number) => ({ c, index }))
      .filter(({ index }: any) => measuredOfCitation[index] !== null)
      .sort((a: any, b: any) => rawScore(b.c) - rawScore(a.c) || a.index - b.index)
      .map(({ index }: any, rank: number) => [index, rank]));
    const measuredList = measuredOfCitation.filter((v: any): v is number => v !== null);
    const hasMeasured = measuredList.length > 0;
    const maxMeasured = hasMeasured ? Math.max(...measuredList) : 0;
    const raw = citations.map(rawScore);
    const max = Math.max(...raw);
    const norm = (v: number) => (max > 0 ? Math.max(0, v) / max : 1);
    // Elimination funnel bookkeeping (review §4.1): recall ordinal → group, so
    // every candidate that does not reach the context can be attributed to the
    // stage that dropped it. Kept id-only (no text) for privacy/size.
    const groupKeyByIndex = new Map<any, string>();

    const groupKeyOf = (c: any, index: number) =>
      typeof c?.sectionGroup === "string" && c.sectionGroup ? c.sectionGroup : `__single_${index}`;
    const groups = new Map<
      string,
      {
        members: any[];
        best: number;
        bestMember: any;
        bestMemberScore: number;
        summaryMember: any;
        summaryMemberScore: number;
        repText: string;
        isSummary: boolean;
        isSpreadsheetOrTable: boolean;
        measuredBest: number | null;
        firstOrdinal: number;
      }
    >();
    citations.forEach((c: any, index: any) => {
      const key = groupKeyOf(c, index);
      // Strip contextual-retrieval prefixes before structural classification:
      // every chunk of a doc may carry「…汇总统计…」in the [上下文: …] prefix,
      // which falsely marks detail tables as summary (P2-03).
      const evidenceText = String(c.evidence || c.snippet || c.context || "")
        .replace(/^\s*\[\s*上下文[\s\S]*?\]\s*/u, "")
        .replace(/^\s*\[\s*context[\s\S]*?\]\s*/iu, "");
      const headingMatch = evidenceText.match(/^#{1,6}\s*(.+)$/m);
      const structuralSummary =
        c.tableRole === "summary" ||
        c.table_role === "summary" ||
        /汇总|合计|统计/.test(String(c.section || "")) ||
        (headingMatch ? /汇总|合计|统计|摘要/.test(headingMatch[1] || "") : false) ||
        classifyTableRole({
          rowCount: undefined,
          headerText: evidenceText.slice(0, 300),
          section: String(c.section || ""),
        }) === "summary";
      const isSummaryItem = Boolean(
        c.raptor ||
        c.isSummary ||
        String(c.section || "").startsWith("raptor") ||
        String(c.section || "") === "doc-outline" ||
        /【宏观摘要[^】]*】/u.test(evidenceText) ||
        structuralSummary
      );
      const isTableItem = Boolean(
        /(?:\.xlsx?|\.csv|\.tsv)(?:\s*·|\s*$)/i.test(String(c.docTitle || c.topic || "")) ||
        /\|[^\n]+\|[^\n]+\|/g.test(String(c.evidence || c.snippet || c.context || ""))
      );
      const entry = groups.get(key) || {
        members: [],
        best: -Infinity,
        bestMember: null,
        bestMemberScore: -Infinity,
        // Highest-scoring member whose own role is summary-role, kept
        // separately so a summary-question can prefer it even when a detail
        // row of the same section group scores marginally higher.
        summaryMember: null,
        summaryMemberScore: -Infinity,
        repText: "",
        isSummary: false,
        isSpreadsheetOrTable: false,
        measuredBest: null,
        firstOrdinal: Number.MAX_SAFE_INTEGER,
      };
      entry.members.push(c);
      const memberScore = rawScore(c);
      if (memberScore > entry.bestMemberScore) {
        entry.bestMemberScore = memberScore;
        entry.bestMember = c;
      }
      if (isSummaryItem && memberScore > entry.summaryMemberScore) {
        entry.summaryMemberScore = memberScore;
        entry.summaryMember = c;
      }
      const memberMeasured = measuredOfCitation[index];
      if (memberMeasured !== null && memberMeasured !== undefined) {
        entry.measuredBest = Math.max(entry.measuredBest ?? -Infinity, memberMeasured);
      }
      entry.firstOrdinal = Math.min(entry.firstOrdinal, index);
      groupKeyByIndex.set(index, key);
      // Selection score: measured-mode groups are normalised over the MEASURED
      // pool only, so a synthetic 0.95 can no longer define the scale. Groups
      // without any measured member score 0 in measured mode — they do not
      // compete in MMR and enter only via the capped synthetic fill below.
      const selectionScore = rankOnly
        ? memberMeasured != null ? 1 / (1 + Number(rerankOrdinal.get(index))) : 0
        : hasMeasured
        ? entry.measuredBest != null && maxMeasured > 0
          ? entry.measuredBest / maxMeasured
          : 0
        : norm(memberScore);
      entry.best = Math.max(entry.best, selectionScore);
      if (isSummaryItem) entry.isSummary = true;
      if (isTableItem) entry.isSpreadsheetOrTable = true;
      if (!entry.repText) entry.repText = String(c.context || c.snippet || c.docTitle || c.topic || "").slice(0, 400);
      groups.set(key, entry);
    });

    // Relevance floor on RAW score ratios: min-max normalization stretches a
    // long-tailed reranker distribution and makes a rigid relative floor cut
    // genuinely relevant groups. Dynamic soft floor uses quantile-smoothed
    // baseline and top-group safety guarantees to protect true low-score answers.
    // Contract (P0-2): in measured mode the anchor and the comparison both live
    // on the raw measured scale — no normalized value is ever compared against
    // a raw-unit floor again.
    //
    // Rollout switch (review P1-5 / process §4.4): the LOOSENED parameter set
    // from 27cd327 — 0.22 ratio, quantile-smoothed baseline, 6 guaranteed
    // groups, synthetic fill — ships behind RETRIEVAL_SOFT_FLOOR_ENABLED,
    // default OFF, so every instance without an explicit opt-in keeps the rigid
    // 0.35 floor and no guarantee slots until the A/B gate proves the new set.
    // The unified score contract (P0-2 pool separation) is a bug fix and applies
    // in BOTH modes.
    const softFloorEnabled = ['1', 'true', 'on'].includes(
      String(process.env.RETRIEVAL_SOFT_FLOOR_ENABLED ?? '').trim().toLowerCase(),
    );
    const rawBest = hasMeasured
      ? maxMeasured
      : Math.max(...[...groups.values()].map((g) => g.best));

    let baselineScore = rawBest;
    if (softFloorEnabled && hasMeasured && measuredList.length >= 5) {
      const sortedCalibrated = [...measuredList].sort((a, b) => b - a);
      const top3Avg = (sortedCalibrated[0] + sortedCalibrated[1] + sortedCalibrated[2]) / 3;
      // Quantile-smoothed baseline prevents single outlier (e.g. 0.98) from dragging the floor
      // sky-high and discarding valid 0.25 answers, but stays bounded above 80% of rawBest.
      baselineScore = Math.max(rawBest * 0.80, Math.min(rawBest, top3Avg * 1.10));
    }

    const relFloor = Math.max(0, Number(process.env.RETRIEVAL_RELEVANCE_FLOOR_RATIO || (softFloorEnabled ? 0.22 : 0.35)));
    // RETRIEVAL_MAX_FLOOR_CUTOFF was removed (review P1-2): with rerank scores
    // bounded by 1, baselineScore*ratio ≤ ratio < 0.28 whenever ratio ≤ 0.22,
    // so the min() could never bind under the shipped defaults — and under a
    // 0.35 ratio it silently acted as an absolute 0.28 cap the operator never
    // asked for. Score-floor mode uses baselineScore * ratio; uncalibrated
    // quality-first selection uses rank and applies no score floor.
    const effectiveFloor = rankOnly ? 0 : baselineScore * relFloor;

    const questionText = `${opts.question || ""} ${(opts.subQueries || []).join(" ")}`;
    const wantsSummarySection =
      /汇总|合计|统计|总览|摘要/.test(questionText) ||
      extractSectionAnchors(questionText).some((a) => /汇总|合计|统计|摘要/.test(a));
    const hasSubQueries = (opts.subQueries || []).length > 0;
    const maxGroups = hasSubQueries
      ? Math.max(4, Math.min(8, Number(process.env.RETRIEVAL_MAX_GROUPS_MULTIHOP || (opts.subQueries!.length * 2 + 2))))
      : opts.breadth
        ? Math.max(8, Number(process.env.RETRIEVAL_MAX_GROUPS_BREADTH || 16))
        : Math.max(2, Number(process.env.RETRIEVAL_MAX_GROUPS || 8));

    const allEntries = [...groups.entries()].map(([key, g]) => ({ key, ...g }));

    // Guaranteed top groups: top M groups by best score that clear minimal viable relevance
    // (default >= 0.10) are protected from being discarded by relative floor alone, leaving
    // final arbitration to downstream MMR and LLM context budgeting.
    // For queries with decomposed sub-queries, the dedicated per-hop sub-query quota handles
    // hop representation directly.
    // Contract (P0-2): guarantee slots are reserved for MEASURED groups only —
    // the viability check runs on the raw measured score, never on a value a
    // synthetic candidate normalised towards 1.
    // Rollout: guarantees exist only with RETRIEVAL_SOFT_FLOOR_ENABLED (P1-5).
    const minViableRelevance = Math.max(0.01, Number(process.env.RETRIEVAL_MIN_VIABLE_RELEVANCE || 0.10));
    const guaranteeDefault = hasSubQueries ? 0 : softFloorEnabled ? 6 : 0;
    const configuredMinGroups = Number(process.env.RETRIEVAL_MIN_FLOOR_GROUPS ?? guaranteeDefault);
    const defaultMinGroups = softFloorEnabled && Number.isFinite(configuredMinGroups) ? Math.max(0, configuredMinGroups) : 0;
    const minGuaranteedGroups = rankOnly ? 0 : Math.max(0, defaultMinGroups);
    const viabilityOf = (g: (typeof allEntries)[number]) =>
      rankOnly ? g.measuredBest != null ? g.best : -Infinity
        : hasMeasured ? (g.measuredBest ?? -Infinity) : g.best;
    const sortedByBest = [...allEntries].sort((a, b) => viabilityOf(b) - viabilityOf(a));
    const guaranteedKeys = new Set(
      sortedByBest
        .filter((g) => {
          if (hasMeasured) return g.measuredBest != null && g.measuredBest >= minViableRelevance;
          return g.best >= minViableRelevance;
        })
        .slice(0, minGuaranteedGroups)
        .map((g) => g.key),
    );

    const passesFloor = (g: (typeof allEntries)[number]) =>
      rankOnly ? g.measuredBest != null : hasMeasured
        ? (g.measuredBest ?? -Infinity) >= effectiveFloor
        : g.best >= effectiveFloor;

    const entries = allEntries
      .filter(
        (g) =>
          passesFloor(g) ||
          guaranteedKeys.has(g.key) ||
          g.members.some((m: any) => m?.floorExempt === true) ||
          // Summary-section groups stay in the pool when the question names them
          // (P2-03): the relevance floor is calibrated on detail-table scores.
          (wantsSummarySection && g.isSummary),
      )
      // Measured mode: synthetic-only groups do not compete with cross-encoded
      // evidence for MMR slots. They enter exclusively through the capped
      // ordinal-based fill below (or the exemptions above).
      .filter((g) =>
        !hasMeasured ||
        g.measuredBest != null ||
        g.members.some((m: any) => m?.floorExempt === true) ||
        (wantsSummarySection && g.isSummary),
      )
      .sort((a, b) => {
        if (wantsSummarySection) {
          const rank = (g: { isSummary: boolean }) => (g.isSummary ? 1 : 0);
          const diff = rank(b) - rank(a);
          if (diff !== 0) return diff;
        }
        if (b.best !== a.best) return b.best - a.best;
        // Deterministic tie-break. Equal `best` scores previously ordered by Map
        // insertion, which differs between two identical queries when an arm
        // returns inside its timeout on one run and not the other. The evidence
        // block sits after the static instructions in the prompt, so an unstable
        // order invalidates prompt prefix caching for that whole block.
        return String(a.key).localeCompare(String(b.key));
      });

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
    const selectedSets: Array<{ tokens: Set<string>; docId: string; isSummary: boolean }> = [];
    let usedTokens = 0;
    // P1-3 budget accounting: groups degraded to their representative member
    // and groups skipped entirely because nothing about them fits.
    let budgetDegraded = 0;
    let budgetSkipped = 0;
    const budgetSkippedKeys = new Set<string>();
    const budgetDroppedIds = new Set<string>();
    const pool = entries.slice();
    // Audit trail (review §6): why each selected citation entered the context.
    // Only the first reason sticks (order: exempt > guaranteed > floor for MMR
    // picks; dedicated paths mark their own).
    const markReason = (c: any, reason: string) => {
      if (c && typeof c === 'object' && !c.selectionReason) c.selectionReason = reason;
    };
    // Elimination funnel (review §4.1): per-group eligibility snapshot so every
    // dropped candidate can be attributed to floor / mmr_budget / max_groups /
    // rerank_cap after the fact.
    const eligibility = new Map<string, { eligible: boolean }>();
    for (const g of allEntries) {
      eligibility.set(g.key, {
        eligible:
          passesFloor(g) ||
          guaranteedKeys.has(g.key) ||
          g.members.some((m: any) => m?.floorExempt === true) ||
          (wantsSummarySection && g.isSummary),
      });
    }
    const docCounts = new Map<string, number>();
    const normalizeDocId = (doc: any) => {
      const rawId = doc?.docId || doc?.documentId;
      if (rawId) return String(rawId);
      const title = String(doc?.docTitle || doc?.topic || "").replace(/\s*·\s*全文摘要|\s*·\s*章节摘要|【宏观摘要[^】]*】/g, "").trim();
      return title || String(doc?.key || "unknown");
    };
    const docIdOf = (g: any) => normalizeDocId(g.members?.[0] || g);
    // P2-03: when the question names a summary section, force the first 1–2
    // summary-role groups into the context before MMR fills the rest. Without
    // this, 2000-row detail tables occupy every budget slot under the default
    // concrete/table boosts and the summary sheet never reaches the LLM.
    if (wantsSummarySection) {
      const summaryGroups = pool.filter((g) => g.isSummary).slice(0, 2);
      for (const g of summaryGroups) {
        const tokens = tokenize(g.repText);
        const docId = docIdOf(g);
        const representative = g.summaryMember || g.bestMember || g.members[0];
        selected.push(representative);
        markReason(representative, 'summary');
        selectedSets.push({ tokens, docId, isSummary: true });
        usedTokens += costOf(representative);
        docCounts.set(docId, (docCounts.get(docId) || 0) + 1);
        const idx = pool.indexOf(g);
        if (idx >= 0) pool.splice(idx, 1);
      }
    }
    const totalDistinctDocs = new Set(pool.map(docIdOf)).size;
    const maxPerDoc = totalDistinctDocs > 1 ? Math.max(2, Math.floor(maxGroups * 0.55)) : maxGroups;

    while (pool.length && selectedSets.length < maxGroups) {
      let pickIdx = -1;
      let pickVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const g = pool[i];
        const docId = docIdOf(g);
        const countForDoc = docCounts.get(docId) || 0;
        // Soft cap: if this document already reached its quota and other docs remain, give priority to other docs
        const hasOtherDocsInPool = pool.some((other) => (docCounts.get(docIdOf(other)) || 0) < maxPerDoc);
        if (countForDoc >= maxPerDoc && hasOtherDocsInPool) continue;

        // Distinct document boost: if g brings a novel document into the context,
        // it should not suffer the full vocabulary redundancy penalty from other documents.
        const isNovelDoc = countForDoc === 0 && selected.length > 0;
        const gTokens = tokenize(g.repText);

        // When evaluating redundancy:
        // A concrete chunk should NOT be penalized for redundancy against an auxiliary summary of the SAME document!
        const relevantSelectedSets = selectedSets.filter(
          (s) => !(s.docId === docId && s.isSummary && !g.isSummary),
        );
        const rawRedundancy = relevantSelectedSets.length
          ? Math.max(0, ...relevantSelectedSets.map((s) => jaccard(gTokens, s.tokens)))
          : 0;
        const redundancy = isNovelDoc ? rawRedundancy * 0.25 : rawRedundancy;

        // Concrete evidence priority boost:
        // Real document text (and especially tables / spreadsheets) must not be displaced by secondary summaries.
        // Default: prefer concrete tables over secondary summaries.
        // When the question names a summary section (P2-03), invert that bias so
        // 汇总/统计 chunks are not displaced by 2000-row detail tables.
        const concreteBoost = wantsSummarySection ? (g.isSummary ? 0.55 : 0) : (!g.isSummary ? 0.15 : 0);
        const tableBoost = wantsSummarySection ? (g.isSummary ? 0.25 : 0) : (g.isSpreadsheetOrTable ? 0.10 : 0);

        // Multiplicative boosts (review P1-1): additive constants let a
        // 0.12-score table chunk from a novel document (0.72*0.12 + 0.15 + 0.15
        // + 0.10 ≈ 0.49) outscore a 0.50-score same-document text chunk (≈0.36
        // before its redundancy penalty). Fixed bonuses do not scale with
        // relevance, so every loosening of the floor amplified noise straight
        // into the context. Boosts now scale the relevance term itself —
        // EXCEPT a small additive term for novel documents: purely
        // multiplicative boosts demote mid-score cross-document evidence so
        // hard that a qualifying sibling policy loses its slot to same-document
        // bulk (P3-02 regression, V2 died at mmr_budget). +0.06 restores the
        // cross-document push (0.5-score novel group ≈ 0.53 beats a 0.62
        // same-doc group ≈ 0.45) while a 0.12-score noise chunk (≈0.18) still
        // loses to everything relevant.
        const boostFactor = 1 + concreteBoost + tableBoost + (isNovelDoc ? 0.15 : 0);
        const value = lambda * g.best * boostFactor - (1 - lambda) * redundancy + (isNovelDoc ? 0.06 : 0);
        if (value > pickVal) { pickVal = value; pickIdx = i; }
      }
      if (pickIdx < 0) {
        if (pool.length) pickIdx = 0;
        else break;
      }
      const group = pool.splice(pickIdx, 1)[0];
      const groupTokens = group.members.reduce((sum, m) => sum + costOf(m), 0);
      // Token budget (review P1-3): an oversized group no longer TERMINATES the
      // whole MMR loop. Degrade it to its representative member first; if even
      // that does not fit, skip the group and keep scanning — the smaller
      // groups after it (often exactly the short factual answers) still get
      // their chance instead of being dropped by one big neighbour.
      let membersToAdd = group.members;
      if (selected.length > 0 && usedTokens + groupTokens > opts.tokenBudget) {
        const degraded = [(wantsSummarySection ? group.summaryMember : null)
          || group.bestMember
          || group.members[0]].filter(Boolean);
        const degradedTokens = degraded.reduce((sum, m) => sum + costOf(m), 0);
        if (degraded.length && usedTokens + degradedTokens <= opts.tokenBudget) {
          membersToAdd = degraded as any[];
          budgetDegraded += 1;
          for (const m of group.members) {
            if (!membersToAdd.includes(m)) {
              budgetDroppedIds.add(m?.id || `${m?.docId}:${m?.ord}`);
            }
          }
        } else {
          budgetSkipped += 1;
          budgetSkippedKeys.add(group.key);
          continue;
        }
      }
      // Every member of the group reaches the model, so the group's
      // representative must lead: the prompt renders sources in this order and
      // the first one is the passage a summary question is answered from.
      const representative = (wantsSummarySection ? group.summaryMember : null)
        || group.bestMember
        || group.members[0];
      const groupReason = group.members.some((m: any) => m?.floorExempt === true) && !passesFloor(group)
        ? 'exempt'
        : guaranteedKeys.has(group.key) && !passesFloor(group)
          ? 'guaranteed'
          : rankOnly ? 'rank' : 'floor';
      for (const m of membersToAdd) {
        if (m !== representative) selected.push(m);
        markReason(m, groupReason);
      }
      selected.push(representative);
      markReason(representative, groupReason);
      const dId = docIdOf(group);
      selectedSets.push({
        tokens: tokenize(group.repText),
        docId: dId,
        isSummary: group.isSummary,
      });
      usedTokens += membersToAdd.reduce((sum, m) => sum + costOf(m), 0);
      // Only concrete groups count towards document quota; auxiliary summaries do not block concrete evidence
      if (!group.isSummary) {
        docCounts.set(dId, (docCounts.get(dId) || 0) + 1);
      }
    }

    // Synthetic fill (contract rule 3): groups whose scores are arm-local —
    // never cross-encoded, e.g. candidates kept beyond RERANK_MAX_DOCS — do not
    // compete with measured evidence. They fill leftover context slots by
    // original recall ordinal, capped, so recall beyond the rerank capacity
    // still reaches the model without displacing measured evidence.
    let syntheticFilled = 0;
    if (hasMeasured) {
      const fillCap = Math.max(0, Number(process.env.RETRIEVAL_SYNTHETIC_FILL_MAX ?? (softFloorEnabled ? 2 : 0)));
      const syntheticOnly = allEntries
        .filter((g) => g.measuredBest == null)
        .filter((g) => !g.members.some((m: any) => m?.floorExempt === true))
        .sort((a, b) => a.firstOrdinal - b.firstOrdinal);
      for (const g of syntheticOnly) {
        if (syntheticFilled >= fillCap) break;
        if (selectedSets.length >= maxGroups) break;
        const representative = g.bestMember || g.members[0];
        if (!representative) continue;
        const tokens = costOf(representative);
        if (selected.length > 0 && usedTokens + tokens > opts.tokenBudget) continue;
        selected.push(representative);
        markReason(representative, 'synthetic_fill');
        selectedSets.push({ tokens: tokenize(g.repText), docId: docIdOf(g), isSummary: g.isSummary });
        usedTokens += tokens;
        if (!g.isSummary) {
          docCounts.set(docIdOf(g), (docCounts.get(docIdOf(g)) || 0) + 1);
        }
        syntheticFilled += 1;
      }
    }

    // Sub-question coverage quota (compound questions): with a single global
    // relevance ranking, the second hop of "A怎么样，另外B如何" loses to the
    // dominant first-hop group and never reaches the answer context. For each
    // decomposed sub-query, if no already-selected group covers it, inject its
    // best-overlapping group (floor-eligible pool, budget permitting, immune
    // to the MMR redundancy penalty).
    // Sub-question affinity uses content-word containment to prevent dilution from large chunks
    const extractContentTerms = (text: string): string[] => {
      const str = String(text).toLowerCase();
      const hasLatin = /[a-z]/i.test(str);
      if (hasLatin) {
        const stops = new Set(["who", "what", "where", "when", "why", "how", "was", "were", "is", "are", "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "her", "his", "their", "its", "details"]);
        return (str.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !stops.has(w));
      }
      return (str.match(/[\p{L}\p{N}]{2,}/gu) || []);
    };

    const queryCoverageOf = (queryTerms: string[], targetText: string): number => {
      if (!queryTerms.length) return 0;
      const targetLower = String(targetText || "").toLowerCase();
      let hit = 0;
      for (const t of queryTerms) {
        if (targetLower.includes(t)) hit++;
      }
      return hit / queryTerms.length;
    };

    const subQueries = (opts.subQueries || []).filter((q) => typeof q === "string" && q.trim().length >= 3).slice(0, 5);
    let subQueryCovered = 0;
    let subQueryInjected = 0;
    if (subQueries.length && selected.length) {
      const selectedIds = new Set(selected.map((c: any) => c.id || `${c.docId}:${c.ord}`));
      for (const sq of subQueries) {
        const sqTerms = extractContentTerms(sq);
        // Primary signal — provenance: candidates recalled BY this sub-query's
        // own probes carry subQueryOrigin. If such a group survived selection,
        // the hop is covered.
        const originMatches = (origin: unknown) => {
          if (typeof origin !== "string" || !origin.trim()) return false;
          if (origin.trim().toLowerCase() === sq.trim().toLowerCase()) return true;
          return queryCoverageOf(sqTerms, origin) >= 0.5;
        };
        const originCovered = selected.some((c: any) => originMatches(c.subQueryOrigin));
        if (originCovered) { subQueryCovered += 1; continue; }
        // Secondary signal — lexical/content affinity in already selected candidates
        const contentCovered = sqTerms.length > 0 && selected.some((c: any) => {
          const text = String(c.context || c.snippet || c.evidence || "");
          return queryCoverageOf(sqTerms, text) >= 0.90;
        });
        if (contentCovered) { subQueryCovered += 1; continue; }
        // Inject the best group for this hop: prefer provenance-tagged groups,
        // then the highest term-coverage group.
        let bestGroup: (typeof allEntries)[number] | null = null;
        let bestScore = 0;
        for (const g of allEntries) {
          const fullySelected = g.members.every((m: any) => selectedIds.has(m.id || `${m.docId}:${m.ord}`));
          if (fullySelected) continue;
          const tagged = g.members.some((m: any) => originMatches(m.subQueryOrigin));
          const cov = sqTerms.length ? queryCoverageOf(sqTerms, g.repText) : 0;
          const score = tagged ? 2 + g.best : (cov >= 0.33 ? 1 + cov : 0);
          if (score > bestScore) { bestScore = score; bestGroup = g; }
        }
        if (!bestGroup || bestScore < 1.0) continue;
        const groupTokens = bestGroup.members.reduce((sum, m) => sum + costOf(m), 0);
        if (usedTokens + groupTokens > opts.tokenBudget * 1.2) {
          // Guaranteed per-hop representation: if the whole group exceeds budget,
          // still inject at least the top chunk so this reasoning hop is never starved
          // Same rule as the summary path: inject the group's best-scoring
          // member (or its summary-role member), never merely its first chunk,
          // which is an arbitrary position inside the section region.
          const topMember = (wantsSummarySection
            ? bestGroup.summaryMember || bestGroup.bestMember
            : bestGroup.bestMember) || bestGroup.members[0];
          if (topMember && !selectedIds.has(topMember.id || `${topMember.docId}:${topMember.ord}`)) {
            selected.push(topMember);
            markReason(topMember, 'subquery');
            selectedIds.add(topMember.id || `${topMember.docId}:${topMember.ord}`);
            usedTokens += costOf(topMember);
            subQueryInjected += 1;
            subQueryCovered += 1;
          }
          continue;
        }
        for (const m of bestGroup.members) {
          if (!selectedIds.has(m.id || `${m.docId}:${m.ord}`)) {
            selected.push(m);
            markReason(m, 'subquery');
            selectedIds.add(m.id || `${m.docId}:${m.ord}`);
          }
        }
        selectedSets.push({
          tokens: tokenize(bestGroup.repText),
          docId: docIdOf(bestGroup),
          isSummary: bestGroup.isSummary,
        });
        usedTokens += groupTokens;
        subQueryInjected += 1;
        subQueryCovered += 1;
      }
    }

    // Guaranteed multi-hop representation: ensure every executed reasoning hop (hop >= 2)
    // has at least one representative evidence item in the final context.
    const hopsInCitations = new Set<number>();
    citations.forEach((c: any) => { if (typeof c.hop === 'number' && c.hop >= 2) hopsInCitations.add(c.hop); });
    for (const h of hopsInCitations) {
      const hasHopSelected = selected.some((c: any) => c.hop === h);
      if (!hasHopSelected) {
        const topForHop = citations.find((c: any) => c.hop === h);
        if (topForHop) {
          const id = topForHop.id || `${topForHop.docId}:${topForHop.ord}`;
          if (!selected.some((c: any) => (c.id || `${c.docId}:${c.ord}`) === id)) {
            selected.push(topForHop);
            markReason(topForHop, 'hop');
            usedTokens += costOf(topForHop);
          }
        }
      }
    }

    // Multi-source coverage (review §3.3): the recurring production miss (the
    // attendance V2 case) was not low scores but SINGLE-SOURCE MONOPOLY — two
    // sibling policies were both in the candidate pool and only one ever
    // reached the context. For every distinct document whose best group scores
    // at least RETRIEVAL_MULTISOURCE_COVERAGE_RATIO of the best group AND
    // discusses the same topic as already-selected evidence (character-bigram
    // affinity, corpus-agnostic — never a business rule), keep at least its
    // best member. NOT gated behind the soft-floor flag: this is a recall
    // correctness protection, not a loosened parameter set (the P3-02 gate
    // failure showed the flag-off path losing a qualifying sibling document);
    // set the ratio to 0 to disable.
    let multiSourceAdded = 0;
    const multiSourceRatio = Math.max(0, Math.min(1, Number(process.env.RETRIEVAL_MULTISOURCE_COVERAGE_RATIO ?? 0.35)));
    if (multiSourceRatio > 0 && selected.length) {
      const bigramsOf = (text: string): Set<string> => {
        const compact = String(text || '').replace(/\s+/g, '');
        const grams = new Set<string>();
        for (let i = 0; i + 1 < compact.length; i++) grams.add(compact.slice(i, i + 2));
        return grams;
      };
      // The 1-4 char greedy tokenizer under-segments CJK overlaps (two sibling
      // policies sharing 考勤管理/迟到 scored ~0.08 jaccard), so topical affinity
      // for the coverage constraint uses character bigrams of the actual texts.
      const selectedBigrams = selected.map((c: any) => bigramsOf(String(c?.context || c?.snippet || c?.evidence || '')));
      const bestGroupScore = Math.max(...allEntries.map((g) => Math.max(viabilityOf(g), 0)), 0);
      if (bestGroupScore > 0) {
        const representedDocs = new Set(selectedSets.map((s) => s.docId));
        for (const g of allEntries) {
          const docId = docIdOf(g);
          if (representedDocs.has(docId)) continue;
          if (viabilityOf(g) < bestGroupScore * multiSourceRatio) continue;
          // Same topic as the already-selected evidence, different source.
          const gBigrams = bigramsOf(g.repText);
          const topical = selectedBigrams.some((sb) => jaccard(gBigrams, sb) >= 0.15);
          if (!topical) continue;
          const representative = g.bestMember || g.members[0];
          if (!representative) continue;
          const tokens = costOf(representative);
          // Same 20% over-budget allowance as the sub-query quota below: the
          // coverage representative is ONE member, and refusing it at exactly
          // 100% of the budget is how a qualifying sibling policy lost its
          // only slot to same-document bulk (P3-02).
          if (usedTokens + tokens > opts.tokenBudget * 1.2) continue;
          selected.push(representative);
          markReason(representative, 'multi_source');
          selectedSets.push({ tokens: tokenize(g.repText), docId, isSummary: g.isSummary });
          usedTokens += tokens;
          if (!g.isSummary) docCounts.set(docId, (docCounts.get(docId) || 0) + 1);
          representedDocs.add(docId);
          multiSourceAdded += 1;
        }
      }
    }

    if (!selected.length) return result;
    const removed = citations.length - selected.length;
    // --- Elimination funnel (review §4.1) ------------------------------------
    // Attribute every non-selected candidate to the stage that dropped it:
    //   rerank_cap  – never cross-encoded (pool exceeded RERANK_MAX_DOCS)
    //   floor       – group failed the relevance floor / pool separation
    //   mmr_budget  – group (or member) dropped by the token budget
    //   max_groups  – eligible, but MMR/group caps never reached it
    // (acl stripping happens later in the citation pipeline and is reported
    // there as aclStripped.) Only the first N are listed, id-only.
    const selectedIdSet = new Set(selected.map((c: any) => c.id || `${c.docId}:${c.ord}`));
    const eliminatedByStage: Record<string, number> = {};
    const eliminated: Array<{ docId?: string; chunkId?: string; ordinal: number; scoreSource?: string; stage: string }> = [];
    const eliminatedCap = Math.max(0, Number(process.env.RETRIEVAL_ELIMINATION_TRACE_MAX || 12));
    citations.forEach((c: any, index: number) => {
      const id = c?.id || `${c?.docId}:${c?.ord}`;
      if (selectedIdSet.has(id)) return;
      const key = groupKeyByIndex.get(index);
      let stage: string;
      if (c?.rerankSkipped === true) stage = 'rerank_cap';
      else if (budgetDroppedIds.has(id) || (key != null && budgetSkippedKeys.has(key))) stage = 'mmr_budget';
      else if (!key || !eligibility.get(key)?.eligible) stage = 'floor';
      else stage = 'max_groups';
      eliminatedByStage[stage] = (eliminatedByStage[stage] || 0) + 1;
      if (eliminated.length < eliminatedCap) {
        eliminated.push({
          docId: typeof c?.docId === 'string' ? c.docId : undefined,
          chunkId: typeof (c?.chunkId ?? c?.id) === 'string' ? String(c.chunkId ?? c.id) : undefined,
          ordinal: index,
          scoreSource: typeof c?.scoreSource === 'string' ? c.scoreSource : undefined,
          stage,
        });
      }
    });
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
        effectiveFloor,
        // Only real calibrated probabilities count as available calibration.
        // Rank-only selection is explicit so a disabled raw-score floor cannot
        // be mistaken for a calibrated threshold in the trace.
        floorMode: hasCalibrated ? 'calibrated' : rankOnly || getRequestContext()?.execution?.adaptive ? 'uncalibrated' : 'relative',
        floorApplied: !rankOnly,
        selectionScoreMode: rankOnly ? 'rerank_ordinal' : 'score_ratio',
        calibrationAvailable: hasCalibrated,
        guaranteedGroups: guaranteedKeys.size,
        measuredGroups: hasMeasured ? allEntries.filter((g) => g.measuredBest != null).length : undefined,
        syntheticFilled: hasMeasured ? syntheticFilled : undefined,
        budgetDegradedGroups: budgetDegraded || undefined,
        budgetSkippedGroups: budgetSkipped || undefined,
        multiSourceAdded: multiSourceAdded || undefined,
        mmrLambda: lambda,
        ...(subQueries.length ? { subQueries: subQueries.length, subQueryCovered, subQueryInjected } : {}),
        // Recall→rerank→selection funnel for the trace UI (review §5): the
        // cited count is attached downstream in emitCitationsAndComplete.
        funnel: {
          recalled: citations.length,
          rerankScored: measuredList.length,
          eligible: entries.length,
          selected: selected.length,
        },
        // Effective retrieval config fingerprint (review §3.5): every trace is
        // attributable to the exact config it executed under.
        retrievalConfig: retrievalConfigFingerprint(),
        eliminated,
        eliminatedByStage,
      },
    };
  }

  assessWeakEvidence(result: any, breadth = false): {
    shouldEscalate: boolean;
    weak: boolean;
    evidence: string;
    topScore?: number | null;
    scoreFloor?: number;
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
    if (getRequestContext()?.execution?.adaptive) {
      const probability = citations.length ? calibratedScoreOf(citations[0]) : null;
      // Missing calibration is a deployment capability, not a per-query signal
      // that repeated recall will improve. Keep the adaptive candidate/probe
      // budgets, then verify original evidence instead of endlessly escalating.
      if (probability === null && getRequestContext()?.execution?.qualityFirst && result?.reranked && citations.length) {
        return { shouldEscalate: false, weak: true, evidence, topScore: null,
          reason: '重排已完成，置信度未知；保留候选并交由原文核验' };
      }
      return { shouldEscalate: probability === null || probability < .75, weak: probability === null || probability < .75,
        evidence, topScore: probability, scoreFloor: .75, reason: probability === null ? '无经过验证的置信度，继续预算内检索' : '根据验证集校准置信度判断扩检' };
    }
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
   * Strict passage verifier.
   *
   * The missing piece identified on 2026-09-21: the "wide re-check" recovered 7
   * more of the 60 hard multi-hop probes (HotpotQA 7→11, 2Wiki 6→10) but made the
   * model answer 9 of 30 unanswerable questions, because "this passage shares two
   * words with the question" is not "this passage answers the question".
   *
   * This asks the model to judge containment only — a much easier and more
   * reliable task than generating an answer — and fails **closed**: if the judge
   * errors or times out, the passage is dropped and the honest refusal stands.
   */
  async verifyPassageContainment(params: {
    question: string;
    passages: string[];
    knownEvidence?: string;
  }): Promise<Set<number>> {
    const verified = new Set<number>();
    if (!params.passages.length) return verified;
    try {
      // Use the *main* model: the fast model over-rejected every passage in the
      // first attempt (0 of 3 kept on all seven hard cases), which zeroed the
      // gain. Containment judgement is a precision task, not a throughput task.
      const llmRequest = await this.modelConfigService?.getLlmChatConfig?.('llmwiki-passage-verify');
      if (!llmRequest?.apiKey) return verified;
      const numbered = params.passages
        .map((passage, index) => `【片段${index + 1}】${passage}`)
        .join('\n');
      await assertRequestAuthorization();
      const response = await requestFetch(`${llmRequest.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: llmRequest.headers,
        body: JSON.stringify({
          model: llmRequest.modelName,
          messages: [
            {
              role: 'system',
              content:
                '你是严格的证据审核员。给你【问题】【已确认的前置事实】【候选片段】，判断哪些片段包含问题所问的那一个事实。\n' +
                '允许**一次桥接**：若片段中的主体正是【已确认的前置事实】里点名的实体，且片段给出了问题所问的属性/关系，判 YES。\n' +
                '以下一律判 NO：\n' +
                '- 片段主体与问题所问对象不是同一个（例如问题问 A 计划的预算，片段给的是 B 项目的金额）；\n' +
                '- 只是主题相关、只提到同一实体、只给出可参考的相似信息；\n' +
                '- 需要外部知识才能推出答案。\n' +
                '只输出 JSON：{"contain":[片段序号数组]}；没有任何片段满足时输出 {"contain":[]}。',
            },
            {
              role: 'user',
              content:
                `【问题】${params.question}\n\n` +
                `【已确认的前置事实】${String(params.knownEvidence || '').slice(0, 1200) || '（无）'}\n\n` +
                `【候选片段】\n${numbered}`,
            },
          ],
          temperature: 0,
          max_tokens: Number(process.env.CHAT_PASSAGE_VERIFY_MAX_TOKENS || 200),
          response_format: { type: 'json_object' },
        }),
        }, Number(process.env.CHAT_PASSAGE_VERIFY_TIMEOUT_MS || 15000));
      if (!response.ok) return verified;
      const payload: any = await response.json();
      const message = payload?.choices?.[0]?.message || {};
      const content = String(message.content || message.reasoning_content || '').trim();
      const json = (content.match(/\{[\s\S]*\}/) || [content])[0];
      const parsed = JSON.parse(json);
      for (const raw of Array.isArray(parsed?.contain) ? parsed.contain : []) {
        const index = Number(raw) - 1;
        if (Number.isInteger(index) && index >= 0 && index < params.passages.length) verified.add(index);
      }
    } catch (err) { rethrowAuthorizationFailure(err);
      this.logger.debug(
        `Passage containment judge skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return verified;
  }

  /**
   * Judge which statements the evidence entails.
   *
   * Statements are judged in small parallel batches, and a batch whose call
   * fails or times out is retried once. A single call for every held sentence
   * used to take just over the 6 s timeout on long answers, so ONE slow call
   * dropped every held sentence at once (production: 6009 ms / 6015 ms, all 6
   * held sentences of a "V1 vs V2" answer lost, leaving a bare heading).
   * Smaller batches finish faster and a failure only costs that batch.
   */
  async judgeEntailment(statements: string[], evidence: string): Promise<Set<number>> {
    const supported = new Set<number>();
    if (!statements.length || !evidence.trim()) return supported;
    const batchSize = Math.max(1, Number(process.env.SEMANTIC_COVERAGE_BATCH_SIZE || 3));
    const batches: number[][] = [];
    for (let i = 0; i < statements.length; i += batchSize) {
      batches.push(statements.slice(i, i + batchSize).map((_, j) => i + j));
    }
    const results = await Promise.all(
      batches.map(async (indexes) => {
        const batch = indexes.map((i) => statements[i]);
        let judged = await this.judgeEntailmentBatch(batch, evidence);
        if (judged === null) judged = await this.judgeEntailmentBatch(batch, evidence);
        return { indexes, judged };
      }),
    );
    for (const { indexes, judged } of results) {
      for (const local of judged || []) {
        if (local >= 0 && local < indexes.length) supported.add(indexes[local]);
      }
    }
    return supported;
  }

  /** One entailment call. Returns null when the call itself failed (retryable). */
  private async judgeEntailmentBatch(statements: string[], evidence: string): Promise<Set<number> | null> {
    const supported = new Set<number>();
    try {
      const llmRequest = this.modelConfigService
        ? (await this.modelConfigService?.getFastLlmChatConfig?.('llmwiki-entailment')) ??
          (await this.modelConfigService?.getLlmChatConfig?.('llmwiki-entailment'))
        : null;
      if (!llmRequest) return supported;
      const baseUrl = llmRequest.baseUrl;
      const model = llmRequest.modelName;
      const userContent = `【证据】\n${evidence}\n\n【陈述】\n${statements
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n')}`;
      await assertRequestAuthorization();
      const response = await requestFetch(`${baseUrl}/chat/completions`, {
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
        }, Number(process.env.SEMANTIC_COVERAGE_TIMEOUT_MS || 6000));
      if (!response.ok) return null;
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
    } catch (err) { rethrowAuthorizationFailure(err);
      this.logger.debug(`Entailment judge skipped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
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
  normalizeTimelineEntry(cit: any) {
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
      document_version_id: cit.document_version_id ?? cit.documentVersionId,
      block_id: cit.block_id ?? cit.chunkId,
      span: cit.span,
      content_hash: cit.content_hash ?? cit.contentHash,
      page_no: cit.page_no ?? cit.pageNo,
      bbox: cit.bbox ?? cit.bboxes?.[0] ?? cit.metadata?.bbox,
      version_conflict: cit.version_conflict ?? cit.versionConflict,
    };
  }

  /**
   * Cite every document whose content is byte-identical to a cited one.
   *
   * A knowledge base may legitimately hold duplicate uploads of the same file
   * (a "… (副本).doc" beside its original); they share a `Document.contentHash`.
   * When the answer cites one of them, the reference list must include its
   * identical siblings so the user sees every source that carries the fact and
   * the count does not depend on which copy happened to rank first. Siblings
   * are appended with fresh indices and the answer's markers are widened to
   * cite them too (see the caller). Permission-checked and bounded.
   */
  private async expandIdenticalContentCitations(
    userId: string,
    finalCitations: Array<{ citation: any; originalIndex: number }>,
    visibleKbs: string[],
  ): Promise<{
    citations: Array<{ citation: any; originalIndex: number }>;
    siblingIndicesByIndex: Map<number, number[]>;
  }> {
    const siblingIndicesByIndex = new Map<number, number[]>();
    if (process.env.CITATION_EXPAND_IDENTICAL === 'false' || !visibleKbs.length) {
      return { citations: finalCitations, siblingIndicesByIndex };
    }
    const citedDocIds = [...new Set(finalCitations.map((f) => f.citation.docId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (!citedDocIds.length) return { citations: finalCitations, siblingIndicesByIndex };
    const docs = await this.prisma.document.findMany({
      where: { id: { in: citedDocIds } },
      select: { id: true, kbId: true, contentHash: true },
    });
    const hashByDoc = new Map<string, string>();
    for (const doc of docs) if (doc.contentHash) hashByDoc.set(doc.id, doc.contentHash);
    if (!hashByDoc.size) return { citations: finalCitations, siblingIndicesByIndex };
    const hashes = [...new Set(hashByDoc.values())];
    const candidates = await this.prisma.document.findMany({
      where: { kbId: { in: visibleKbs }, status: 'published', contentHash: { in: hashes } },
      select: { id: true, kbId: true, title: true, version: true, contentHash: true, aclMode: true },
    });
    if (!candidates.length) return { citations: finalCitations, siblingIndicesByIndex };
    // Document-level ACL: a duplicate is only citable when the caller may read it.
    const readable = await this.documentAclService.filterReadableDocuments(
      userId,
      candidates.map((d: any) => d.id),
      { docs: candidates as any },
    );
    const existing = new Set(finalCitations.map((f) => f.citation.docId).filter(Boolean));
    let nextIndex = finalCitations.reduce((max, f) => Math.max(max, f.originalIndex), 0);
    const additions: Array<{ citation: any; originalIndex: number }> = [];
    for (const item of finalCitations) {
      const hash = item.citation.docId ? hashByDoc.get(item.citation.docId) : undefined;
      if (!hash) continue;
      for (const sib of candidates) {
        if (sib.contentHash !== hash || sib.id === item.citation.docId) continue;
        if (!readable.has(sib.id) || existing.has(sib.id)) continue;
        existing.add(sib.id);
        nextIndex += 1;
        additions.push({
          originalIndex: nextIndex,
          citation: {
            ...item.citation,
            docId: sib.id,
            kbId: sib.kbId,
            docTitle: sib.title,
            topic: sib.title,
            version: sib.version,
            identicalContentOf: item.citation.docId,
          },
        });
        const siblings = siblingIndicesByIndex.get(item.originalIndex) || [];
        siblings.push(nextIndex);
        siblingIndicesByIndex.set(item.originalIndex, siblings);
      }
    }
    if (!additions.length) return { citations: finalCitations, siblingIndicesByIndex };
    this.logger.debug(`Identical-content citation expansion added ${additions.length} duplicate source(s).`);
    return { citations: [...finalCitations, ...additions], siblingIndicesByIndex };
  }

  async emitCitationsAndComplete(
    userId: string,
    citations: any[],
    subscriber: Subscriber<MessageEvent>,
    totalTokens: number,
    fullAnswer = "",
    trace: ChatTraceRecorder,
    question?: string,
    userScope?: { fingerprint: string; knowledgeEpoch: number; cacheable?: boolean },
    modelName?: string,
    answerKind?: 'refusal',
  ) {
    trace.start("citation_validation", "引用校验与映射", "校验回答角标并绑定到原始文档预览");
    // If the LLM cited specific [n] sources, match and retain them
    let safeAnswer = stripInvalidCitationMarkers(fullAnswer, citations.length);
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
    let visibleKbs: string[] = [];
    const docIdsToCheck = finalCitations
      .map((item) => item.citation.docId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    if (docIdsToCheck.length > 0) {
      visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
      const validDocs = await this.prisma.document.findMany({
        where: {
          id: { in: docIdsToCheck },
          kbId: { in: visibleKbs },
          status: "published",
        },
        select: { id: true },
      });
      validDocIdSet = new Set(validDocs.map((d: any) => d.id));
    }

    const preAclCount = finalCitations.length;
    finalCitations = finalCitations.filter(({ citation, originalIndex }) => {
      if (citation.docId && !validDocIdSet.has(citation.docId)) {
        this.logger.warn(`Stripping citation [${originalIndex}] (docId: ${citation.docId}) due to independent ACL check failure.`);
        return false;
      }
      return true;
    });
    if (finalCitations.length < preAclCount) {
      const survivingIndices = new Set(finalCitations.map((f) => f.originalIndex));
      safeAnswer = stripMarkersOfDroppedCitations(safeAnswer, survivingIndices);
    }

    // Cite every byte-identical duplicate of a cited document (a KB may hold a
    // "… (副本).doc" next to its original with the same Document.contentHash), so
    // the reference list does not depend on which copy happened to rank first.
    const identicalExpansion = await this.expandIdenticalContentCitations(userId, finalCitations, visibleKbs);
    finalCitations = identicalExpansion.citations;
    for (const siblings of identicalExpansion.siblingIndicesByIndex.values()) {
      for (const index of siblings) citedIndices.add(index);
    }

    const statements = safeAnswer.split(/(?:\n+|[。！？])/).map(s => s.trim()).filter(s => s.length >= 5);
    const totalStatements = statements.length;
    let groundedStatements = 0;
    const ungroundedStatements: string[] = [];
    // P1 质量-2 句级证据绑定：每个语句记录其引用的角标与证据块，供蕴含
    // 判定、诊断工具与人工审核逐句回溯（span binding）。
    const sentenceGrounding: Array<{ text: string; cites: number[] | null; chunkIds: string[]; supported: boolean }> = [];
    for (const stmt of statements) {
      const tags = stmt.match(/\[(\d+)\]/g) || [];
      const validTagIndices = tags
        .map((tag) => parseInt(tag.replace(/\D/g, ""), 10))
        .filter((n) => citedIndices.has(n));
      const hasValidTag = validTagIndices.length > 0;
      // A valid marker alone is not grounding: numeric claims must appear in
      // the cited evidence and the statement must overlap it lexically (see
      // statementSupportedBy). This closes the "fabricated fact wearing a real
      // citation index" hole.
      const evidenceTexts = hasValidTag
        ? validTagIndices.map((n) => {
            const item = finalCitations.find((f) => f.originalIndex === n);
            return String(item?.citation?.context || item?.citation?.snippet || "");
          }).filter(Boolean)
        : finalCitations.map((item: any) => String(item.citation?.context || item.citation?.snippet || ""));
      const lexicallySupported = evidenceTexts.length > 0 && statementSupportedBy(stmt, evidenceTexts, hasValidTag);
      const boundCitations = hasValidTag
        ? validTagIndices.map((n) => finalCitations.find((f) => f.originalIndex === n)?.citation).filter(Boolean)
        : [];
      sentenceGrounding.push({
        text: stmt,
        cites: hasValidTag ? validTagIndices : null,
        chunkIds: boundCitations.map((c: any) => String(c?.chunkId || c?.metadata?.blockId || '')).filter(Boolean),
        supported: lexicallySupported,
      });
      if (lexicallySupported) {
        groundedStatements++;
      } else {
        ungroundedStatements.push(stmt);
      }
    }
    // Route EVERY deterministically-ungrounded statement to the entailment
    // judge (NLI-style), regardless of the grounding ratio: an isolated
    // fabrication must face the judge even when the rest of the answer is
    // well grounded. The 0.6 ratio no longer gates the judge — it only decides
    // whether the trace warns about low coverage below.
    if (
      process.env.SEMANTIC_COVERAGE_JUDGE !== 'false' &&
      finalCitations.length > 0 &&
      ungroundedStatements.length > 0
    ) {
      const evidenceText = finalCitations
        .map((item: any) => String(item.citation.context || item.citation.snippet || ""))
        .join('\n\n')
        .slice(0, 6000);
      const entailed = await this.judgeEntailment(ungroundedStatements, evidenceText);
      groundedStatements += entailed.size;
      // 蕴含判定放行的语句在绑定表中标注为 supported（判定通道与词面通道分开）。
      for (const entailedIndex of entailed) {
        const text = ungroundedStatements[entailedIndex];
        const binding = sentenceGrounding.find((g) => g.text === text);
        if (binding) binding.supported = true;
      }
    }
    let coverageRatio = totalStatements > 0 ? Number((groundedStatements / totalStatements).toFixed(2)) : 1.0;
    // A standard refusal makes no factual claims, so the absence of citation
    // markers is expected. Do not report it as low grounding (false alarm).
    const isRefusalAnswer = isRefusalShapedAnswer(fullAnswer, statements);
    const semanticCoverage = { totalStatements, groundedStatements, coverageRatio, refusalExempt: isRefusalAnswer };

    let traceStatus = finalCitations.length > 0 ? "success" : "warning";
    let traceMsg = finalCitations.length > 0
        ? `回答引用 ${finalCitations.length} 个原始证据页面`
        : "本次回答没有可绑定的原始证据";

    if (isRefusalAnswer) {
      traceMsg = finalCitations.length > 0
        ? `标准拒答；仍返回 ${finalCitations.length} 个候选证据页面供人工核对`
        : "标准拒答，未返回可绑定证据";
    } else if (citations.length > 0 && coverageRatio < 0.6) {
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
        // 句级绑定与未支撑语句清单（诊断三段导出与人工审核的输入）。
        sentenceGrounding: sentenceGrounding.map((g) => ({ ...g, text: g.text.slice(0, 80) })),
        unsupportedStatements: ungroundedStatements.map((s) => s.slice(0, 80)),
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
            document_version_id: cit.documentVersionId,
            block_id: cit.chunkId || cit.metadata?.blockId,
            span: cit.span || cit.metadata?.span,
            content_hash: cit.contentHash || cit.metadata?.contentHash,
            evidence_refs: cit.evidenceRefs,
            page_no: cit.pageNo || cit.page_no || cit.metadata?.page_no,
            bbox: cit.bbox || cit.bboxes?.[0] || cit.metadata?.bbox,
            version_conflict: cit.versionConflict,
          },
        },
      });
    });
    subscriber.next({
      data: { type: "done", total_tokens: totalTokens, latency_ms: 0,
        answer_kind: answerKind,
        dependency_manifest: getRequestContext()?.evidenceDependencies,
        execution: getRequestContext()?.execution?.report() },
    });
    // Never cache refusals: weak evidence must not poison the cache, or every
    // paraphrase of the question replays the refusal (observed in production).
    // Low-grounding answers are equally excluded: only answers whose claims
    // were verified against the cited evidence may serve later cache hits.
    //
    // The refusal detector used to be Chinese-only, so on English corpora
    // ("...is not recorded in the provided reference materials") refusals were
    // cached and replayed — including by the international benchmarks, where a
    // question that retrieval later improved stayed unanswered for the whole TTL.
    // Citation-less answers are excluded for the same reason: an answer with no
    // evidence behind it must never be replayed.
    const refusalNotCacheable =
      isRefusalAnswerText(fullAnswer) ||
      !fullAnswer.trim() ||
      finalCitations.length === 0 ||
      // A transport failure relayed as prose can never become a cached answer:
      // the gate drops such sentences, but a partial stream could still leave
      // one behind, so it is re-checked here on the way into the cache.
      isProviderErrorText(fullAnswer);
    const cacheMinGrounding = Number(process.env.CACHE_MIN_GROUNDING || 0.8);
    const groundingNotCacheable =
      !isRefusalAnswer && totalStatements > 0 && coverageRatio < cacheMinGrounding;
    if (groundingNotCacheable) {
      this.logger.warn(
        `Answer not cached: grounding coverage ${coverageRatio} below threshold ${cacheMinGrounding}.`,
      );
    }
    // Private-context answers are not cacheable. The cache key is already
    // per-user (see semanticCacheScopeKey), and this second gate keeps answers
    // that were generated from personal memory or from earlier conversation
    // turns out of the cache entirely: replaying them in a *different*
    // conversation would surface context the caller never supplied.
    const privateContextNotCacheable = userScope?.cacheable === false;
    if (privateContextNotCacheable && fullAnswer.trim() && !refusalNotCacheable) {
      this.logger.debug(
        "Answer not cached: generated with private context (personal memory or prior conversation turns).",
      );
    }
    // Entailment gate on the way INTO the cache.
    //
    // The coverage ratio above is a lexical proxy: statementSupportedBy accepts
    // a sentence when its characters/Han bigrams overlap the cited evidence and
    // its numeric claims appear there. A sentence can clear that bar while
    // asserting something the evidence does not entail (the classic failure is
    // a same-topic distractor quoted as if it answered the question). A cache
    // entry then replays that ungrounded answer to every user in the same scope
    // for the whole TTL, so the one place a fabricated claim must not survive
    // is the write.
    //
    // The judge is best-effort and batched: all statements go to the fast model
    // in one call, and a failure to reach the model is not treated as
    // verification (it falls back to the lexical decision already made, so a
    // model outage cannot silently bless a poisoned answer either way - it
    // simply does not add the extra veto).
    let entailmentVetoed = false;
    let entailmentVerified = false;
    if (
      cacheEntailmentGateEnabled() &&
      this.semanticCacheService &&
      question &&
      userScope?.fingerprint &&
      fullAnswer.trim() &&
      !refusalNotCacheable &&
      !groundingNotCacheable &&
      !privateContextNotCacheable &&
      statements.length > 0
    ) {
      try {
        // Evidence is the same pool the answer was allowed to cite - the union
        // of selected citation texts, which is what the judge needs to decide
        // entailment rather than mere topicality.
        const evidenceText = finalCitations
          .map((item: any) => String(item?.citation?.context || item?.citation?.snippet || ''))
          .filter(Boolean)
          .join('\n\n');
        if (evidenceText.trim()) {
          const supported = await this.judgeEntailment(statements, evidenceText);
          const unsupportedCount = statements.length - supported.size;
          entailmentVerified = supported.size > 0;
          if (unsupportedCount > 0) {
            entailmentVetoed = true;
            this.logger.warn(
              `Answer not cached: entailment judge rejected ${unsupportedCount}/${statements.length} statements.`,
            );
          }
        }
      } catch (err) {
        this.logger.debug(
          `Entailment gate skipped for cache write: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (
      this.semanticCacheService &&
      question &&
      userScope?.fingerprint &&
      fullAnswer.trim() &&
      !refusalNotCacheable &&
      !groundingNotCacheable &&
      !privateContextNotCacheable &&
      !entailmentVetoed
    ) {
      this.semanticCacheService.store(
        question,
        null,
        // userScope.fingerprint here IS the semanticCacheScopeKey hash: the
        // processChat call site passes { fingerprint: cacheScopeKey }, so
        // lookup and store share the same salted scope key.
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

/**
 * Merge per-chunk citations of the same document into one source entry.
 *
 * Evidence selection deliberately keeps several chunks of one document
 * (different sections, multi-hop coverage), but the source list numbered each
 * CHUNK as its own 【来源 N】: the same document appeared several times in the
 * prompt sources and in the client citation list, and the model cited the same
 * knowledge with different markers ([1] and [3] below pointing at one doc).
 *
 * The merge keeps every chunk's text (sections separated by an anchor line so
 * the model can still point at them), preserves first-occurrence order, keeps
 * the best score, and ORs compiled-truth flags. Documents are keyed by
 * (kbId, docId), falling back to (kbId, docTitle) for sources without ids.
 * `mergedChunkCount > 1` marks entries assembled from multiple chunks so the
 * prompt renderer does not re-truncate text that the token budget already
 * approved per chunk.
 */
export function mergeCitationsByDocument(citations: any[]): any[] {
  if (!Array.isArray(citations) || citations.length <= 1) return citations || [];
  const out: any[] = [];
  const indexByKey = new Map<string, number>();
  for (const c of citations) {
    if (!c) continue;
    const kb = String(c.kbId || '');
    const docKey = c.docId ? `id:${c.docId}` : `title:${String(c.docTitle || c.topic || '')}`;
    const key = `${kb}|${docKey}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, out.length);
      out.push({ ...c, evidenceRefs: c.chunkId ? [{ blockId: c.chunkId, span: c.span, contentHash: c.contentHash, versionId: c.documentVersionId }] : [], mergedChunkCount: 1 });
      continue;
    }
    const merged = out[existingIndex];
    const prev = String(merged.context || merged.snippet || '');
    const next = String(c.context || c.snippet || '');
    if (next && !prev.includes(next)) {
      const anchor = c.section ? `\n【${c.section}】\n` : '\n\n';
      merged.context = prev ? `${prev}${anchor}${next}` : next;
      merged.snippet = String(merged.context).slice(0, 500);
    }
    if (c.chunkId && !merged.evidenceRefs.some((r: any) => r.blockId === c.chunkId)) merged.evidenceRefs.push({ blockId: c.chunkId, span: c.span, contentHash: c.contentHash, versionId: c.documentVersionId });
    merged.mergedChunkCount = (Number(merged.mergedChunkCount) || 1) + 1;
    merged.score = Math.max(Number(merged.score || 0), Number(c.score || 0));
    if (!merged.section && c.section) merged.section = c.section;
    if (merged.pageNo == null && c.pageNo != null) merged.pageNo = c.pageNo;
    merged.isCompiledTruth = merged.isCompiledTruth || c.isCompiledTruth;
    merged.isCompiledDerived = merged.isCompiledDerived || c.isCompiledDerived;
    if (merged.version == null && c.version != null) merged.version = c.version;
  }
  return out;
}
