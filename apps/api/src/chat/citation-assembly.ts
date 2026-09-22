import { Logger, type MessageEvent } from "@nestjs/common";
import type { Subscriber } from "rxjs";
import { getPrismaClient } from "../prisma";
import type { PermissionService } from "../permission/permission.service";
import type { ModelConfigService } from "../model-config.service";
import type { SemanticCacheService } from "./semantic-cache.service";
import type { ChatTraceRecorder } from "./chat-trace";
import { estimateTokens } from "./context-budget";
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

export interface CitationAssemblyDeps {
  logger: Logger;
  prisma?: any;
  permissionService?: PermissionService;
  modelConfigService?: ModelConfigService;
  semanticCacheService?: SemanticCacheService;
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

  constructor(deps: CitationAssemblyDeps) {
    this.logger = deps.logger;
    this.prisma = deps.prisma ?? getPrismaClient();
    this.permissionService = deps.permissionService as PermissionService;
    this.modelConfigService = deps.modelConfigService;
    this.semanticCacheService = deps.semanticCacheService;
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
    const now = Date.now();
    const allowed = new Map<string, any>(
      docs.filter((doc: any) => documentCurrentlyEffective(doc, now)).map((doc: any) => [doc.id, doc]),
    );
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
          // RAPTOR macro summaries (Level-2 KB-global nodes have documentId
          // null by design) were retrieved with the caller's visible-KB scope,
          // so KB-level membership IS their authorization boundary. Without
          // this branch the permission guard deleted every Level-2 node and
          // the global-recall arm contributed nothing to answers.
          if (citation.raptor && citation.kbId && visibleKbIds.includes(citation.kbId)) {
            return citation;
          }
          if (
            citation.isCompiledDerived &&
            citation.scopeId === derivedGuard.scopeId &&
            citation.aclEpoch === derivedGuard.aclEpoch
          ) {
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
    // Score truth: only calibrated (cross-encoder / engine) scores share one
    // scale. Anchor the relative floor on those whenever they exist, so a
    // fabricated 0.95 from the min-max fallback arm cannot become the "best
    // score" and drag the floor up until genuinely relevant evidence (scored on
    // the real scale) looks irrelevant next to it. When nothing calibrated was
    // produced, the legacy all-scores behaviour is preserved.
    const calibratedScores = citations
      .map((c: any) => calibratedScoreOf(c))
      .filter((v: any): v is number => v !== null);
    const hasCalibrated = calibratedScores.length > 0;
    const raw = citations.map(rawScore);
    const max = Math.max(...raw);
    const min = Math.min(...raw);
    const norm = (v: number) => (max > 0 ? Math.max(0, v) / max : 1);

    const groupKeyOf = (c: any, index: number) =>
      typeof c?.sectionGroup === "string" && c.sectionGroup ? c.sectionGroup : `__single_${index}`;
    const groups = new Map<
      string,
      { members: any[]; best: number; repText: string; isSummary: boolean; isSpreadsheetOrTable: boolean }
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
        repText: "",
        isSummary: false,
        isSpreadsheetOrTable: false,
      };
      entry.members.push(c);
      entry.best = Math.max(entry.best, norm(rawScore(c)));
      if (isSummaryItem) entry.isSummary = true;
      if (isTableItem) entry.isSpreadsheetOrTable = true;
      if (!entry.repText) entry.repText = String(c.context || c.snippet || c.docTitle || c.topic || "").slice(0, 400);
      groups.set(key, entry);
    });

    // Relevance floor on RAW score ratios: min-max normalization stretches a
    // long-tailed reranker distribution and makes a 0.35 relative floor cut
    // genuinely relevant groups. Raw cross-encoder scores share one scale.
    const rawBest = hasCalibrated
      ? Math.max(...calibratedScores)
      : Math.max(...[...groups.values()].map((g) => g.best));
    const relFloor = Math.max(0, Number(process.env.RETRIEVAL_RELEVANCE_FLOOR_RATIO || 0.35));
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
    const entries = allEntries
      .filter(
        (g) =>
          g.best >= rawBest * relFloor ||
          g.members.some((m: any) => m?.floorExempt === true) ||
          // Summary-section groups stay in the pool when the question names them
          // (P2-03): the relevance floor is calibrated on detail-table scores.
          (wantsSummarySection && g.isSummary),
      )
      .sort((a, b) => {
        if (wantsSummarySection) {
          const rank = (g: { isSummary: boolean }) => (g.isSummary ? 1 : 0);
          const diff = rank(b) - rank(a);
          if (diff !== 0) return diff;
        }
        return b.best - a.best;
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
    const pool = entries.slice();
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
        selected.push(g.members[0]);
        selectedSets.push({ tokens, docId, isSummary: true });
        usedTokens += costOf(g.members[0]);
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

        const value = lambda * g.best - (1 - lambda) * redundancy + (isNovelDoc ? 0.15 : 0) + concreteBoost + tableBoost;
        if (value > pickVal) { pickVal = value; pickIdx = i; }
      }
      if (pickIdx < 0) {
        if (pool.length) pickIdx = 0;
        else break;
      }
      const group = pool.splice(pickIdx, 1)[0];
      const groupTokens = group.members.reduce((sum, m) => sum + costOf(m), 0);
      // Token budget: the first (best) group always fits; later groups must fit.
      if (selected.length > 0 && usedTokens + groupTokens > opts.tokenBudget) break;
      for (const m of group.members) selected.push(m);
      const dId = docIdOf(group);
      selectedSets.push({
        tokens: tokenize(group.repText),
        docId: dId,
        isSummary: group.isSummary,
      });
      usedTokens += groupTokens;
      // Only concrete groups count towards document quota; auxiliary summaries do not block concrete evidence
      if (!group.isSummary) {
        docCounts.set(dId, (docCounts.get(dId) || 0) + 1);
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
          const topMember = bestGroup.members[0];
          if (topMember && !selectedIds.has(topMember.id || `${topMember.docId}:${topMember.ord}`)) {
            selected.push(topMember);
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
            usedTokens += costOf(topForHop);
          }
        }
      }
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
        ...(subQueries.length ? { subQueries: subQueries.length, subQueryCovered, subQueryInjected } : {}),
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
      const response = await fetch(`${llmRequest.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
        signal: AbortSignal.timeout(Number(process.env.CHAT_PASSAGE_VERIFY_TIMEOUT_MS || 15000)),
      });
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
    } catch (err) {
      this.logger.debug(
        `Passage containment judge skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return verified;
  }

  async judgeEntailment(statements: string[], evidence: string): Promise<Set<number>> {
    const supported = new Set<number>();
    if (!statements.length || !evidence.trim()) return supported;
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
        signal: AbortSignal.timeout(Number(process.env.SEMANTIC_COVERAGE_TIMEOUT_MS || 6000)),
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
      page_no: cit.page_no ?? cit.pageNo,
      bbox: cit.bbox ?? cit.bboxes?.[0] ?? cit.metadata?.bbox,
      version_conflict: cit.version_conflict ?? cit.versionConflict,
    };
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

    const statements = safeAnswer.split(/(?:\n+|[。！？])/).map(s => s.trim()).filter(s => s.length >= 5);
    const totalStatements = statements.length;
    let groundedStatements = 0;
    const ungroundedStatements: string[] = [];
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
      if (evidenceTexts.length > 0 && statementSupportedBy(stmt, evidenceTexts, hasValidTag)) {
        groundedStatements++;
      } else {
        ungroundedStatements.push(stmt);
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
    if (
      this.semanticCacheService &&
      question &&
      userScope?.fingerprint &&
      fullAnswer.trim() &&
      !refusalNotCacheable &&
      !groundingNotCacheable &&
      !privateContextNotCacheable
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
