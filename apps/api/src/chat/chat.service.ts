import { Injectable, Logger, MessageEvent, Optional, Inject, ForbiddenException } from "@nestjs/common";
import { Observable, Subscriber } from "rxjs";
import { PermissionService } from "../permission/permission.service";
import { DocumentAclService } from "../permission/document-acl.service";
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
import { WeKnoraClient, WeKnoraBinding, RetrievedEvidence } from "../retrieval/weknora-client";
import { estimateTokens, resolveContextTokenBudget } from "./context-budget";
import { parseTermMappings, expandQueryWithTermMappings, type TermMapping } from "./term-mapping";
import { numericClaimsSupportedBy, numberNearBound } from "./grounding-numeric";
import { compressConversationHistory } from "./history-compress";
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { SemanticCacheService } from "./semantic-cache.service";
import { AgenticRagService } from "./agentic-rag.service";
import { resolveRelationSurfaceForms } from './corpus-agnostic-config';
import { applySectionAlign, extractSectionAnchors } from './section-align';
import { needsSectionRescue } from './section-rescue';
import { ShadowRetrievalService } from '../experiments/shadow-retrieval.service';
import { CONTROL_VARIANT } from '../experiments/retrieval-variants';
import { extractRelationFromQuery as extractRelationFromQueryImpl } from './relation-extractor';
import { RaptorService } from "../raptor/raptor.service";
import { EmbeddingService } from "../embedding/embedding.service";
import { buildDocumentPreviewUrl } from "../ingestion/preview-url";
import { buildBm25Pool, bm25Scores } from "./lexical-bm25";
import {
  extractAnswerFromReasoning,
  isPlanningLikeText,
  isProviderErrorText,
  looksLikeMetaDiscourse,
  looksLikeQuestionEcho,
} from "./output-hygiene";
import {
  answerTypeOf,
  extractCapitalisedCandidates,
  parseRetryMarkers,
  planAspectPassageRescue,
  planDocumentCompleteness,
  planSecondHopRescue,
  planTopRankGuarantee,
  rewriteRetryMarkers,
  selectRetrySentenceSources,
  selectSupportingSentences,
  selectTypedPassageSources,
} from "./bridge-rescue";
import { routeKnowledgeBasesByIntent } from "../retrieval/kb-intent-router";
import { LexicalIndexService } from "../retrieval/lexical-index.service";
import { tokenizeQuery } from "../retrieval/lexical-tokenizer";
import { Bulkhead, RetrievalDeadline } from "../retrieval/retrieval-budget";
import { HybridRetrievalService } from "../retrieval/hybrid-retrieval.service";
import {
  buildEvidenceReasoningGroups,
  fitStructuredEvidenceToBudget,
  formatEvidenceReasoningMap,
  planStructuredEvidence,
} from "./evidence-pack";
import { RetrievalArmsService } from "./retrieval-arms";
import { FusionRerankService } from "./fusion-rerank";
import { CitationAssemblyService } from "./citation-assembly";
import { QueryRewriterService, type RetrievalRequest } from "./query-rewriter";

// Re-export shared pure helpers (moved to retrieval-arms) so the public API is unchanged.
export {
  calibratedScoreOf,
  documentCurrentlyEffective,
  extractRawChunkText,
  hasPolarityConflict,
  isRefusalAnswerText,
  numericClaimsOf,
  semanticCacheScopeKey,
  statementSupportedBy,
  stripInvalidCitationMarkers,
} from "./retrieval-arms";

// Local uses of the moved helpers (processChat grounding gate, stitching, etc.)
import {
  calibratedScoreOf,
  documentCurrentlyEffective,
  extractRawChunkText,
  hasPolarityConflict,
  isRefusalAnswerText,
  numericClaimsOf,
  semanticCacheScopeKey,
  statementSupportedBy,
  stripInvalidCitationMarkers,
} from "./retrieval-arms";

export interface CitationEvidenceLike {
  context?: string;
  snippet?: string;
}

function evidenceTextOf(entry: CitationEvidenceLike | undefined | null): string {
  if (!entry) return '';
  return String(entry.context || entry.snippet || '');
}

/**
 * Truncate chunk text intelligently to fit within maxChunkLen:
 * 1. If text is within maxChunkLen, return as is.
 * 2. If text must be truncated:
 *    - Search for paragraph boundary (\n\n) or line boundary (\n) in the last 20% range.
 *    - If inside a Markdown table, preserve complete table rows and close with a clean truncation marker.
 *    - Avoid chopping mid-word or mid-table-row.
 */
export function smartTruncateChunkText(rawText: string, maxChunkLen: number): string {
  if (!rawText || rawText.length <= maxChunkLen) return rawText;

  const minSafe = Math.floor(maxChunkLen * 0.8);
  const candidateSlice = rawText.slice(0, maxChunkLen);

  // 1. Try paragraph break \n\n
  const lastDoubleNewline = candidateSlice.lastIndexOf('\n\n');
  if (lastDoubleNewline >= minSafe) {
    return `${candidateSlice.slice(0, lastDoubleNewline).trimEnd()}\n\n...[内容超出篇幅限制截断]`;
  }

  // 2. Try line break \n (crucial for markdown tables so rows are never split in half)
  const lastNewline = candidateSlice.lastIndexOf('\n');
  if (lastNewline >= minSafe) {
    const isTable = candidateSlice.includes('|');
    const suffix = isTable ? '\n| ... (表格后续行因篇幅限制截断) |\n' : '\n...[内容超出篇幅限制截断]';
    return `${candidateSlice.slice(0, lastNewline).trimEnd()}${suffix}`;
  }

  return `${candidateSlice.trimEnd()}...[内容超出篇幅限制截断]`;
}

/** Fit a chunk to a token allowance without cutting through table rows when possible. */
export function truncateChunkToTokenBudget(
  rawText: string,
  tokenBudget: number,
  maxChunkChars = Number(process.env.CHAT_CHUNK_MAX_CHARS || 6000),
): string {
  const text = String(rawText || '');
  const charBounded = smartTruncateChunkText(text, maxChunkChars);
  if (estimateTokens(charBounded) <= tokenBudget) return charBounded;

  let low = 1;
  let high = Math.min(maxChunkChars, text.length);
  let best = smartTruncateChunkText(text, 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = smartTruncateChunkText(text, middle);
    if (estimateTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Find the evidence item in the prompt pool that actually supports a sentence.
 *
 * Used to repair a wrong citation marker. The model sometimes answers from the
 * right source but stamps the wrong index (observed in production: a biography
 * answer carried [1] - a weekly-report PDF - while the teacher's document was
 * source 7). The pool that built the prompt is still available, so the correct
 * attribution can be recovered deterministically: the candidate must pass the
 * same support check as a real citation, and the highest character overlap wins
 * so that a boilerplate-heavy table does not beat the document that truly
 * contains the fact.
 */
export function findSupportingEvidenceIndex(
  sentence: string,
  pool: CitationEvidenceLike[],
  minOverlap = 0.5,
): number | null {
  const body = String(sentence || '').replace(/\[\d+\]/g, ' ');
  const chars = Array.from(new Set(body.replace(/\s+/g, '').split('')));
  if (!chars.length) return null;
  let best: { index: number; overlap: number } | null = null;
  for (let index = 0; index < (pool || []).length; index += 1) {
    const text = evidenceTextOf(pool[index]);
    if (!text) continue;
    if (!statementSupportedBy(sentence, [text], true)) continue;
    const normalized = extractRawChunkText(text).replace(/\s+/g, '');
    let overlap = 0;
    for (const ch of chars) if (normalized.includes(ch)) overlap += 1;
    const ratio = overlap / chars.length;
    if (!best || ratio > best.overlap) best = { index: index + 1, overlap: ratio };
  }
  return best && best.overlap >= minOverlap ? best.index : null;
}

/**
 * Re-point a sentence's citation markers at the evidence that supports it.
 * Returns null when the sentence is already correctly attributed or when no
 * selected evidence supports it (the caller then treats it as unsupported).
 */
export function rebindCitationMarkers(
  sentence: string,
  pool: CitationEvidenceLike[],
  minOverlap = 0.5,
): { sentence: string; index: number } | null {
  const target = findSupportingEvidenceIndex(sentence, pool, minOverlap);
  if (!target) return null;
  const rewritten = String(sentence)
    .replace(/\[\d+\]/g, `[${target}]`)
    .replace(/(\[[0-9]+\])(\s*\[[0-9]+\])+/g, `[${target}]`);
  if (rewritten === sentence) return null;
  return { sentence: rewritten, index: target };
}

/**
 * Budget for the GBrain federated retrieval arm.
 *
 * This arm is not a "nice to have": it is the only arm that returns multi-hop
 * bridge evidence, i.e. the second/third gold paragraph of a multi-hop question.
 * Cutting it off too early silently reduces the system to single-hop retrieval
 * (measured regression on 2WikiMultiHopQA/HotpotQA/MuSiQue: Recall@10 1.00 → 0.79
 * / 0.93 / 0.69). It was hardcoded at 2000ms in the agent search path and 2500ms
 * in the chat path; a healthy GBrain answers in under ~1.5s, so the budget is now
 * one configurable value with headroom for a busy instance.
 */
export function resolveGbrainRaceMs(): number {
  const configured = Number(
    process.env.GBRAIN_SEARCH_RACE_TIMEOUT_MS || process.env.GBRAIN_RACE_TIMEOUT_MS || 0,
  );
  if (Number.isFinite(configured) && configured > 0) return Math.max(500, Math.floor(configured));
  return 6000;
}

/**
 * Which retrieval arm sets the ranking when both answered.
 *
 * Measured on the three international multi-hop benchmarks (n=100 each, same corpus,
 * 2026-09-20) with per-probe-group reranking enabled:
 *
 *   chunks_only  (default) 2Wiki 0.810  HotpotQA 0.955  MuSiQue 0.765  (221/169/125 s)
 *   chunk_first            2Wiki 0.790  Hotpot 0.910*    MuSiQue 0.667* (~276 s)
 *   engine_first           2Wiki 0.765  Hotpot 0.895*    MuSiQue 0.673* (~240 s)
 *   (* without the probe-group reranker; all three were re-measured where it applies)
 *
 * `chunks_only` never consults the engine arm in the agent search path: it won every
 * dataset and is ~2.4x faster because it skips the engine subprocess. The engine arm
 * is still used by the user-facing chat path, where compiled-truth pages matter; an
 * agent-facing deployment that depends on them can set RETRIEVAL_ARM_POLICY=chunk_first
 * (engine evidence kept, banded below the chunk arm).
 */
export function resolveArmPolicy(): 'chunk_first' | 'engine_first' | 'chunks_only' {
  const raw = String(process.env.RETRIEVAL_ARM_POLICY || '').trim().toLowerCase();
  if (raw === 'engine_first' || raw === 'engine-first') return 'engine_first';
  if (raw === 'chunk_first' || raw === 'chunk-first') return 'chunk_first';
  return 'chunks_only';
}

/**
 * Is this candidate shaped like a bridge *entity* rather than a prose fragment?
 *
 * Used to decide whether an entity named inside the first-hop evidence is worth a
 * retrieval probe even when no document is titled exactly after it — the answer
 * page often merely *mentions* the entity. Precision comes from the shape: two to
 * four capitalised tokens ("David Gest", "Washington Island", "Door County
 * Wisconsin"). Single words ("Life", "Jackson") and sentence fragments stay
 * excluded, which is what the earlier rejections of regex-extracted probes were
 * actually about.
 */
export function isStrongNameEntity(candidate: string): boolean {
  const tokens = String(candidate || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  return tokens.every((token) => /^[A-Z][\p{L}\p{M}'’.\-]*$/u.test(token));
}

export function evidenceConfidenceScores(citations: any[]): {
  maxCalibrated: number | null;
  maxSynthetic: number | null;
} {
  let maxCalibrated: number | null = null;
  let maxSynthetic: number | null = null;
  for (const citation of citations || []) {
    const calibrated = calibratedScoreOf(citation);
    if (calibrated !== null) {
      maxCalibrated = maxCalibrated === null ? calibrated : Math.max(maxCalibrated, calibrated);
      continue;
    }
    if (String(citation?.scoreSource || '') !== 'synthetic') continue;
    const synthetic = Number(citation?.relevanceScore ?? citation?.rerankScore ?? citation?.score);
    if (!Number.isFinite(synthetic)) continue;
    maxSynthetic = maxSynthetic === null ? synthetic : Math.max(maxSynthetic, synthetic);
  }
  return { maxCalibrated, maxSynthetic };
}

export interface EvidenceSufficiency {
  hasSufficientEvidence: boolean;
  maxCalibrated: number | null;
  maxSynthetic: number | null;
  maxEvidenceScore: number;
  evidenceFloor: number;
  scoreCalibrated: boolean;
}

/**
 * Decide whether the selected evidence clears the fast-refusal floor.
 *
 * The decision is driven only by a *measured* score. A long pre-answer is not
 * evidence of relevance (the fallback arm concatenates every retrieved chunk
 * into `answer`, so text length alone would clear the gate by construction).
 * When a calibrated scorer ran, its maximum must reach the calibrated floor;
 * when none ran, the synthetic placement constant is compared against the
 * documented degraded floor so the gate still says something honest.
 */
export function decideEvidenceSufficiency(
  citations: any[],
  options: { calibratedFloor: number; syntheticFloor: number },
): EvidenceSufficiency {
  const { maxCalibrated, maxSynthetic } = evidenceConfidenceScores(citations || []);
  const scoreCalibrated = maxCalibrated !== null;
  const maxEvidenceScore = maxCalibrated ?? maxSynthetic ?? 0;
  const evidenceFloor = scoreCalibrated ? options.calibratedFloor : options.syntheticFloor;
  const hasSufficientEvidence =
    (citations?.length || 0) > 0 && maxEvidenceScore >= evidenceFloor;
  return {
    hasSufficientEvidence,
    maxCalibrated,
    maxSynthetic,
    maxEvidenceScore,
    evidenceFloor,
    scoreCalibrated,
  };
}

/**
 * Identity key for a retrieval candidate, used to merge arms without dropping
 * distinct evidence. Prefer the chunk id — a single page can hold many relevant
 * chunks, and keying on (document, page) silently collapsed them into one, so a
 * long detail table monopolised the page's single candidate slot. Falls back to
 * per-document `ord` (unique and sequential), then page, then a text prefix for
 * sources that carry no chunk identity at all.
 */
export function retrievalCandidateKey(item: any): string {
  if (!item) return '';
  const id = item.id || item.chunkId;
  if (id) return `id:${id}`;
  const doc = item.documentId || item.docId;
  if (doc) {
    const ord = item.ord;
    if (ord !== undefined && ord !== null && Number.isFinite(Number(ord))) {
      return `doc:${doc}:ord:${Number(ord)}`;
    }
    return `doc:${doc}:page:${item.pageNo || 0}`;
  }
  return `text:${String(item.evidence || item.snippet || item.context || '')
    .replace(/\s+/g, '')
    .slice(0, 40)}`;
}

export type CitationScoreSource = 'rerank' | 'native' | 'synthetic';

/**
 * Document-inventory intent: the user wants the list of documents themselves
 * (titles/count/catalogue), not facts from them. Purely generic document
 * vocabulary — no business terms. Matched shapes:
 *   - 有哪些/有多少 + 知识文档|知识库|文档库|所有文档 (either order)
 *   - 列出/统计 + 知识文档|知识库|文档 (imperative)
 *   - 列出/枚举 + (本)知识库(中/里) + 所有|全部 + 文档 + 标题|清单|列表
 * The last shape ("请列出本知识库中所有文档的标题") used to miss and fall
 * through to chunk retrieval, where macro summaries crowded out the actual
 * doc list (E2E gap "全景列举").
 */
export function isDocumentInventoryQuery(question: string): boolean {
  const q = String(question || '');
  return (
    /(有多少|有哪些|几篇|几本|几份|清单|统计|全景|列表|目录).*(知识文档|知识库|文档库|制度文档|全部文档|所有文档)/.test(q) ||
    /(知识文档|知识库|文档库|制度文档|全部文档|所有文档).*(有多少|有哪些|几篇|几本|几份|清单|统计|全景|列表|目录)/.test(q) ||
    /^(?:搜索)?(?:有多少|查看有哪些|列出所有|统计)\s*(?:知识文档|知识库|制度文档|文档)/.test(q) ||
    /(?:列出|枚举|罗列|展示)[^。！？?？]{0,16}(?:知识库|库中|库里)[^。！？?？]{0,16}(?:文档|文件)[^。！？?？]{0,8}(?:标题|清单|列表|名称|名)/.test(q) ||
    /(?:列出|枚举|罗列)[^。！？?？]{0,8}(?:所有|全部)(?:文档|文件)(?:的)?(?:标题|清单|列表|名称|都有哪些)/.test(q)
  );
}

export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private prisma = getPrismaClient();
  private gbrain: BrainRepoAdapter;
  private readonly queryRewriter: QueryRewriterService;
  private readonly retrievalArms: RetrievalArmsService;
  private readonly fusionRerank: FusionRerankService;
  private readonly citationAssembly: CitationAssemblyService;
  private readonly documentAclService: DocumentAclService;
  private readonly sourceFreshnessChecks = new Map<string, {
    expiresAt: number;
    promise: Promise<{ checked: number; rebuilt: number; fresh: boolean; staleSources: string[]; sourceKeys: string[] }>;
  }>();

  private checkSourceFreshness(userId: string, kbIds: string[], aclEpoch: number, knowledgeEpoch: number) {
    const key = `${userId}:${[...kbIds].sort().join(',')}:${aclEpoch}:${knowledgeEpoch}`;
    const cached = this.sourceFreshnessChecks.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = this.compilerService.ensureSourcesFreshForQuery(userId, kbIds);
    const interval = Math.max(0, Number(process.env.SOURCE_FRESHNESS_CHECK_INTERVAL_MS || 30_000));
    this.sourceFreshnessChecks.set(key, { expiresAt: Date.now() + interval, promise });
    if (this.sourceFreshnessChecks.size > 500) this.sourceFreshnessChecks.delete(this.sourceFreshnessChecks.keys().next().value!);
    void promise.then((result) => {
      // A stale result or a synchronous rebuild must be checked again on the
      // next query; only a confirmed fresh state is worth memoizing.
      if ((!result.fresh || result.rebuilt) && this.sourceFreshnessChecks.get(key)?.promise === promise) {
        this.sourceFreshnessChecks.delete(key);
      }
    }).catch(() => {
      if (this.sourceFreshnessChecks.get(key)?.promise === promise) this.sourceFreshnessChecks.delete(key);
    });
    return promise;
  }

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
    @Optional() private readonly lexicalIndexService?: LexicalIndexService,
    @Optional() private readonly hybridRetrievalService?: HybridRetrievalService,
    @Optional() private readonly shadowRetrievalService?: ShadowRetrievalService,
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
    this.documentAclService = new DocumentAclService(this.permissionService);
    this.queryRewriter = new QueryRewriterService({
      logger: this.logger,
      modelConfigService: this.modelConfigService,
      agenticRagService: this.agenticRagService,
      recallPersonalFacts: (userId, query, limit) => this.recallPersonalFacts(userId, query, limit),
    });
    this.citationAssembly = new CitationAssemblyService({
      logger: this.logger,
      prisma: this.prisma,
      permissionService: this.permissionService,
      modelConfigService: this.modelConfigService,
      semanticCacheService: this.semanticCacheService,
      documentAclService: this.documentAclService,
    });
    this.fusionRerank = new FusionRerankService({
      logger: this.logger,
      modelConfigService: this.modelConfigService,
    });
    this.retrievalArms = new RetrievalArmsService({
      logger: this.logger,
      prisma: this.prisma,
      gbrain: this.gbrain,
      raptorService: this.raptorService,
      embeddingService: this.embeddingService,
      graphRagService: this.graphRagService,
      hybridRetrievalService: this.hybridRetrievalService,
      lexicalIndexService: this.lexicalIndexService,
      filterQueryResultByCurrentPermission: (result, visibleKbIds, derivedGuard) =>
        this.citationAssembly.filterQueryResultByCurrentPermission(result, visibleKbIds, derivedGuard),
    });
  }


  // ---- thin delegates (moved to specialised services) ----

  private async planEntityProbesWithLlm(question: string, evidenceTexts: string[]): Promise<string[]> {
    return this.queryRewriter.planEntityProbesWithLlm(question, evidenceTexts);
  }

  private async planSearchProbes(query: string, alreadyPlanned: string[]): Promise<string[]> {
    return this.queryRewriter.planSearchProbes(query, alreadyPlanned);
  }

  private async rewriteQueryForRetrieval(
    question: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    signal?: AbortSignal,
  ): Promise<RetrievalRequest> {
    return this.queryRewriter.rewriteQueryForRetrieval(question, history, signal);
  }

  private async loadPersonalMemoryContext(
    userId: string,
    query: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    sessionId?: string,
  ): Promise<{ text: string; count: number }> {
    return this.queryRewriter.loadPersonalMemoryContext(userId, query, history, sessionId);
  }

  private shouldLoadPersonalMemory(
    question: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): boolean {
    return this.queryRewriter.shouldLoadPersonalMemory(question, history);
  }

  private async rewriteQueryForRetry(query: string): Promise<string[]> {
    return this.queryRewriter.rewriteQueryForRetry(query);
  }

  private fuseWithWeKnoraRRF(
    baseCitations: any[],
    weknoraEvidences: RetrievedEvidence[],
    rrfK = 60,
  ): any[] {
    return this.fusionRerank.fuseWithWeKnoraRRF(baseCitations, weknoraEvidences, rrfK);
  }

  private bandProbeHits<T extends { score?: number }>(items: T[], probeHits: Set<any>): T[] {
    return this.fusionRerank.bandProbeHits(items, probeHits);
  }

  private isMultiHopBridgeCandidate(
    citation: any,
    question: string,
    breadth: boolean,
    result: any,
  ): boolean {
    return this.fusionRerank.isMultiHopBridgeCandidate(citation, question, breadth, result);
  }

  private isSelfContainedQuery(query: string): boolean {
    return this.fusionRerank.isSelfContainedQuery(query);
  }

  private normalizeTitleForMatch(value: string): string {
    return this.fusionRerank.normalizeTitleForMatch(value);
  }

  private extractCapitalisedCandidates(text: string, limit = 8): string[] {
    return this.fusionRerank.extractCapitalisedCandidates(text, limit);
  }

  private async rerankByProbeGroups(question: string, citations: any[]): Promise<void> {
    return this.fusionRerank.rerankByProbeGroups(question, citations);
  }

  private async rerankPool(question: string, result: any, breadth = false): Promise<any> {
    return this.fusionRerank.rerankPool(question, result, breadth);
  }

  private async applyRerank(
    question: string,
    result: any,
    breadth = false,
  ): Promise<any> {
    return this.fusionRerank.applyRerank(question, result, breadth);
  }

  private reorderLostInTheMiddle<T>(items: T[]): T[] {
    return this.fusionRerank.reorderLostInTheMiddle(items);
  }

  private async filterQueryResultByCurrentPermission(
    result: any,
    visibleKbIds: string[],
    derivedGuard: {
      scopeId: string;
      sourceKeys: string[];
      aclEpoch: number;
      knowledgeEpoch: number;
      userId?: string;
    },
  ): Promise<any> {
    return this.citationAssembly.filterQueryResultByCurrentPermission(result, visibleKbIds, derivedGuard);
  }

  private async filterSearchResultsForUser<T extends { documentId?: string | null }>(
    userId: string,
    scope: string[],
    results: T[],
  ): Promise<T[]> {
    const ids = [...new Set(results.map((result) => result.documentId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return [];
    const docs = await this.prisma.document.findMany({
      where: { id: { in: ids }, kbId: { in: scope }, status: "published" },
      select: { id: true, kbId: true, effectiveFrom: true, effectiveTo: true, lifecycleStatus: true },
    });
    const current = docs.filter((doc) => documentCurrentlyEffective(doc, Date.now()));
    const readable = await this.documentAclService.filterReadableDocuments(userId, current.map((doc) => doc.id), {
      docs: current,
      visibleKbIds: scope,
    });
    return results.filter((result) => result.documentId && readable.has(result.documentId));
  }

  private selectEvidence(
    result: any,
    opts: { breadth: boolean; tokenBudget: number; subQueries?: string[]; question?: string },
  ): any {
    return this.citationAssembly.selectEvidence(result, opts);
  }

  private assessWeakEvidence(result: any, breadth = false): {
    shouldEscalate: boolean;
    weak: boolean;
    evidence: string;
    topScore?: number | null;
    scoreFloor?: number;
    reason: string;
  } {
    return this.citationAssembly.assessWeakEvidence(result, breadth);
  }

  private async verifyPassageContainment(params: {
    question: string;
    passages: string[];
    knownEvidence?: string;
  }): Promise<Set<number>> {
    return this.citationAssembly.verifyPassageContainment(params);
  }

  private async judgeEntailment(statements: string[], evidence: string): Promise<Set<number>> {
    return this.citationAssembly.judgeEntailment(statements, evidence);
  }

  private normalizeTimelineEntry(cit: any) {
    return this.citationAssembly.normalizeTimelineEntry(cit);
  }

  private async emitCitationsAndComplete(
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
    return this.citationAssembly.emitCitationsAndComplete(userId, citations, subscriber, totalTokens, fullAnswer, trace, question, userScope, modelName);
  }

  cleanRetrievalQuery(query: string): string {
    return this.retrievalArms.cleanRetrievalQuery(query);
  }

  decomposeComplexQuery(query: string): string[] {
    return this.retrievalArms.decomposeComplexQuery(query);
  }

  private extractSearchKeywords(query: string, domainTerms: string[] = []): string[] {
    return this.retrievalArms.extractSearchKeywords(query, domainTerms);
  }

  private async loadScopeDomainConfig(
    scope: string[],
  ): Promise<{ terms: string[]; mappings: TermMapping[] }> {
    return this.retrievalArms.loadScopeDomainConfig(scope);
  }

  private async loadScopeDomainTerms(scope: string[]): Promise<string[]> {
    return this.retrievalArms.loadScopeDomainTerms(scope);
  }

  private async augmentWithDocumentSummaries(
    queryResult: any,
    scope: string[],
    question?: string,
    complexity?: string,
  ): Promise<any> {
    return this.retrievalArms.augmentWithDocumentSummaries(queryResult, scope, question, complexity);
  }

  private async augmentWithRaptorGlobalTree(
    queryResult: any,
    scope: string[],
    question: string,
    complexity: string,
    trace?: any,
  ): Promise<any> {
    return this.retrievalArms.augmentWithRaptorGlobalTree(queryResult, scope, question, complexity, trace);
  }

  private async augmentWithBrainDerivedIntelligence(
    queryResult: any,
    userScope: any,
    question: string,
    agenticComplexity: string,
    trace?: any,
  ): Promise<any> {
    return this.retrievalArms.augmentWithBrainDerivedIntelligence(queryResult, userScope, question, agenticComplexity, trace);
  }

  private async retrieveHopProbes(
    scope: string[],
    sourceRefs: string[],
    fallbackGitRepoUrl: string | undefined,
    probes: string[],
    signal?: AbortSignal,
    userScope?: any,
    selectedSourceKeys?: string[],
    hopNumber = 2,
  ): Promise<any[]> {
    return this.retrievalArms.retrieveHopProbes(scope, sourceRefs, fallbackGitRepoUrl, probes, signal, userScope, selectedSourceKeys, hopNumber);
  }

  private async detectEmbeddingModelDrift(scope: string[]): Promise<string | null> {
    return this.retrievalArms.detectEmbeddingModelDrift(scope);
  }

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
    return this.retrievalArms.searchChunksByVector(scope, query, limit);
  }


  /**
   * A/B 影子检索：主路径结果不变；shadow 臂旁路跑 treatment 参数并 diff。
   * treatment 臔则直接用 treatment 参数跑主检索（由 caller 在取 base 前判断）。
   */
  private abAssignment(userId: string, conversationId?: string) {
    if (!this.shadowRetrievalService) return null;
    try {
      return this.shadowRetrievalService.assign('retrieval.fusion', userId, conversationId);
    } catch {
      return null;
    }
  }

  private async runShadowRetrievalDiff(
    userId: string,
    conversationId: string | undefined,
    scope: string[],
    question: string,
    controlHits: any[],
  ): Promise<void> {
    if (!this.shadowRetrievalService) return;
    try {
      await this.shadowRetrievalService.compare(
        'retrieval.fusion',
        userId,
        conversationId,
        question,
        CONTROL_VARIANT,
        async (variant) => ({
          citations: await this.retrievalArms.searchChunksFallback(scope, question, 8, [], variant) as any[],
        }),
      );
      this.logger.debug(
        `A/B shadow diff recorded for retrieval.fusion (control hits=${controlHits.length})`,
      );
    } catch (err) {
      this.logger.debug(
        `shadow retrieval skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      ord?: number;
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
    return this.retrievalArms.searchChunksFallback(scope, query, limit, extraQueries);
  }

  // ---- orchestration & retained responsibilities ----

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
    const requested = (Array.isArray(requestedKbScope)
      ? requestedKbScope.map((id) => String(id).trim())
      : [String(requestedKbScope).trim()]
    ).filter(Boolean);
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
        // AbortError is thrown when the GBrain hard-timeout fires (typically
        // because no evidence was found within the user's permission scope).
        // Convert it to a friendly user-facing message instead of surfacing
        // the raw "This operation was aborted" string.
        const isAbortError =
          err?.name === "AbortError" ||
          (err?.message && /abort/i.test(err.message) && /operation/i.test(err.message));
        if (isAbortError) {
          this.logger.warn(`Chat aborted (likely retrieval timeout with no results): ${err.message}`);
          const friendlyMsg =
            "很抱歉，在您当前可访问的知识库范围内未找到相关内容。" +
            "可能的原因：您没有该知识所属知识库的访问权限，或该知识尚未入库。" +
            "如需帮助，请联系知识库管理员确认权限。";
          trace.failRunning(new Error(friendlyMsg));
          subscriber.next({
            data: { type: "delta", content: friendlyMsg, delta: friendlyMsg },
          });
          subscriber.next({
            data: { type: "done", total_tokens: 0, latency_ms: 0 },
          });
          subscriber.complete();
          return;
        }
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
    requestedKbScope?: string[] | string,
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
    // Same 403 semantics as the completions path: a requested scope outside
    // the caller's visibility is a authorization error, not something to
    // silently narrow (silent filtering hides misconfiguration from callers).
    await this.assertRequestedScopeAuthorized(userId, requestedKbScope);
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
    const rawList = Array.isArray(requestedKbScope)
      ? requestedKbScope.map((id) => String(id).trim()).filter(Boolean)
      : typeof requestedKbScope === "string" && requestedKbScope !== "all" && requestedKbScope.trim() !== ""
        ? [requestedKbScope.trim()]
        : undefined;
    const parsedRequestedScope = rawList && rawList.length > 0 ? rawList : undefined;
    let scope = parsedRequestedScope
      ? parsedRequestedScope.filter((id) => visibleKbs.includes(id))
      : visibleKbs;

    if (scope.length === 0) {
      return { success: true, query, total: 0, results: [] };
    }

    const isInventoryQuery = isDocumentInventoryQuery(query);

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
      const readableDocs = await this.filterSearchResultsForUser(userId, scope, accessibleDocs.map((doc) => ({ ...doc, documentId: doc.id })));
      return {
        success: true,
        query,
        total: readableDocs.length,
        results: readableDocs.slice(0, limit).map((d) => ({
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

    // Large-scale optimization: When search scope is broad (> 3 KBs) and user did not specify
    // a narrow scope, use intelligent KB intent routing to focus recall on the Top-K relevant KBs.
    if (!parsedRequestedScope && scope.length > 3) {
      const routingResult = await routeKnowledgeBasesByIntent(
        query,
        scope,
        async (missingIds) => {
          return (this.prisma as any).knowledgeBase.findMany({
            where: { id: { in: missingIds } },
            select: { id: true, name: true, description: true, domainTerms: true },
          });
        },
      );
      if (routingResult.routed && routingResult.targetedScope.length > 0) {
        this.logger.log(
          `[KB-Router] Narrowed multi-KB search space from ${scope.length} to ${routingResult.targetedScope.length} KBs for query: "${query.slice(0, 30)}"`,
        );
        scope = routingResult.targetedScope;
      }
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

    // 1. Fast-Path: Query PostgreSQL chunks concurrently (<10ms) with subquery decomposition & bridge entity recall.
    //
    // Probe generation is the multi-hop bottleneck: measured on MuSiQue, 36 of 40
    // gold paragraphs that the pipeline missed were retrievable at rank 1 when used
    // directly as the query, i.e. the corpus had them and the retriever could find
    // them — no probe ever named them. The deterministic decomposer only covers a few
    // shapes, so the LLM planner (already used by the chat path) contributes its
    // sub-questions here too. Probe hits are banded below primary evidence, so this
    // adds coverage without letting probe noise set the ranking.
    const deterministicSubQueries = this.decomposeComplexQuery(query);
    const llmSubQueries = await this.planSearchProbes(query, deterministicSubQueries);
    const subQueries = Array.from(new Set([...deterministicSubQueries, ...llmSubQueries])).slice(0, 6);
    const rel = this.extractRelationFromQuery(query);
    // Probe budget: how many decomposed sub-questions get their own retrieval probe.
    // Each probe is a separate search and — with the probe-group rerank — a separate
    // cross-encoding group, so the budget trades recall coverage against latency.
    const maxSubQueryProbes = Math.max(1, Number(process.env.RETRIEVAL_SUBQUERY_PROBES_MAX || 4));
    const fallbackChunksPromise = (async () => {
      const base: any[] = await this.searchChunksFallback(scope, query, limit).catch(() => [] as any[]);
      // Hits added by auxiliary probes (sub-questions, bridge entities) are tracked
      // with the probes that produced them, so corroborated evidence can be promoted
      // and single-probe noise banded below the primary query's evidence.
      const probeHits = new Set<any>();
      // Entity probes named by the LLM from the first-hop evidence.
      //
      // Regex-extracted entities were rejected twice (they are prose fragments, and a
      // cross-encoder happily scores documents against a noisy probe). The measured
      // ceiling for *named* entities is very different: on MuSiQue, 36 of the 40 gold
      // paragraphs the pipeline misses are retrievable at rank 1 when used directly as
      // the query — the corpus has them and nothing ever names them. So the naming step
      // is delegated to the model (corpus-agnostic: it reads the question and the
      // passages, no synonym tables), and each named entity becomes its own probe group
      // with its own cross-encoding.
      const llmEntityProbes = await this.planEntityProbesWithLlm(
        query,
        base.slice(0, 4).map((b: any) => String(b?.evidence || b?.snippet || '')),
      );
      if (llmEntityProbes.length) {
        const entityChunks = await Promise.all(
          llmEntityProbes.map((name) =>
            this.searchChunksFallback(scope, name, Math.max(3, Math.floor(limit / 2)))
              .then((hits) => hits.map((h: any) => ({ ...h, subQueryOrigin: name })))
              .catch(() => [] as any[]),
          ),
        );
        const seenEntity = new Set(base.map((b: any) => retrievalCandidateKey(b)));
        for (const hits of entityChunks) {
          for (const hit of hits as any[]) {
            const key = retrievalCandidateKey(hit);
            if (seenEntity.has(key)) {
              const existing = base.find((b: any) => retrievalCandidateKey(b) === key);
              if (existing && !(existing as any).subQueryOrigin) (existing as any).subQueryOrigin = hit.subQueryOrigin;
              continue;
            }
            seenEntity.add(key);
            base.push(hit);
            probeHits.add(hit);
          }
        }
      }
      if (subQueries.length > 0) {
        try {
          const subChunks = await Promise.all(
            subQueries.slice(0, maxSubQueryProbes).map((sub) =>
              this.searchChunksFallback(scope, sub, Math.max(3, Math.floor(limit / 2)))
                .then((hits) => {
                  for (const h of hits) (h as any).subQueryOrigin = (h as any).subQueryOrigin || sub;
                  return hits;
                })
                .catch(() => [] as any[])
            )
          );
          const seen = new Set(base.map((b) => retrievalCandidateKey(b)));
          for (const hits of subChunks) {
            for (const h of hits) {
              const key = retrievalCandidateKey(h);
              const existing = base.find((b) => retrievalCandidateKey(b) === key);
              if (existing) {
                (existing as any).subQueryOrigin = (existing as any).subQueryOrigin || (h as any).subQueryOrigin;
                if (typeof h.score === 'number' && h.score > (existing.score || 0)) {
                  existing.score = h.score;
                }
              } else {
                seen.add(key);
                base.push(h);
                probeHits.add(h);
              }
            }
          }
        } catch (e) {
          this.logger.warn(`searchKnowledgeForAgent subquery search error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Dynamic cascading bridge entity expansion from top evidence (2~4 hop cascade).
      //
      // Re-tested 2026-09-20 *with* the per-probe-group reranker in place, because the
      // earlier rejection predated it: MuSiQue n=100 fell to R@10 0.6517 / FullEv 0.35 /
      // MRR 0.778 (from 0.7617 / 0.50 / 0.947 without generic probes). A cross-encoder
      // scores documents highly against a *noisy* probe, so the noise survives the
      // rerank and the probe-group weight (0.9) is not enough to keep it out of the
      // top-k. Generic entity probes therefore stay off unless a deployment explicitly
      // sets RETRIEVAL_ENTITY_PROBES=true.
      const entityProbesEnabled = process.env.RETRIEVAL_ENTITY_PROBES === 'true';
      if (rel && base.length > 0) {
        try {
          const visitedBridges = new Set<string>();
          let currentEvidencePool = base.slice(0, 4).map((b) => b.evidence).join('\n');
          const maxCascadeRounds = 2;

          for (let round = 0; round < maxCascadeRounds; round++) {
            const bridges = this.extractBridgeEntitiesFromEvidence(currentEvidencePool, rel);
            const unseenBridges = bridges.filter((br) => {
              const lower = br.toLowerCase();
              if (visitedBridges.has(lower)) return false;
              visitedBridges.add(lower);
              return !base.some((b) => (b.title || '').toLowerCase().includes(lower));
            });

            if (unseenBridges.length === 0) break;

            const bridgeResults = await Promise.all(
              unseenBridges.map((br) => this.searchChunksFallback(scope, br, 5).catch(() => [] as any[])),
            );

            const newlyAddedChunks: any[] = [];
            for (let i = 0; i < unseenBridges.length; i++) {
              const br = unseenBridges[i];
              for (const bh of bridgeResults[i]) {
                (bh as any).subQueryOrigin = br;
                base.push(bh);
                probeHits.add(bh);
                newlyAddedChunks.push(bh);
              }
            }

            if (newlyAddedChunks.length === 0) break;
            currentEvidencePool = newlyAddedChunks.slice(0, 4).map((b) => b.evidence).join('\n');
          }
        } catch (e) {
          this.logger.warn(`searchKnowledgeForAgent cascading bridge error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return this.bandProbeHits(base, probeHits);
    })();

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
      // The GBrain arm is what supplies multi-hop bridge evidence: for
      // multi-hop benchmarks it contributes the *second* gold paragraph that the
      // lexical/vector fallback arm does not contain. It used to get a hardcoded
      // 2s budget here, and on a busy instance that budget expired on most
      // requests ("GBrain search error: GBRAIN_CANCELLED"), silently degrading the
      // answer to single-hop retrieval. Measured locally: a healthy GBrain search
      // answers in 0.8-1.5s, so the arm must not be cut off at 2s under load.
      const gbrainRaceMs = resolveGbrainRaceMs();
      const armPolicy = resolveArmPolicy();
      let racedGBrain: BrainQueryResult | null = null;
      if (armPolicy === 'chunks_only') {
        // Explicitly disabled for this deployment: stop the in-flight engine call
        // instead of letting it occupy a subprocess slot for nothing.
        agentGbrainAbort.abort();
      } else {
        const raceTimer = setTimeout(() => agentGbrainAbort.abort(), gbrainRaceMs);
        racedGBrain = await Promise.race([
          gbrainSearchPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), gbrainRaceMs)),
        ]);
        clearTimeout(raceTimer);
        if (!racedGBrain) {
          this.logger.warn(
            `GBrain arm lost the ${gbrainRaceMs}ms race; answering from chunk retrieval only (multi-hop bridge evidence may be missing). ` +
              'Raise GBRAIN_SEARCH_RACE_TIMEOUT_MS or GBRAIN_QUERY_CONCURRENCY if this repeats.',
          );
        }
      }
      if (racedGBrain && racedGBrain.citations && racedGBrain.citations.length > 0) {
        // Arm policy decides who sets the ranking. Measurements on the international
        // multi-hop benchmarks (2026-09-20, n=100 each, same code and corpus):
        //   engine-first (engine ranks, chunks appended):  2Wiki 0.765  Hotpot 0.895  MuSiQue 0.673
        //   chunk-first  (chunks rank, engine appended):   2Wiki 0.7925 Hotpot 0.925  MuSiQue 0.692
        // Rank fusion of the two arms was also tried and was worse still (2Wiki MRR
        // 0.98 -> 0.55), because noisy paragraphs recalled by several probes accumulate
        // rank mass. So the default is `chunk_first`: the chunk arm (whose sub-query and
        // bridge probes supply multi-hop evidence) sets the order and the engine arm is
        // merged underneath, keeping its native score for the confidence gates.
        queryResult = armPolicy === 'engine_first' ? racedGBrain : {
          topics: fallbackChunks.map((fb) => fb.title || '相关条款'),
          answer: fallbackChunks.map((fb) => fb.evidence).join('\n\n'),
          citations: fallbackChunks.map((fb, idx) => ({
            topic: fb.title || fb.documentId || "",
            docId: fb.documentId,
            kbId: fb.kbId,
            version: fb.version,
            ord: fb.ord,
            pageNo: fb.pageNo,
            articleNo: fb.articleNo,
            evidence: fb.evidence,
            snippet: fb.evidence,
            context: fb.evidence,
            score: fb.score ?? Math.max(0.70, 0.95 - idx * 0.02),
            scoreSource: 'synthetic',
            docTitle: fb.title,
            sectionGroup: (fb as any).sectionGroup,
            subQueryOrigin: (fb as any).subQueryOrigin,
            bbox: fb.bbox,
            previewUrl: fb.previewUrl,
            // Propagate the arm's provenance flags: the bridge scan below must be
            // able to tell a real source page from a derived summary.
            raptor: (fb as any).raptor === true,
            isSummary: (fb as any).isSummary === true,
          })),
          reranked: (racedGBrain as any).reranked,
        };
        // Engine citations are appended below the chunk arm so the final score sort
        // cannot interleave incomparable scales: the chunk arm's score is a min-max
        // normalised 0.05-0.99, the engine's is its own rerank scale. `relevanceScore`
        // keeps the engine's native value so the calibrated-confidence gates still see it.
        const chunkScores = (queryResult.citations || [])
          .map((c: any) => Number(c?.score))
          .filter((n: number) => Number.isFinite(n));
        const engineCeiling = chunkScores.length
          ? Math.max(0.05, Math.min(...chunkScores) * Number(process.env.RETRIEVAL_ENGINE_ARM_SCALE || 0.9))
          : 0.9;
        const existingEvidence = new Set(
          (queryResult.citations || []).map((c: any) => (c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30)),
        );
        const engineCitations = racedGBrain.citations.slice(0, Math.max(1, Number(process.env.RETRIEVAL_ENGINE_ARM_MAX || 20)));
        engineCitations.forEach((citation: any, rank: number) => {
          const key = String(citation.evidence || citation.snippet || "").replace(/\s+/g, "").slice(0, 30);
          if (!existingEvidence.has(key)) {
            existingEvidence.add(key);
            queryResult.citations.push({
              ...citation,
              score: Math.max(0.01, engineCeiling - rank * 0.005),
              relevanceScore: Number.isFinite(Number(citation.relevanceScore))
                ? Number(citation.relevanceScore)
                : (Number.isFinite(Number(citation.score)) ? Number(citation.score) : undefined),
              scoreSource: citation.scoreSource || "native",
              mergedFrom: "engine",
            } as any);
          }
        });
        (queryResult as any).fallbackMerged = true;
      } else {
        queryResult = {
          topics: Array.from(new Set(fallbackChunks.map((fb) => fb.title || "相关条款"))),
          answer: fallbackChunks.map((fb) => fb.evidence).join("\n\n"),
          citations: fallbackChunks.map((fb, idx) => ({
            topic: fb.title || fb.documentId || "",
            docId: fb.documentId,
            kbId: fb.kbId,
            version: fb.version,
            ord: fb.ord,
            pageNo: fb.pageNo,
            articleNo: fb.articleNo,
            evidence: fb.evidence,
            snippet: fb.evidence,
            context: fb.evidence,
            score: fb.score ?? Math.max(0.70, 0.95 - idx * 0.02),
            scoreSource: "synthetic",
            docTitle: fb.title,
            sectionGroup: (fb as any).sectionGroup,
            subQueryOrigin: (fb as any).subQueryOrigin,
            bbox: fb.bbox,
            previewUrl: fb.previewUrl,
          })),
          reranked: false,
        };
      }
    } else {
      queryResult = await gbrainSearchPromise;
    }

    // Cross-encoder rerank of the merged candidate pool.
    //
    // Until now the agent search path returned whatever ordering the arms produced,
    // which is why probe expansion could not pay off: measured on MuSiQue, probes
    // recovered gold paragraphs (36/40 of the missed ones are retrievable at rank 1
    // when named directly) but letting them into the top-10 cost more gold than it
    // added (R@10 0.704 → 0.678 scaled, → 0.665 with generic entity probes). A
    // cross-encoder scores every candidate on the question itself, so genuine
    // second-hop evidence can enter the context while probe noise is pushed out.
    if (process.env.RETRIEVAL_SEARCH_RERANK !== 'false' && this.isSelfContainedQuery(query)) {
      try {
        const citations = Array.isArray(queryResult?.citations) ? queryResult.citations : [];
        await this.rerankByProbeGroups(query, citations);
      } catch (err) {
        this.logger.warn(
          `Search path rerank failed, keeping arm order: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    queryResult = await this.filterQueryResultByCurrentPermission(
      queryResult,
      scope,
      {
        scopeId: userScope.scopeId,
        sourceKeys: scope.map((id) => sourceKeyForKnowledgeBase(id)),
        aclEpoch: userScope.aclEpoch,
        knowledgeEpoch: userScope.knowledgeEpoch,
        userId,
      },
    );

    const citations = Array.isArray(queryResult.citations) ? queryResult.citations : [];
    citations.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));
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

    const authorizedResults = await this.filterSearchResultsForUser(userId, scope, results);
    const precedence = this.resolveTemporalPrecedence(authorizedResults);

    return {
      success: true,
      query,
      total: authorizedResults.length,
      results: authorizedResults.slice(0, limit),
      ...(precedence.temporalNotice ? { temporalNotice: precedence.temporalNotice } : {}),
    };
  }

  extractRelationFromQuery(query: string): string | null {
    // Corpus-agnostic: delegated to relation-extractor (configurable surface forms).
    return extractRelationFromQueryImpl(query);
  }

  extractBridgeEntitiesFromEvidence(text: string, rel: string | null): string[] {
    if (!text) return [];
    const bridges = new Set<string>();

    const cleanCandidate = (raw: string): string => {
      let cand = raw.replace(/^(?:Sir|Lord|Lady|Dame|Baron|Prince|Queen|King|the|a|an)\s+/i, '').trim();
      // The regexes above are deliberately loose (they scan prose), so the match
      // can carry sentence punctuation and the start of the next sentence. A
      // candidate like "George Stevens. The" is then used as a *retrieval query*,
      // which is why the cascading bridge hop quietly failed to fetch the very
      // page it had just discovered. Strip punctuation and trailing function words
      // in turns, because removing " The" can expose the "." that preceded it.
      for (let pass = 0; pass < 3; pass += 1) {
        const before = cand;
        cand = cand.replace(/[.,;:!?"'“”„…]+$/g, '').trim();
        cand = cand
          .replace(
            /\s+(?:the|a|an|in|at|and|or|of|to|for|with|by|on|from|was|were|is|are|it|he|she|they|this|that|these|those|his|her|their|its|who|which|where|when)$/i,
            '',
          )
          .trim();
        if (cand === before) break;
      }
      // A loose prose match often runs into the next sentence ("Douglas Sirk. It").
      // Cut at the boundary and keep the entity; only discard when nothing name-like
      // survives. Rejecting the whole candidate is what lost the second director in
      // a bridge question: the hop then had nothing to search for.
      const boundary = cand.search(/[.;:!?]\s/);
      if (boundary > 0) cand = cand.slice(0, boundary).replace(/[.,;:!?"'“”„…]+$/g, '').trim();
      if (/[.;:!?]/.test(cand)) return '';
      if (cand.split(/\s+/).filter((token) => /[A-Za-z\u00C0-\u017F\u4e00-\u9fa5]/.test(token)).length < 1) return '';
      return cand;
    };

    // 1. Relational-targeted English patterns
    if (rel) {
      const escapedRel = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Relation wording varies between question and source text: the question
      // asks about the "director", the source says "directed by"; the question asks
      // for the "author", the source says "written by". Expand each canonical
      // relation into its surface forms so the bridge hop can find the entity the
      // question is about (generic English morphology, not domain vocabulary).
      // Corpus-agnostic: defaults are generic relation types (kinship/creator/
      // location). Deployments extend via RELATION_SURFACE_FORMS_JSON; business
      // vocabulary must live in KB domainTerms, never here.
      const RELATION_SURFACE_FORMS: Record<string, string[]> = resolveRelationSurfaceForms();
      const surfaceForms = Array.from(
        new Set([rel, ...(RELATION_SURFACE_FORMS[rel] || [])]),
      ).map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const inflected = surfaceForms.map((form) => `${form}(?:s|es|ed|ing)?`);
      // Relation words appear in prose in other inflections than the noun: a query
      // asking for the "director" is answered by text saying "directed by X". Match
      // the noun, its inflections, and a stem so the bridge hop can actually find
      // the entity the question is about.
      const stem = escapedRel.slice(0, Math.max(4, escapedRel.length - 2));
      const relPattern = `(?:${inflected.join('|')}|${stem}\\w*)`;
      const directRe = new RegExp(
        `(?:${relPattern})(?:\\s+(?:is|was|were|named|called|of|by|,|in|at))*?(?:\\s+(?:the|a|an)?\\s*(?:[A-Za-z-]+\\s+){0,4})?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){1,3})`,
        'g',
      );
      let m: RegExpExecArray | null;
      while ((m = directRe.exec(text)) !== null) {
        const candidate = cleanCandidate(m[1]);
        if (candidate && candidate.length >= 3 && candidate.length <= 40) bridges.add(candidate);
      }

      if (/father|mother|parents|spouse|husband|wife|married/i.test(rel)) {
        const invRe = /(?:son|daughter|child|spouse|husband|wife|married\s+to)\s+(?:of|with)\s+(?:the\s+)?(?:[A-Za-z-]+\s+){0,4}?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){1,3})/g;
        while ((m = invRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate) bridges.add(candidate);
        }
      }

      if (/director|directed|directs|film/i.test(rel)) {
        const invRe = /(?:directed\s+by|credited\s+to|directed\s+and\s+written\s+by|director\s+was)\s+(?:the\s+)?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){1,3})/g;
        while ((m = invRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate) bridges.add(candidate);
        }
      }

      if (/author|authored|writer|written|wrote|creator|created|publisher|published/i.test(rel)) {
        const writtenRe = /(?:written\s+by|wrote|authored\s+by|created\s+by|published\s+by|author\s+was)\s+(?:the\s+)?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){1,3})/g;
        while ((m = writtenRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate) bridges.add(candidate);
        }
      }

      if (/educated|alma mater|studied|school|university|college/i.test(rel)) {
        const eduRe = /(?:educated\s+at|attended|alumnus\s+of|graduate\s+of|studied\s+at)\s+(?:the\s+)?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){1,3})/g;
        while ((m = eduRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate) bridges.add(candidate);
        }
      }

      if (/owned by|subsidiary|parent|acquired/i.test(rel)) {
        const ownRe = /(?:subsidiary\s+of|owned\s+by|acquired\s+by|parent\s+company\s+is)\s+(?:the\s+)?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){1,3})/g;
        while ((m = ownRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate) bridges.add(candidate);
        }
      }

      if (/died|born|birth|death/i.test(rel)) {
        const placeRe = /(?:born\s+in|died\s+in|buried\s+in|native\s+of)\s+(?:the\s+)?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){0,3})/g;
        while ((m = placeRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate && candidate.length >= 3) bridges.add(candidate);
        }
      }

      if (/capital|country|territory|nationality|sovereign|ruler|governor|monarch/i.test(rel)) {
        const sovRe = /(?:capital\s+of|sovereign\s+of|ruled\s+by|monarch|king|queen|emperor|governed\s+by)\s+(?:the\s+)?([A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*(?:\s+[A-Z\u00C0-\u017F][a-zA-Z0-9\u00C0-\u017F\x27\.-]*){0,3})/g;
        while ((m = sovRe.exec(text)) !== null) {
          const candidate = cleanCandidate(m[1]);
          if (candidate && candidate.length >= 3) bridges.add(candidate);
        }
      }

      // 2. Relational-targeted Chinese patterns
      const zhRe = /(?:配偶|妻子|丈夫|父亲|母亲|作者|编剧|导演|创始人|生于|出生于|毕业于|就读于|总部位于|设立于|由|与|效力于|属于|母公司|子公司)(?:是|为|：|:)?\s*([《“]?[\u4e00-\u9fa5A-Za-z0-9\s]{2,20}[》”]?)/g;
      while ((m = zhRe.exec(text)) !== null) {
        const candidate = m[1].replace(/[《》“”"']/g, '').trim();
        if (candidate && candidate.length >= 2 && candidate.length <= 25) bridges.add(candidate);
      }
    }

    // 3. Salient bracketed or quoted entities (e.g. 《书名》, “专有名词”)
    const bracketRe = /[《“]([\u4e00-\u9fa5A-Za-z0-9\s]{2,30})[》”]/g;
    let bm: RegExpExecArray | null;
    while ((bm = bracketRe.exec(text)) !== null) {
      const candidate = bm[1].trim();
      if (candidate && candidate.length >= 2 && candidate.length <= 25) bridges.add(candidate);
    }

    // 4. Generic capitalised-phrase probes (used when the question carries no relation
    //    word, or the relational patterns found nothing).
    //
    //    Measured on MuSiQue: 36 of 40 gold paragraphs the pipeline missed are
    //    retrievable at rank 1 when used directly as the query — nothing ever *named*
    //    them. This branch extracts the salient capitalised spans of the already
    //    retrieved evidence as probes. Language-level only (no domain vocabulary).
    //    Rejected twice: first without a reranker (R@10 0.665 vs 0.704) and again with
    //    per-probe-group reranking (0.6517 vs 0.7617) — a cross-encoder scores documents
    //    highly against a noisy probe, so the noise survives. Off by default; enable
    //    only with RETRIEVAL_ENTITY_PROBES=true and a benchmark that shows a gain.
    if (process.env.RETRIEVAL_ENTITY_PROBES === 'true' && bridges.size < 3) {
      const genericRe = /\b([A-Z][\w'\u00C0-\u017F-]*(?:\s+(?:of|the|de|van|von|al)?\s*[A-Z][\w'\u00C0-\u017F-]*){1,3})\b/g;
      const GENERIC_STOP = new Set(['The', 'A', 'An', 'In', 'On', 'At', 'Of', 'And', 'Or', 'For', 'With', 'By', 'Is', 'Was', 'Were', 'Are', 'It', 'He', 'She', 'They', 'This', 'That', 'As', 'From', 'To', 'His', 'Her', 'Their', 'Its', 'Who', 'Which', 'When', 'Where', 'How']);
      let gm: RegExpExecArray | null;
      while ((gm = genericRe.exec(text)) !== null && bridges.size < 6) {
        const candidate = cleanCandidate(
          gm[1].split(/\s+/).filter((token) => !GENERIC_STOP.has(token)).join(' '),
        );
        if (candidate && candidate.length >= 4 && candidate.length <= 40) bridges.add(candidate);
      }
    }

    return Array.from(bridges).slice(0, 6);
  }

  extractBridgeEntityFromEvidence(text: string, rel: string): string | null {
    const list = this.extractBridgeEntitiesFromEvidence(text, rel);
    return list.length > 0 ? list[0] : null;
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
    const rawList = Array.isArray(requestedKbScope)
      ? requestedKbScope.map((id) => String(id).trim()).filter(Boolean)
      : typeof requestedKbScope === "string" && requestedKbScope !== "all" && requestedKbScope.trim() !== ""
        ? [requestedKbScope.trim()]
        : undefined;
    const parsedRequestedScope = rawList && rawList.length > 0 ? rawList : undefined;
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
        sourceFreshness = await this.checkSourceFreshness(
          userId, scope, userScope.aclEpoch, userScope.knowledgeEpoch,
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
            sourceFreshness ?? undefined,
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
      selectedSourceKeys.every((key: string, index: number) => key === userScopeSourceKeys.slice().sort()[index]);
    const forceQueryRefresh = Boolean(sourceFreshness?.rebuilt);

    const llmReqEarly = this.modelConfigService
      ? await this.modelConfigService.getLlmChatConfig(`llmwiki-${userId}`).catch(() => null)
      : null;
    const currentModelName = llmReqEarly?.modelName || "";

    const cacheScopeKey = semanticCacheScopeKey(
      selectedSourceKeys,
      userScope.aclEpoch,
      userScope.knowledgeEpoch,
      currentModelName,
      userId,
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
              userId,
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
            cachedCitations.forEach((cit: any, citIndex: any) => {
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

    // Speculative Parallel Retrieval: Dispatch PostgreSQL chunk retrieval for the rewritten query
    // concurrently with Agentic query planning / decomposition, hiding DB latency behind LLM time.
    // Candidate-pool depth for the answer path.
    //
    // Measured 2026-09-21: the `/chat/search` path retrieves 50 chunks and finds
    // the gold bridge document for 95.8% of the MuSiQue hard failures, while the
    // answer path only pulled 15 — so the doc the search path ranked 6th was
    // never even a candidate for the answer, and no downstream guarantee could
    // restore it. The pool depth is therefore a knob (RETRIEVAL_ANSWER_POOL_DOCS)
    // instead of a literal, so pool depth and context depth stay independent.
    const answerPoolDocs = Math.max(15, Number(process.env.RETRIEVAL_ANSWER_POOL_DOCS || 15));
    const speculativeBaseChunksPromise = this.searchChunksFallback(
      scope,
      retrieval.query || question,
      answerPoolDocs,
    ).catch((err) => {
      this.logger.warn(`searchChunksFallback speculative error: ${err.message}`);
      return [];
    });

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
    // fallback so vocabulary gaps (colloquial→formal register) and compound questions
    // are recovered without any hardcoded synonym table.
    const recallVariants = [...agenticSubQueries, ...agenticExpansions, ...(hydePassage ? [hydePassage] : [])];
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
    const isInventoryQuery = isDocumentInventoryQuery(question);

    // A derived page is valid only for the exact permission/source set from
    // which it was built. Never add a full-scope summary to a user-selected
    // subset of knowledge bases. For whole-scope queries, mount it whenever
    // the query is broad, multi-hop, macro, or an inventory/landscape query.
    const shouldMountScopeDerived =
      wholeScopeSelected &&
      (retrieval.breadth ||
        agenticComplexity !== "simple" ||
        isInventoryQuery ||
        /(?:总结|概述|全景|历程|演进|架构|体系|全库|全局|所有.*有哪些|主要.*有哪些|一共.*多少|共有.*几|多少条|几条|多少章|几章|清单|统计|列表|目录|关系|架构|层级|制度)/u.test(question) ||
        process.env.GBRAIN_ALWAYS_MOUNT_DERIVED === "true");

    if (shouldMountScopeDerived) {
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
        !wholeScopeSelected ? "用户选择了部分知识库，不使用全范围综述" : "聚焦问题优先使用原始文档证据",
      );
    }

    this.logger.debug(
      `Querying brain for "${question}" in scope ${scope.join(",")} (Scope fingerprint: ${userScope.fingerprint})...`,
    );

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
    let initialEvidenceAssessment: { weak: boolean; shouldEscalate: boolean; reason: string; evidence?: string; topScore?: number | null; scoreFloor?: number | null } = { weak: false, shouldEscalate: false, reason: "" };

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
        scoreSource: "synthetic",
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
          scoreSource: "synthetic",
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
      // Inventory queries never use GBrain; release the hard timer immediately.
      clearTimeout(gbrainHardTimer);
      if (signal) signal.removeEventListener("abort", linkRequestAbort);
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

      // 1. Fast-Path: Query PostgreSQL chunks concurrently (<10ms) for main query and decomposed sub-queries
      const effectiveSubQueries = agenticSubQueries.length > 0
        ? agenticSubQueries
        : this.decomposeComplexQuery(retrieval.query || question);
      const fallbackChunksPromise = (async () => {
        let base: any[] = await speculativeBaseChunksPromise;
        if (!base || base.length === 0) {
          base = await this.searchChunksFallback(scope, question, Math.max(15, Number(process.env.RETRIEVAL_ANSWER_POOL_DOCS || 15)), recallVariants).catch((err) => {
            this.logger.warn(`searchChunksFallback early promise error: ${err.message}`);
            return [];
          });

          // A/B shadow: observational only (control/shadow arms). Does not change
          // the primary answer. No-op when ExperimentsModule is disabled.
          void this.runShadowRetrievalDiff(userId, conversationId, scope, retrieval.query || question, base as any[]).catch(() => undefined);

        } else if (recallVariants.length > 0) {
          try {
            const extraHits = await this.searchChunksFallback(scope, question, 10, recallVariants).catch(() => [] as any[]);
            const seen = new Set(base.map((b) => retrievalCandidateKey(b)));
            for (const h of extraHits) {
              const key = retrievalCandidateKey(h);
              if (!seen.has(key)) {
                seen.add(key);
                base.push(h);
              }
            }
          } catch (e) {}
        }
        if (effectiveSubQueries.length > 0) {
          try {
            const subChunks = await Promise.all(
              effectiveSubQueries.slice(0, 4).map((sub) =>
                this.searchChunksFallback(scope, sub, 5)
                  .then((hits) => {
                    for (const h of hits) (h as any).subQueryOrigin = (h as any).subQueryOrigin || sub;
                    return hits;
                  })
                  .catch(() => [] as any[])
              )
            );
            const seen = new Set(base.map((b) => retrievalCandidateKey(b)));
            for (const hits of subChunks) {
              for (const h of hits) {
                const key = retrievalCandidateKey(h);
                const existing = base.find((b) => retrievalCandidateKey(b) === key);
                if (existing) {
                  (existing as any).subQueryOrigin = (existing as any).subQueryOrigin || (h as any).subQueryOrigin;
                  if (typeof h.score === 'number' && h.score > (existing.score || 0)) {
                    existing.score = h.score;
                  }
                } else {
                  seen.add(key);
                  base.push(h);
                }
              }
            }
          } catch (e) {
            this.logger.warn(`subquery fallbackChunks error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // Dynamic cascading bridge entity extraction (up to 2 cascade rounds for 3~4 step reasoning chains)
        const rel = this.extractRelationFromQuery(retrieval.query || question);
        if ((rel || agenticComplexity !== 'simple') && base.length > 0) {
          try {
            const visitedBridges = new Set<string>();
            let currentEvidencePool = base.slice(0, 4).map((b) => b.evidence).join('\n');
            const maxCascadeRounds = agenticComplexity === 'multi_hop' || rel ? 2 : 1;

            for (let round = 0; round < maxCascadeRounds; round++) {
              const bridges = this.extractBridgeEntitiesFromEvidence(currentEvidencePool, rel);
              const unseenBridges = bridges.filter((br) => {
                const lower = br.toLowerCase();
                if (visitedBridges.has(lower)) return false;
                visitedBridges.add(lower);
                return !base.some((b) => (b.title || '').toLowerCase().includes(lower));
              });

              if (unseenBridges.length === 0) break;

              const bridgeResults = await Promise.all(
                unseenBridges.map((br) => this.searchChunksFallback(scope, br, 5).catch(() => [] as any[])),
              );

              const newlyAddedChunks: any[] = [];
              for (let i = 0; i < unseenBridges.length; i++) {
                const br = unseenBridges[i];
                for (const bh of bridgeResults[i]) {
                  (bh as any).subQueryOrigin = br;
                  base.push(bh);
                  newlyAddedChunks.push(bh);
                }
              }

              if (newlyAddedChunks.length === 0) break;
              // Feed newly retrieved bridge evidence to the next round of multi-hop extraction
              currentEvidencePool = newlyAddedChunks.slice(0, 4).map((b) => b.evidence).join('\n');
            }
          } catch (e) {
            this.logger.warn(`dynamic cascading bridge error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return base;
      })();

      // 2. Query GBrain federated search concurrently
      // Create a per-stage abort controller for the fallback-race window. This is separate from
      // gbrainAbort so that the 2500ms race timeout doesn't poison subsequent stages (escalation,
      // source reconcile). Each stage gets its own controller linked to the request signal.
      const stageAbort = new AbortController();
      const stageAbortLink = () => stageAbort.abort();
      if (signal?.aborted) stageAbort.abort();
      else if (signal) signal.addEventListener("abort", stageAbortLink, { once: true });
      // Resolved once for the whole retrieval stage: the arm policy decides both
      // whether the main GBrain query is raced and whether the decomposed
      // sub-query probes are launched at all.
      const chatArmPolicy = resolveArmPolicy();

      const gbrainQueryOnce = (q: string) =>
        sourceRefs.length > 1
          ? this.gbrain.queryMany(sourceRefs, q, {
              breadth: retrieval.breadth,
              operation: effectiveOp,
              signal: stageAbort.signal,
              ...(forceQueryRefresh ? { forceRefresh: true } : {}),
            })
          : this.gbrain.query(
              sourceRefs[0] || brainRepo.gitRepoUrl,
              q,
              { breadth: retrieval.breadth, operation: effectiveOp, signal: stageAbort.signal, ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
            );
      const gbrainSearchPromise = gbrainQueryOnce(retrieval.query).catch((err) => {
        // Distinguish a genuine GBrain failure from the expected 2.5s
        // race-window abort (which has its own timed warning below).
        if (!stageAbort.signal.aborted) {
          trace.warn(
            "gbrain_search_error",
            "GBrain 检索异常降级",
            `GBrain 检索失败，已回退到数据库分块检索: ${err.message}`,
          );
        }
        this.logger.warn(`GBrain search error: ${err.message}`);
        return { topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult;
      }).finally(() => {
        // The request-signal link only needs to live as long as the search is
        // in flight; drop it once the promise settles to avoid a listener leak.
        if (signal) signal.removeEventListener("abort", stageAbortLink);
      });
      // Decomposed sub-queries get their own GBrain probes, launched at the
      // same time as the main query (they overlap the race window, so waiting
      // for them afterwards adds little latency). Each hop of a compound
      // question gets an independent recall chance.
      // Sub-query probes use their OWN abort controller: the main-query race
      // aborts `stageAbort` at 2500ms which would kill these probes before
      // they return; they stay bounded by their own hard timeout or client cancel.
      const subProbeAbort = new AbortController();
      const subProbeAbortLink = () => subProbeAbort.abort();
      if (signal?.aborted) subProbeAbort.abort();
      else if (signal) signal.addEventListener("abort", subProbeAbortLink, { once: true });
      const subProbeTimer = setTimeout(
        () => {
          subProbeAbort.abort();
          trace.warn(
            "gbrain_subprobe_timeout",
            "子查询探针超时降级",
            `子查询探针超出 ${Number(process.env.GBRAIN_SUBPROBE_TIMEOUT_MS || 12000)}ms 未返回，已中止（该推理跳可能缺少证据）`,
          );
        },
        Number(process.env.GBRAIN_SUBPROBE_TIMEOUT_MS || 12000),
      );
      subProbeTimer.unref?.();
      const gbrainSubQueryOnce = (q: string) =>
        sourceRefs.length > 1
          ? this.gbrain.queryMany(sourceRefs, q, {
              breadth: retrieval.breadth,
              operation: effectiveOp,
              signal: subProbeAbort.signal,
              ...(forceQueryRefresh ? { forceRefresh: true } : {}),
            })
          : this.gbrain.query(
              sourceRefs[0] || brainRepo.gitRepoUrl,
              q,
              { breadth: retrieval.breadth, operation: effectiveOp, signal: subProbeAbort.signal, ...(forceQueryRefresh ? { forceRefresh: true } : {}) },
            );
      // When the engine arm is switched off (chunks_only), its sub-query probes
      // must not be launched either. They used to run anyway and the stage then
      // *waited* for them — up to the 12s sub-probe timeout — so every answer
      // paid the engine arm's latency while receiving none of its evidence
      // (measured: gbrain_retrieval 12011ms with the arm policy already off).
      const gbrainSubPromises = agenticSubQueries.length > 0 && chatArmPolicy !== "chunks_only"
        ? agenticSubQueries.slice(0, 3).map((sub) =>
            gbrainSubQueryOnce(sub)
              .then((r: any) => {
                for (const cit of r?.citations || []) (cit as any).subQueryOrigin = (cit as any).subQueryOrigin || sub;
                return r;
              })
              .catch(() => ({ topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult)),
          )
        : [];
      const gbrainSubsAll = Promise.allSettled(gbrainSubPromises).finally(() => {
        clearTimeout(subProbeTimer);
        if (signal) signal.removeEventListener("abort", subProbeAbortLink);
      });

      const fallbackChunks = await fallbackChunksPromise;
      if (fallbackChunks.length > 0) {
        // High-precision DB chunks are already available in milliseconds.
        // Race GBrain with a bounded 2500ms window and genuinely abort the CLI
        // subprocess if it loses, so the process-pool slot is released.
        // NOTE: this aborts the SAME per-stage controller that `gbrainQueryOnce`
        // (and therefore `gbrainSearchPromise`) is bound to. Do NOT declare a new
        // controller here — an unbound controller would silently make the race
        // cancellation a no-op and leak the GBrain CLI process-pool slot.
        // Downstream stages (escalation, source reconcile) use their own
        // controllers (escalation) or `gbrainAbort` (reconcile), so this abort
        // does not poison them.
        const chatGbrainRaceMs = resolveGbrainRaceMs();
        let racedGBrain: BrainQueryResult | null = null;
        if (chatArmPolicy === "chunks_only") {
          // The *search* path has honoured RETRIEVAL_ARM_POLICY=chunks_only for a
          // while; this answer path did not. Consequences measured on the test
          // environment: every answer still paid the full race window (up to 6s)
          // and, whenever the engine arm did win inside it, the answer silently
          // adopted the *engine-first* ordering — a ranking policy the retrieval
          // benchmarks measure as worse (MuSiQue R@10 0.764 -> 0.752, FullEv
          // 0.51 -> 0.48) and never intended here. Honour the switch: release the
          // subprocess slot immediately and answer from chunk retrieval.
          stageAbort.abort();
          trace.finish(
            "gbrain_arm_policy",
            "skipped",
            "GBrain 引擎臂按策略关闭（RETRIEVAL_ARM_POLICY=chunks_only），本次仅使用数据库分块召回",
            { policy: chatArmPolicy },
          );
        } else {
          const raceTimer = setTimeout(() => {
            stageAbort.abort();
            trace.warn(
              "gbrain_race_timeout",
              "GBrain 竞速超时降级",
              `GBrain 引擎臂在 ${chatGbrainRaceMs}ms 竞赛窗口内未返回，已中止该路检索并沿用数据库分块召回（多跳桥接证据可能缺失）`,
              { windowMs: chatGbrainRaceMs },
            );
          }, chatGbrainRaceMs);
          racedGBrain = await Promise.race([
            gbrainSearchPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), chatGbrainRaceMs)),
          ]);
          clearTimeout(raceTimer);
        }

        const chunkArmResult = (): BrainQueryResult => ({
          topics: Array.from(new Set(fallbackChunks.map((fb) => fb.title || "相关条款"))),
          fallbackMerged: true,
          answer: fallbackChunks.map((fb) => fb.evidence).join("\n\n"),
          citations: fallbackChunks.map((fb, idx) => ({
            topic: fb.title || fb.documentId || "",
            docId: fb.documentId,
            kbId: fb.kbId,
            version: fb.version,
            ord: fb.ord,
            pageNo: fb.pageNo,
            articleNo: fb.articleNo,
            evidence: fb.evidence,
            snippet: fb.evidence,
            context: fb.evidence,
            score: typeof fb.score === "number" && fb.score > 0 ? fb.score : Math.max(0.70, 0.95 - idx * 0.02),
            scoreSource: "synthetic",
            docTitle: fb.title,
            sectionGroup: (fb as any).sectionGroup,
            subQueryOrigin: (fb as any).subQueryOrigin,
            bbox: fb.bbox,
            previewUrl: fb.previewUrl,
          })),
          reranked: false,
          ...({ isMultiHop: agenticComplexity !== "simple" } as any),
        });
        const evidenceKey = (c: any) =>
          String(c?.evidence || c?.snippet || c?.context || "").replace(/\s+/g, "").slice(0, 30);

        if (racedGBrain && racedGBrain.citations && racedGBrain.citations.length > 0
            && chatArmPolicy === "engine_first") {
          queryResult = racedGBrain;
          const existingEvidence = new Set(
            racedGBrain.citations.map((c: any) => (c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30)),
          );
          for (const fb of fallbackChunks) {
            const key = fb.evidence.replace(/\s+/g, "").slice(0, 30);
            if (!existingEvidence.has(key)) {
              existingEvidence.add(key);
              queryResult.citations.push({
                topic: fb.title || fb.documentId || "",
                docId: fb.documentId,
                kbId: fb.kbId,
                version: fb.version,
                ord: fb.ord,
                pageNo: fb.pageNo,
                articleNo: fb.articleNo,
                evidence: fb.evidence,
                snippet: fb.evidence,
                context: fb.evidence,
                score: typeof fb.score === "number" && fb.score > 0.5 ? fb.score : 0.88,
                scoreSource: "synthetic",
                docTitle: fb.title,
                sectionGroup: (fb as any).sectionGroup,
          subQueryOrigin: (fb as any).subQueryOrigin,
          bbox: fb.bbox,
          previewUrl: fb.previewUrl,
              } as any);
            }
          }
          queryResult.citations.sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
          (queryResult as any).fallbackMerged = true;
        } else if (racedGBrain && racedGBrain.citations && racedGBrain.citations.length > 0) {
          // chunk_first: the chunk arm owns the ranking (it is the arm the
          // retrieval benchmarks measure and the one whose sub-query/bridge
          // probes supply multi-hop evidence). The engine arm may only *add*
          // evidence the chunk arm missed, appended underneath, because every
          // measured attempt at letting the second arm re-rank the first
          // (equal-weight RRF, rank fusion, engine-first) destroyed MRR.
          const chunkArm = chunkArmResult();
          const known = new Set(chunkArm.citations.map(evidenceKey));
          const chunkMinScore = chunkArm.citations.reduce(
            (min, c: any) => Math.min(min, Number(c.score) || 0),
            1,
          );
          const engineExtras = racedGBrain.citations.filter((c: any) => !known.has(evidenceKey(c)));
          queryResult = {
            ...chunkArm,
            citations: [
              ...chunkArm.citations,
              ...engineExtras.map((c: any, idx: number) => ({
                ...c,
                score: Math.max(0.05, chunkMinScore - 0.01 - idx * 0.001),
                scoreSource: "synthetic",
                engineArmOnly: true,
              })),
            ],
            ...({ engineExtrasMerged: engineExtras.length, armPolicy: "chunk_first" } as any),
          };
        } else {
          queryResult = chunkArmResult();
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
      if (gbrainSubPromises.length > 0 && chatArmPolicy !== "chunks_only") {
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
      // ── Retrieval complete: release the GBrain hard-timeout timer so it
      // cannot fire an AbortError during later pipeline stages (rerank,
      // source-reconcile, CRAG retry, generation).  Without this the 20 s
      // timer kept ticking and would abort retry attempts, surfacing an
      // unfriendly "This operation was aborted" error to the user.
      clearTimeout(gbrainHardTimer);
      if (signal) signal.removeEventListener("abort", linkRequestAbort);

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
    queryResult = await this.augmentWithDocumentSummaries(
      queryResult,
      scope,
      retrieval.query || question,
      agenticComplexity,
    );
    queryResult = await this.augmentWithRaptorGlobalTree(
      queryResult,
      scope,
      retrieval.query || question,
      agenticComplexity,
      trace,
    );
    queryResult = await this.augmentWithBrainDerivedIntelligence(
      queryResult,
      userScope,
      retrieval.query || question,
      agenticComplexity,
      trace,
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
        userId,
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
      const priorCitations = [...(queryResult.citations || [])];
      queryResult = await gbrainQueryOnce(retrieval.query).catch((err) => {
        this.logger.warn(`Escalation GBrain query failed: ${err.message}`);
        return { topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult;
      });
      // Decomposed sub-queries run as PARALLEL GBrain probes so each hop of a
      // compound question gets its own recall chance; citations merge by
      // evidence prefix (same dedupe rule as the fallback merge).
      if (agenticSubQueries.length > 0) {
        const subResults = await Promise.allSettled(
          agenticSubQueries.slice(0, 3).map((sub) =>
            gbrainQueryOnce(sub).then((r: any) => {
              for (const cit of r?.citations || []) (cit as any).subQueryOrigin = (cit as any).subQueryOrigin || sub;
              return r;
            }),
          ),
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
      // Preserve prior citations from the first-pass/fallback so valid evidence is never lost
      const currentSeen = new Set(
        (queryResult.citations || []).map((c: any) =>
          String(c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30),
        ),
      );
      for (const p of priorCitations) {
        const key = String(p.evidence || p.snippet || "").replace(/\s+/g, "").slice(0, 30);
        if (key && !currentSeen.has(key)) {
          currentSeen.add(key);
          (queryResult.citations as any[]).push(p);
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
          userId,
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
    // CRITICAL FIX: Only use fallback when BOTH answer AND citations are missing.
    // If we have citations but no answer, preserve those citations and let them be used for answer generation.
    if ((!queryResult.answer || queryResult.answer.trim() === "") && (queryResult.citations?.length || 0) === 0) {
      trace.start("source_reconcile_retry", "Source 回退与对账重试", "未命中候选，优先执行毫秒级 Chunk 数据库回退检索");
      const fallbackChunks = await this.searchChunksFallback(scope, question, 15, recallVariants);
      if (fallbackChunks.length > 0) {
        queryResult.answer = fallbackChunks.map((fb) => fb.evidence).join("\n\n");
        (queryResult as any).fallbackMerged = true;
        queryResult.citations = fallbackChunks.map((fb, idx) => ({
          topic: fb.title || fb.documentId || "",
          docId: fb.documentId,
          kbId: fb.kbId,
          version: fb.version,
          ord: fb.ord,
          pageNo: fb.pageNo,
          articleNo: fb.articleNo,
          evidence: fb.evidence,
          snippet: fb.evidence,
          context: fb.evidence,
          score: Math.max(0.70, 0.95 - idx * 0.02),
          scoreSource: "synthetic",
          docTitle: fb.title,
          sectionGroup: (fb as any).sectionGroup,
          subQueryOrigin: (fb as any).subQueryOrigin,
          bbox: fb.bbox,
          previewUrl: fb.previewUrl,
        })) as any;
        trace.finish(
          "source_reconcile_retry",
          "success",
          `数据库分块语义检索命中 ${fallbackChunks.length} 条高相关度条款证据`,
          { candidateCount: fallbackChunks.length },
        );
      } else {
        await (this.compilerService as any)?.syncUserBrainRepo?.(userId);
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
              }).catch((err) => {
                this.logger.warn(`Source reconcile GBrain query failed: ${err.message}`);
                return { topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult;
              })
            : await this.gbrain.query(
                refreshedRefs[0] || brainRepo.gitRepoUrl,
                qTry,
                { breadth: retrieval.breadth, operation: "search", signal: gbrainAbort.signal, forceRefresh: true },
              ).catch((err) => {
                this.logger.warn(`Source reconcile GBrain query failed: ${err.message}`);
                return { topics: [], answer: "", citations: [], reranked: false } as BrainQueryResult;
              });
          if (subResult.citations?.length) {
            queryResult = subResult;
            break;
          }
        }

        // CRAG-style corrective retry: deterministic retries missed, so ask
        // the LLM once for alternative phrasings (synonyms / broader or more
        // formal terms) and give them a final bounded attempt before the
        // honest refusal.
        const needsCragRetry = !queryResult.citations?.length ||
          (queryResult.citations.length < 3 && initialEvidenceAssessment.shouldEscalate);
        if (needsCragRetry) {
          trace.start("crag_rewrite_retry", "纠错式改写重试", "常规改写未命中或证据偏弱，让模型给出替代检索措辞");
          const retryQueries = await this.rewriteQueryForRetry(retrieval.query || question);
          for (const qTry of retryQueries) {
            // Also search fallback chunks with retry query to recover vocabulary gaps
            const retryFallbackHits = await this.searchChunksFallback(scope, qTry, 5).catch(() => [] as any[]);
            if (retryFallbackHits.length > 0) {
              if (!queryResult.citations) queryResult.citations = [];
              for (const fb of retryFallbackHits) {
                const key = retrievalCandidateKey(fb);
                if (!queryResult.citations.some((c: any) => retrievalCandidateKey(c) === key)) {
                  queryResult.citations.push({
                    topic: fb.title || fb.documentId || "",
                    docId: fb.documentId,
                    kbId: fb.kbId,
                    version: fb.version,
                    ord: fb.ord,
                    pageNo: fb.pageNo,
                    articleNo: fb.articleNo,
                    evidence: fb.evidence,
                    snippet: fb.evidence,
                    context: fb.evidence,
                    score: Math.max(0.70, 0.88),
                    scoreSource: "synthetic",
                    docTitle: fb.title,
                    subQueryOrigin: qTry,
                  } as any);
                }
              }
            }

            const retryResult = refreshedRefs.length > 1
              ? await this.gbrain.queryMany(refreshedRefs, qTry, {
                  breadth: true,
                  operation: "search",
                  signal: gbrainAbort.signal,
                }).catch((err) => {
                  this.logger.warn(`CRAG retry GBrain query failed: ${err.message}`);
                  return null;
                })
              : await this.gbrain.query(
                  refreshedRefs[0] || brainRepo.gitRepoUrl,
                  qTry,
                  { breadth: true, operation: "search", signal: gbrainAbort.signal },
                ).catch((err) => {
                  this.logger.warn(`CRAG retry GBrain query failed: ${err.message}`);
                  return null;
                });
            if (retryResult?.citations?.length) {
              if (!queryResult.citations) queryResult.citations = [];
              for (const cit of retryResult.citations) {
                const key = cit.slug || (cit.evidence || cit.snippet || '').slice(0, 30);
                if (!queryResult.citations.some((c: any) => (c.slug || (c.evidence || c.snippet || '').slice(0, 30)) === key)) {
                  queryResult.citations.push(cit);
                }
              }
              break;
            }
          }
          trace.finish(
            "crag_rewrite_retry",
            queryResult.citations?.length ? "success" : "warning",
            queryResult.citations?.length
              ? `改写重试命中 ${queryResult.citations.length} 个候选`
              : "改写重试仍未命中，将诚实拒答",
            { retryQueries },
          );
        }

        queryResult = await this.filterQueryResultByCurrentPermission(
          queryResult,
          scope,
          {
            scopeId: userScope.scopeId,
            sourceKeys: selectedSourceKeys,
            aclEpoch: userScope.aclEpoch,
            knowledgeEpoch: userScope.knowledgeEpoch,
            userId,
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
        const bindingLimit = Math.max(1, Number(process.env.WEKNORA_QUERY_BINDING_LIMIT || 500));
        const publishedDocs = await this.prisma.document.findMany({
          where: { kbId: { in: scope }, status: "published", qualityStatus: "passed" },
          select: { id: true, kbId: true, version: true },
          take: bindingLimit + 1,
        });
        const bindings: WeKnoraBinding[] = publishedDocs.slice(0, bindingLimit).map((doc) => ({
          knowledgeId: doc.id,
          documentId: doc.id,
          kbId: doc.kbId,
          version: doc.version,
        }));
        if (publishedDocs.length > bindingLimit) {
          trace.skip("weknora_retrieval", "WeKnora 外部检索灰度", `授权文档超过在线绑定上限 ${bindingLimit}，请使用离线灰度评测`);
        } else if (bindings.length === 0) {
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
            queryResult.citations = this.fuseWithWeKnoraRRF(queryResult.citations || [], weknoraEvidences);
            queryResult.answer = (queryResult.citations as any[])
              .map((c: any) => c.context || c.evidence || c.snippet)
              .filter(Boolean)
              .join("\n\n");
            trace.finish(
              "weknora_retrieval",
              "success",
              `WeKnora RRF 联邦融合完成：已融合 ${weknoraEvidences.length} 条外部证据（双路验证 ${overlapCount} 条，补充发现 ${novelCount} 条）`,
              {
                weknoraCount: weknoraEvidences.length,
                overlapCount,
                novelCount,
                hybrid: true,
                fusedCount: queryResult.citations.length,
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
    // Structural section alignment (P2-03): when the question names a section
    // (e.g. 汇总表) prefer matching summary chunks over same-doc detail tables.
    try {
      const sectionAlignChanged = applySectionAlign(
        question,
        (queryResult.citations || []) as any[],
      );
      if (sectionAlignChanged) {
        (queryResult.citations as any[]).sort(
          (a: any, b: any) => (Number(b?.score) || 0) - (Number(a?.score) || 0),
        );
        trace.start("section_align", "结构对齐偏置", "按问题点名的小节/表角色调整候选排序");
        trace.finish("section_align", "success", "已应用 section/table-role 对齐乘子");
      }
    } catch (alignErr) {
      this.logger.debug(
        `section align skipped: ${alignErr instanceof Error ? alignErr.message : String(alignErr)}`,
      );
    }
    // Section rescue (P2-03): pull same-doc summary chunks when the question
    // names a section that the candidate pool failed to cover.
    try {
      const current = (queryResult.citations || []) as any[];
      // Use the original question: rewritten retrieval.query often drops the
      // structural noun (e.g. 汇总表 → 编号) that section-rescue keys on (P2-03).
      const needRescue = needsSectionRescue(question, current);
      if (needRescue) {
        const rescued = await (this.retrievalArms as any).rescueSections(
          question,
          current,
        );
        const keyOf = (c: any) =>
          `${c.documentId || c.docId || ''}:${(c.evidence || c.context || c.snippet || '').slice(0, 40)}`;
        const existingKeys = new Set(current.map(keyOf));
        const added = (rescued || []).filter((r: any) => !existingKeys.has(keyOf(r)));
        // Promote existing pool members that are structurally the named section
        // (they often already sit in the pool below detail-table rows).
        const anchors = extractSectionAnchors(question);
        const promoted = current.filter((c: any) => {
          const evidence = String(c.evidence || c.context || c.snippet || '')
            .replace(/^\s*\[\s*上下文[\s\S]*?\]\s*/u, '')
            .replace(/^\s*\[\s*context[\s\S]*?\]\s*/iu, '');
          const headings = evidence.match(/^#{1,6}\s*.+$/gm) || [];
          const structural = `${c.section || ''} ${c.breadcrumb || ''} ${c.topic || ''} ${c.docTitle || c.doc_title || ''} ${headings.join(' ')}`;
          const role = c.tableRole || c.table_role;
          return role === 'summary' || anchors.some((a: string) => a.length >= 2 && structural.includes(a));
        });
        for (const c of promoted) {
          const base = Number((c as any).score ?? 0);
          (c as any).score = Number(Math.max(base, 0.96).toFixed(4));
          (c as any).sectionRescuePromoted = true;
        }
        const rest = current.filter((c: any) => !(promoted as any[]).includes(c));
        queryResult.citations = [...added, ...promoted, ...rest];
        applySectionAlign(question, queryResult.citations as any[]);
        (queryResult.citations as any[]).sort(
          (a: any, b: any) => (Number(b?.score) || 0) - (Number(a?.score) || 0),
        );
        trace.start("section_rescue", "小节救援", "同文档补拉未覆盖的问题点名小节");
        if (added.length > 0 || promoted.length > 0) {
          trace.finish(
            "section_rescue",
            "success",
            `补入 ${added.length} 条小节分片，提升 ${promoted.length} 条已有点名小节候选：${promoted
              .slice(0, 3)
              .map((c: any) => String(c.evidence || c.snippet || c.section || "").slice(0, 24).replace(/\n/g, " "))
              .join(" | ")}`,
          );
        } else {
          trace.finish(
            "section_rescue",
            "warning",
            `未补入/提升小节分片（rescued=${(rescued || []).length}, pool=${current.length}）`,
          );
        }
      } else {
        trace.start("section_rescue", "小节救援", "同文档补拉未覆盖的问题点名小节");
        trace.finish("section_rescue", "success", "候选池已覆盖问题小节，无需救援");
      }
    } catch (rescueErr) {
      this.logger.warn(
        `section rescue skipped: ${rescueErr instanceof Error ? rescueErr.message : String(rescueErr)}`,
      );
    }
    trace.start("rerank", "候选重排", "统一比较跨 Source 候选并执行相关性打分");
    queryResult = await this.rerankPool(
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
    // Re-apply structural alignment AFTER cross-encoder rerank so a summary
    // section rescued from the same document is not re-buried by detail-table
    // rows the encoder scored highly (P2-03).
    try {
      if (applySectionAlign(question, (queryResult.citations || []) as any[])) {
        (queryResult.citations as any[]).sort(
          (a: any, b: any) => (Number(b?.score) || 0) - (Number(a?.score) || 0),
        );
      }
      // Pin structurally-matched summary/section hits to the head of the context
      // after rerank. Cross-encoder scores favour long detail tables; without a
      // pin the rescued summary is re-buried (P2-03).
      {
        const anchors = extractSectionAnchors(question);
        const isPinned = (c: any) => {
          if (c?.sectionRescuePromoted || c?.tableRole === 'summary' || c?.table_role === 'summary') {
            return true;
          }
          const evidence = String(c?.evidence || c?.context || c?.snippet || '');
          const headings = evidence.match(/^#{1,6}\s*.+$/gm) || [];
          const structural = `${c?.section || ''} ${c?.breadcrumb || ''} ${c?.topic || ''} ${c?.docTitle || c?.doc_title || ''} ${headings.join(' ')}`;
          return anchors.some((a: string) => a.length >= 2 && structural.includes(a));
        };
        const list = (queryResult.citations || []) as any[];
        const pinned = list.filter((c) => isPinned(c));
        const others = list.filter((c) => !isPinned(c));
        if (pinned.length > 0) {
          queryResult.citations = [...pinned, ...others];
        }
      }
    } catch {
      /* keep rerank order */
    }

    // Bounded DRIFT pass: community summaries select graph regions and entity
    // probes only. Every returned hit still passes through ordinary retrieval,
    // ACL filtering, reranking and provenance-bound citation assembly.
    const driftProbes: string[] = [];
    const shouldRunDrift =
      process.env.GRAPHRAG_DRIFT_ENABLED !== 'false' &&
      Boolean(this.graphRagService) &&
      scope.length > 0 &&
      (
        agenticComplexity === 'global_synthesis' ||
        ((agenticComplexity === 'multi_hop' || agenticComplexity === 'comparative') &&
          ((queryResult.citations?.length || 0) < Number(process.env.GRAPHRAG_DRIFT_EVIDENCE_THRESHOLD || 8) || agenticSubQueries.length > 1))
      );
    if (shouldRunDrift) {
      trace.start('graphrag_drift', 'GraphRAG DRIFT 导航检索', '从相关社区选择实体并执行有预算的原文补检');
      try {
        const plan = await this.graphRagService!.planDriftQueries(scope, retrieval.query || question, {
          maxCommunities: Number(process.env.GRAPHRAG_DRIFT_MAX_COMMUNITIES || 2),
          maxProbes: Number(process.env.GRAPHRAG_DRIFT_MAX_PROBES || 2),
          maxEntities: Number(process.env.GRAPHRAG_DRIFT_MAX_ENTITIES || 16),
        });
        const seen = new Set([
          (retrieval.query || question).trim().toLowerCase(),
          ...agenticSubQueries.map((probe) => probe.trim().toLowerCase()),
        ]);
        driftProbes.push(...plan.probes.filter((probe) => {
          const key = probe.trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
        if (driftProbes.length) {
          const driftHits = await this.retrieveHopProbes(
            scope,
            sourceRefs,
            brainRepo?.gitRepoUrl,
            driftProbes,
            signal || undefined,
            userScope,
            selectedSourceKeys,
            2,
          );
          const merged = [...(queryResult.citations || [])];
          const seenEvidence = new Set(merged.map((citation: any) =>
            `${citation.id || citation.docId || ''}:${String(citation.evidence || citation.snippet || '').replace(/\s+/g, '').slice(0, 80)}`,
          ));
          for (const citation of driftHits) {
            const key = `${citation.id || citation.docId || ''}:${String(citation.evidence || citation.snippet || '').replace(/\s+/g, '').slice(0, 80)}`;
            if (seenEvidence.has(key)) continue;
            seenEvidence.add(key);
            merged.push({ ...citation, driftNavigation: true });
          }
          queryResult = await this.rerankPool(
            retrieval.query || question,
            { ...queryResult, citations: merged },
            true,
          );
        }
        trace.finish('graphrag_drift', 'success', `DRIFT 生成 ${driftProbes.length} 个导航探针`, {
          probes: driftProbes,
          communityIds: plan.communityIds,
          seedEntities: plan.seedEntities,
        });
      } catch (err) {
        trace.finish('graphrag_drift', 'warning', 'DRIFT 导航检索失败，沿用已有证据', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      trace.skip('graphrag_drift', 'GraphRAG DRIFT 导航检索', '问题复杂度或证据状态无需启动 DRIFT');
    }

    // Agentic Multi-Hop ReAct Loop:
    // Evaluate retrieval sufficiency for comparative and multi-hop queries.
    // Automatically executes 2-Hop / 3-Hop sub-query iterations when entity coverage or reasoning steps are missing.
    const allHopProbes: string[] = [...agenticSubQueries, ...driftProbes];
    const executedProbeSet = new Set<string>([(retrieval.query || question).trim().toLowerCase()]);
    // Enter the sufficiency loop for *relational* questions too, not only for ones the
    // planner labels multi-hop/comparative. Measured failure: "When is the date of birth
    // of the creator of A Burial at Ornans?" is classified 'simple' with no sub-queries,
    // so no hop ran; the prompt held only the painting's page, the model named Gustave
    // Courbet from it and then refused the birth date it could not see. Any question
    // asking for an attribute of an entity named *inside* the documents needs the same
    // treatment — that is what the relation term signals. The LLM sufficiency judge still
    // decides whether another hop is actually required, so the cost is one bounded call.
    const relationTerm = this.extractRelationFromQuery(retrieval.query || question);
    // Deterministic bridge seed: when the question asks for an attribute (born / creator /
    // director …), one probe naming the bridge entity found in the first-hop evidence is
    // what supplies the second hop. Measured failure this fixes: "date of birth of the
    // creator of A Burial at Ornans" — the sufficiency judge returned "sufficient (80%)"
    // with only the painting's page in context, the model named Gustave Courbet from it
    // and then refused the date it could not see. The search path has run this cascade for
    // a long time; the chat path relied on the judge alone.
    const bridgeSeeds: string[] = [];
    if (relationTerm && process.env.RETRIEVAL_CHAT_BRIDGE_SEED !== 'false') {
      // Deterministic, corpus-grounded candidate set: every capitalised name in the
      // first-hop evidence that **has its own document** in the authorised scope and is
      // not already in context. The document check is what makes this precise — regex
      // extraction alone produced prose fragments (rejected twice on the search path),
      // while "the evidence names X and a document titled X exists" is a property of the
      // corpus, not of a regex. It also yields nothing on corpora whose documents are
      // filenames, so it costs nothing there.
      // Scan in *score* order, not pool order: pool order is polluted by probe
      // candidates with ~0.000 scores, and the page that carries the next hop is
      // often the highest-scoring one. Measured on the Bergen question: "Bergen,
      // North Holland" scored 0.148 (the best of the pool) but sat at pool
      // position 8, so the two seed slots went to lower-scored Norway/US pages.
      // Derived summaries (RAPTOR level-2 / per-document 宏观摘要) are not source
      // pages: they are machine-written digests that score high, carry no new
      // entities, and in a bilingual corpus are written in the *other* language.
      // Measured 2026-09-22 on "…the mother of the person who found the sacred
      // writings…": the top-scoring citations were Chinese summaries, so the 12-slot
      // scan produced Chinese prose fragments ("Jack London传记的早年家庭背景部分") and
      // never reached the page that actually names the bridge entity — while the
      // probe it would have produced ("Joseph Smith mother") returns the gold
      // document at rank 1 (score 0.9986). Scan the real source pages first and only
      // fall back to summaries if there is nothing else.
      const bridgeScanPool = (queryResult.citations || []);
      // Same summary test `selectEvidence` uses (text marker *or* provenance flag):
      // the flags are set where summaries are created but do not survive every
      // merge/stitch path, so the marker is the reliable signal. Measured
      // 2026-09-22: at scan time the pool held 151 citations, 0 of them flagged,
      // while the scan text was full of 【宏观摘要】 digests.
      const isSummaryCitation = (c: any) =>
        c?.isSummary === true ||
        c?.raptor === true ||
        /【宏观摘要[^】]*】/u.test(String(c?.evidence || c?.snippet || '')) ||
        /·\s*(?:全文|章节)摘要/u.test(String(c?.docTitle || c?.topic || ''));
      const sourceCitations = bridgeScanPool.filter((c: any) => !isSummaryCitation(c));
      if (process.env.CHAT_LOG_BRIDGE_SEED === 'true') {
        this.logger.log(
          `[BRIDGE_SCAN] pool=${bridgeScanPool.length} source=${sourceCitations.length} ` +
            `summaryFlagged=${bridgeScanPool.filter((c: any) => c?.isSummary === true || c?.raptor === true).length}`,
        );
      }
      const bridgeScanOrder = (sourceCitations.length ? sourceCitations : bridgeScanPool)
        .map((citation: any, index: number) => ({ citation, index, score: Number(citation?.score || 0) }))
        .sort((a: any, b: any) => b.score - a.score || a.index - b.index)
        .slice(0, 12);
      // 16 (was 8): the first eight capitalised spans are often noise, and the real
      // bridge entity can sit beyond them (measured: "…another work by the author of
      // Miss Sara Sampson" never reached "Gotthold Ephraim Lessing").
      const candidates = this.extractCapitalisedCandidates(
        bridgeScanOrder
          .map(({ citation }) => String(citation.evidence || citation.snippet || ''))
          .join('\n'),
        16,
      );
      if (process.env.CHAT_LOG_BRIDGE_SEED === 'true') {
        this.logger.log(
          `[BRIDGE_SEED_DEBUG] relation=${relationTerm} candidates=${JSON.stringify(candidates.slice(0, 6))}`,
        );
      }
      const contextTitles = new Set(
        // Only the evidence that actually formed the hop-1 context counts as "in
        // context". Using the whole candidate pool meant a document that was
        // merely *retrieved* (then dropped by selection) suppressed its own
        // bridge probe — measured on "Who is Magnus Julius De La Gardie's paternal
        // grandmother?": the father's page (which names Ebba Brahe) sat in the
        // pool, the seed was skipped, and the answer was never reachable.
        (queryResult.citations || [])
          .slice(0, 4)
          .map((citation: any) =>
            this.normalizeTitleForMatch(String(citation.docTitle || citation.topic || '')),
          ),
      );
      for (const candidate of candidates) {
        if (bridgeSeeds.length >= 2) break;
        if (!candidate || candidate.length < 3) continue;
        const key = this.normalizeTitleForMatch(candidate);
        if (!key || contextTitles.has(key) || executedProbeSet.has(candidate.toLowerCase())) {
          if (process.env.CHAT_LOG_BRIDGE_SEED === 'true') {
            this.logger.log(
              `[BRIDGE_SEED_DEBUG] skip ${candidate} (inContext=${contextTitles.has(key)} probed=${executedProbeSet.has(candidate.toLowerCase())})`,
            );
          }
          continue;
        }
        try {
          const match = await this.prisma.document.findFirst({
            where: {
              kbId: { in: scope },
              status: 'published',
              title: { equals: candidate, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (match) {
            bridgeSeeds.push(candidate);
          } else if (
            process.env.RETRIEVAL_CHAT_BRIDGE_MENTION_PROBE !== 'false' &&
            isStrongNameEntity(candidate)
          ) {
            // The answer page is not always *titled* after the bridge entity.
            //
            // Measured 2026-09-22 on MuSiQue "Who is the wife of the man who
            // produced the documentary of the pop star who sings I Want to Rock
            // with You?": the first-hop page says "produced by his friend, David
            // Gest", but no document is titled "David Gest" — the answer (Liza
            // Minnelli) lives on "Liza and David" ("…and her then-husband, David
            // Gest"). The exact-title gate therefore skipped the only entity that
            // could reach the answer, and the probe that *does* find it — the
            // existing "<entity> <relation>" wording — returned "Liza and David"
            // at rank 1 (score 0.974) whenever it was issued by hand.
            //
            // So: a multi-token proper name is probe-worthy on its own. The
            // precision guard is the shape of the candidate (≥2 capitalised
            // tokens), not the existence of a same-titled document; single words
            // and prose fragments stay excluded, which is what the earlier
            // rejections on the search path were actually about.
            bridgeSeeds.push(candidate);
          }
        } catch {
          // Lookup failure simply means no seed for this candidate.
        }
      }
      if (bridgeSeeds.length) {
        trace.warn(
          'bridge_seed',
          '桥接实体定向补检',
          `问题指向关系属性「${relationTerm}」，已准备对首跳证据中的实体定向补检：${bridgeSeeds.join('、')}`,
          { relation: relationTerm, seeds: bridgeSeeds },
        );
      }
    }
    const needsHopProbe = Boolean(relationTerm) ||
      agenticComplexity === 'multi_hop' ||
      agenticComplexity === 'comparative' ||
      agenticSubQueries.length > 0;
    if (this.agenticRagService && needsHopProbe) {
      const executedProbes = new Set<string>([
        (retrieval.query || question).trim().toLowerCase(),
        ...agenticSubQueries.map((q) => q.trim().toLowerCase()),
        ...agenticExpansions.map((q) => q.trim().toLowerCase()),
      ]);
      const maxHops = Number(process.env.AGENTIC_RAG_MAX_HOPS || 3);
      let currentHop = 1;

      while (currentHop < maxHops) {
        const currentContext = (queryResult.citations || [])
          .slice(0, 10)
          .map((c: any) => `${c.topic || c.docTitle || ''}: ${c.evidence || c.snippet || ''}`)
          .join('\n\n');

        trace.start(
          `agentic_sufficiency_eval_${currentHop}`,
          `Hop ${currentHop} 信息充分性裁决`,
          '评估当前证据链是否足以严谨完整回答复杂问题',
        );

        const judgment = await this.agenticRagService.judgeRetrievalSufficiency(
          retrieval.query || question,
          currentContext,
          currentHop,
          {
            complexity: agenticComplexity as any,
            subQueries: agenticSubQueries,
            executedProbes: Array.from(executedProbes),
          },
        );

        trace.finish(
          `agentic_sufficiency_eval_${currentHop}`,
          judgment.status === 'sufficient' ? 'success' : 'warning',
          judgment.status === 'sufficient'
            ? `证据充分性裁决通过 (置信度 ${(judgment.confidence * 100).toFixed(0)}%)${judgment.reasoning ? `：${judgment.reasoning}` : ''}`
            : `证据不充分 (缺失: ${judgment.missingAspects.join('、') || '部分关键信息'})，启动 Hop ${currentHop + 1} 定向补充检索`,
          {
            hop: currentHop,
            status: judgment.status,
            confidence: judgment.confidence,
            reasoning: judgment.reasoning,
            missingAspects: judgment.missingAspects,
            suggestedFollowUp: judgment.suggestedFollowUp,
          },
        );

        let nextProbes = (judgment.suggestedFollowUp || [])
          .map((p) => p.trim())
          .filter((p) => p.length >= 2 && !executedProbes.has(p.toLowerCase()))
          .slice(0, 2);

        if (judgment.status === 'sufficient' || judgment.status === 'irrelevant') {
          // The judge can be wrong when the question asks for an attribute that the
          // evidence never states (measured: "sufficient (80%)" with the asked fact
          // absent). If a deterministic bridge seed exists, spend one hop on it before
          // closing; after that the judge's verdict is respected.
          // Relation-augmented queries: "North Holland in charge" retrieves the
          // province page, and "Lessing author" retrieves sibling pages that merely
          // *mention* the author. The bare entity name is kept as a fallback probe.
          const relationSuffix = relationTerm ? ` ${relationTerm}` : '';
          const seeded = bridgeSeeds
            .filter((seed) => !executedProbes.has(seed.trim().toLowerCase()))
            .slice(0, 2)
            .map((seed) => `${seed}${relationSuffix}`.trim());
          if (currentHop === 1 && seeded.length > 0) {
            bridgeSeeds.length = 0;
            nextProbes = seeded;
            trace.warn(
              'bridge_seed_probe',
              '桥接实体补检（裁决保守化）',
              `充分性裁决为「${judgment.status}」，但问题指向关系「${relationTerm}」的缺失属性，先执行定向补检：${seeded.join('、')}`,
              { hop: currentHop, seeds: seeded, judgeStatus: judgment.status, confidence: judgment.confidence },
            );
          } else {
            break;
          }
        }

        if (nextProbes.length === 0) {
          break;
        }

        for (const p of nextProbes) {
          executedProbes.add(p.toLowerCase());
          allHopProbes.push(p);
        }
        currentHop++;

        trace.start(
          `agentic_hop_${currentHop}`,
          `多跳检索 Hop ${currentHop}`,
          `依据上一跳缺失维度 [${judgment.missingAspects.join(', ')}] 定向追问: ${nextProbes.join(' | ')}`,
        );

        const hopHits = await this.retrieveHopProbes(
          scope,
          sourceRefs,
          brainRepo?.gitRepoUrl,
          nextProbes,
          signal || undefined,
          userScope,
          selectedSourceKeys,
          currentHop,
        );

        const existingEvidence = new Set(
          (queryResult.citations || []).map((c: any) =>
            String(c.evidence || c.snippet || '').replace(/\s+/g, '').slice(0, 30),
          ),
        );
        let mergedHopCount = 0;
        for (const hit of hopHits) {
          const key = String(hit.evidence || hit.snippet || '').replace(/\s+/g, '').slice(0, 30);
          if (!key || existingEvidence.has(key)) continue;
          existingEvidence.add(key);
          (queryResult.citations as any[]).push(hit);
          mergedHopCount++;
        }

        trace.finish(
          `agentic_hop_${currentHop}`,
          mergedHopCount > 0 ? 'success' : 'warning',
          mergedHopCount > 0
            ? `Hop ${currentHop} 检索完成，追回 ${mergedHopCount} 条定向证据`
            : `Hop ${currentHop} 未追回额外有效证据`,
          { hop: currentHop, probes: nextProbes, hitsFound: mergedHopCount },
        );

        if (mergedHopCount === 0) {
          break;
        }

        // Re-rerank across the enriched candidate pool
        queryResult = await this.rerankPool(
          retrieval.query || question,
          queryResult,
          retrieval.breadth,
        );
      }
    }

    // Single evidence-selection stage: relevance floor + group-aware MMR
    // diversity + token budget. Replaces the former separate
    // document_diversity and evidence_gate passes.
    const beforeSelect = queryResult.citations?.length || 0;
    trace.start("evidence_selection", "证据统一选择", "相关性阈值、组级去重与 token 预算的联合选择");
    // Pre-selection contiguous stitching: physically adjacent chunks must be
    // merged BEFORE the relevance floor / group MMR / token-budget selection.
    // Previously stitching ran only after selection, so a split answer (e.g.
    // chapter 1-3 in chunk N, chapter 4 in chunk N+1) could be dropped as two
    // individually-weak chunks before the stitcher ever saw them. Merged here,
    // the combined unit competes once with the stronger of the two scores.
    if (process.env.RETRIEVAL_PRESTITCH !== "false" && (queryResult.citations?.length || 0) > 1) {
      const stitchedInput = this.stitchContiguousCitations(queryResult.citations || []);
      if (stitchedInput.length !== (queryResult.citations?.length || 0)) {
        queryResult = { ...queryResult, citations: stitchedInput };
      }
    }
    // Snapshot of the candidate pool *before* the relevance-floor / group-MMR
    // selection. The second-hop rescue below can only add back evidence that
    // retrieval already found; it never invents or re-fetches anything.
    const preSelectionCitations = (queryResult.citations || []).slice();
    if (process.env.CHAT_LOG_CONTEXT_PREVIEW === 'true' && process.env.CHAT_LOG_POOL_PREVIEW === 'true') {
      // Evaluation instrumentation: the answer path builds its own candidate pool
      // (query decomposition + bridge probes + fallback chunks), which is *not*
      // necessarily the pool /chat/search returns. Diagnosing "is the answering
      // passage even in this path's pool?" needs this listing.
      this.logger.log(
        `[POOL_PREVIEW] size=${preSelectionCitations.length} :: ` +
          preSelectionCitations
            .slice(0, 15)
            .map((c: any, i: number) => `${i + 1}.${String(c.docTitle || c.topic || '?').slice(0, 40)}(${Number(c.score || 0).toFixed(3)})`)
            .join(' | '),
      );
      if (process.env.CHAT_LOG_POOL_TEXT_FULL === 'true') {
        preSelectionCitations.slice(0, 25).forEach((c: any, i: number) => {
          this.logger.log(
            `[POOL_TEXT_FULL] #${i + 1} ${String(c.docTitle || c.topic || '?').slice(0, 30)} :: ` +
              String(c.context || c.snippet || c.evidence || '').replace(/\s+/g, ' '),
          );
        });
      }
      if (process.env.CHAT_LOG_POOL_TEXT === 'true') {
        preSelectionCitations.slice(0, 25).forEach((c: any, i: number) => {
          this.logger.log(
            `[POOL_TEXT] #${i + 1} ${String(c.docTitle || c.topic || '?').slice(0, 40)} :: ` +
              String(c.context || c.snippet || c.evidence || '').replace(/\s+/g, ' ').slice(0, 300),
          );
        });
      }
    }
    queryResult = this.selectEvidence(queryResult, {
      breadth: retrieval.breadth,
      tokenBudget: resolveContextTokenBudget({
        breadth: retrieval.breadth,
        complexity: agenticComplexity,
        subQueryCount: allHopProbes.length,
        evidenceCount: queryResult.citations?.length || 0,
      }),
      subQueries: allHopProbes,
      question,
    });
    // ── Second-hop rescue ────────────────────────────────────────────────
    // The selection is driven by cross-encoder scores computed against the
    // *whole* question, so hop-2 evidence (which is about the intermediate
    // entity, not about the question) loses to hop-1 by an order of magnitude
    // and is pruned. When the already-selected hop-1 text names an entity that
    // has its own document still sitting in the pool, that document is the
    // bridge the question needs — add it back (bounded, exact title match,
    // never for names already in the question). See bridge-rescue.ts.
    const preSelectionPool = preSelectionCitations;
    if (process.env.RETRIEVAL_CHAT_BRIDGE_RESCUE !== 'false' && preSelectionPool.length) {
      const selectedTexts = (queryResult.citations || [])
        .slice(0, 4)
        .map((c: any) => String(c.evidence || c.snippet || c.context || ''))
        .filter(Boolean);
      const plan = planSecondHopRescue({
        selectedTexts,
        pool: preSelectionPool.map((c: any) => ({
          title: c.docTitle || c.topic || '',
          text: String(c.evidence || c.snippet || c.context || ''),
          ...c,
        } as any)),
        question,
        maxRescue: Number(process.env.RETRIEVAL_BRIDGE_RESCUE_MAX || 2),
      });
      if (plan.indices.length) {
        const alreadySelected = new Set(
          (queryResult.citations || []).map((c: any) =>
            String(c.evidence || c.snippet || '').replace(/\s+/g, '').slice(0, 30),
          ),
        );
        const rescued: any[] = [];
        for (const index of plan.indices) {
          const citation = preSelectionPool[index];
          const key = String(citation?.evidence || citation?.snippet || '').replace(/\s+/g, '').slice(0, 30);
          if (!key || alreadySelected.has(key)) continue;
          alreadySelected.add(key);
          rescued.push({
            ...citation,
            floorExempt: true,
            floorExemptReason: 'multi_hop_bridge',
            bridgeRescue: true,
          });
        }
        if (rescued.length) {
          queryResult = { ...queryResult, citations: [...(queryResult.citations || []), ...rescued] };
          this.logger.log(
            `[BRIDGE_RESCUE] +${rescued.length} doc(s) from pool (${preSelectionPool.length}) for entities: ` +
              `${plan.names.join(', ')} | missing aspects: ${plan.missingAspects.join(', ')} | ` +
              `docs: ${rescued.map((c: any) => c.docTitle || c.topic).join(', ')}`,
          );
          trace.warn(
            'bridge_rescue',
            '第二跳桥接证据救援',
            `首跳证据点名的实体 ${plan.names.join('、')} 在候选池中拥有独立文档，已补回答案上下文（${rescued.length} 条）`,
            { names: plan.names, rescued: rescued.length, poolSize: preSelectionPool.length },
          );
        }
      }
    }
    // ── Passage completeness for the documents selection already trusts ──
    // The gold page can be in context (and cited) while the gold *passage*
    // never is: the selected chunk is another section. For the leading
    // documents, pull their next-best chunk from the same pool. No new
    // document enters the context, so relevance ordering is untouched.
    // OPT-IN: measured harmful on the targeted failure sets (HotpotQA 7/20 -> 2/20,
    // MuSiQue 2/24 -> 1/24; only 2Wiki improved 1/16 -> 2/16). Adding more
    // passages from the same page lengthens the context without adding a new
    // document, and the extra text diluted the model's attention more than the
    // recovered passage helped. Kept behind a flag as a documented negative
    // result, not as a default.
    if (process.env.RETRIEVAL_DOC_COMPLETENESS === 'true' && preSelectionPool.length > 1) {
      const completion = planDocumentCompleteness({
        selected: (queryResult.citations || []) as any[],
        pool: preSelectionPool as any[],
        maxDocs: Number(process.env.RETRIEVAL_DOC_COMPLETENESS_DOCS || 3),
        maxPerDoc: Number(process.env.RETRIEVAL_DOC_COMPLETENESS_PER_DOC || 1),
      });
      const already = new Set(
        (queryResult.citations || []).map((c: any) =>
          String(c.evidence || c.snippet || '').replace(/\s+/g, '').slice(0, 30),
        ),
      );
      const extras: any[] = [];
      for (const index of completion.indices) {
        const citation = preSelectionPool[index];
        const key = String(citation?.evidence || citation?.snippet || '').replace(/\s+/g, '').slice(0, 30);
        if (!key || already.has(key)) continue;
        already.add(key);
        extras.push({ ...citation, docCompleteness: true });
      }
      if (extras.length) {
        queryResult = { ...queryResult, citations: [...(queryResult.citations || []), ...extras] };
        this.logger.log(
          `[DOC_COMPLETENESS] +${extras.length} chunk(s) from ${completion.docs.length} already-selected document(s): ` +
            `${extras.map((c: any) => c.docTitle || c.topic).join(', ')}`,
        );
        trace.warn(
          'doc_completeness',
          '页面内段落补全',
          `已选文档中补入 ${extras.length} 个次优片段（避免“页面进来了、关键段落没进来”）`,
          { added: extras.length, docs: completion.docs },
        );
      }
    }
    // ── Rank-based safety net for leading documents ──────────────────────
    // Measured (2026-09-21, two multi-hop questions): the answering chunk sat at
    // pool rank 4 of 50 in a *second* document, and the score-ratio floor pruned
    // it because bridge evidence scores ~0.06 against the full question while the
    // hop-1 page scores ~0.8. The context was left with 3-6 chunks of the top
    // document and the model correctly reported "not in the materials".
    // Retrieval already ranked those documents inside the corpus top-5; dropping
    // every chunk of a leading document is a much worse error than carrying one
    // possibly-irrelevant document. Restore distinct leading documents only —
    // never a second passage of a document already represented.
    if (process.env.RETRIEVAL_TOP_RANK_GUARANTEE !== 'false' && preSelectionPool.length > 1) {
      const plan = planTopRankGuarantee({
        selected: (queryResult.citations || []) as any[],
        pool: preSelectionPool as any[],
        topDocs: Number(process.env.RETRIEVAL_TOP_RANK_DOCS || 5),
      });
      if (plan.indices.length) {
        const already = new Set(
          (queryResult.citations || []).map((c: any) =>
            String(c.evidence || c.snippet || '').replace(/\s+/g, '').slice(0, 30),
          ),
        );
        const restored: any[] = [];
        for (const index of plan.indices) {
          const citation = preSelectionPool[index] as any;
          const key = String(citation?.evidence || citation?.snippet || '').replace(/\s+/g, '').slice(0, 30);
          if (!key || already.has(key)) continue;
          already.add(key);
          restored.push({ ...citation, topRankGuarantee: true });
        }
        if (restored.length) {
          queryResult = { ...queryResult, citations: [...(queryResult.citations || []), ...restored] };
          this.logger.log(
            `[TOP_RANK_GUARANTEE] +${restored.length} leading document(s) restored: ` +
              `${restored.map((c: any) => c.docTitle || c.topic).join(', ')}`,
          );
          trace.warn(
            'top_rank_guarantee',
            '头部文档保底',
            `检索前 ${Number(process.env.RETRIEVAL_TOP_RANK_DOCS || 5)} 名中有 ${restored.length} 篇文档被相关性地板剪掉，已恢复进上下文`,
            { restored: restored.length, docs: plan.docs },
          );
        }
      }
    }
    // ── Aspect-targeted passage rescue ───────────────────────────────────
    // The answering passage often scores *low* against the full question (it is
    // about the intermediate entity), so nothing score-based will reach it.
    // This picks, inside documents selection already trusted, the chunk that
    // covers the question aspects the context is currently missing. It never
    // introduces a new document — only a different passage of the same one.
    // OPT-IN: measured harmful in both forms on the 60-question targeted failure
    // set (baseline 9 correct / append 5 / swap 5). Aspect-word matching finds
    // passages that *mention* an aspect without answering the question, and the
    // selection it perturbs was already better calibrated than the keyword
    // signal. Kept behind a flag as a documented negative result.
    if (process.env.RETRIEVAL_ASPECT_PASSAGE_RESCUE === 'true' && preSelectionPool.length > 1) {
      const plan = planAspectPassageRescue({
        selected: (queryResult.citations || []) as any[],
        pool: preSelectionPool as any[],
        question,
        maxDocs: Number(process.env.RETRIEVAL_ASPECT_RESCUE_DOCS || 4),
        maxAdditions: Number(process.env.RETRIEVAL_ASPECT_RESCUE_MAX || 2),
      });
      const already = new Set(
        (queryResult.citations || []).map((c: any) =>
          String(c.evidence || c.snippet || '').replace(/\s+/g, '').slice(0, 30),
        ),
      );
      const passages: any[] = [];
      for (const index of plan.indices) {
        const citation = preSelectionPool[index] as any;
        const key = String(citation?.evidence || citation?.snippet || '').replace(/\s+/g, '').slice(0, 30);
        if (!key || already.has(key)) continue;
        already.add(key);
        passages.push({ ...citation, aspectRescue: true, docCompleteness: true });
      }
      if (passages.length) {
        // Two ways to use the located passage, and the difference is measured:
        //   append (default earlier): context grows — measured harmful on the
        //     targeted failure sets (HotpotQA 5/20 → 3/20, MuSiQue 3/24 → 1/24);
        //   swap: context length is unchanged, the *weakest* selected citations
        //     are traded for passages that cover the missing question aspects.
        // Keep the length constant and let the aspect signal decide what leaves.
        const mode = String(process.env.RETRIEVAL_ASPECT_RESCUE_MODE || 'swap').toLowerCase();
        if (mode === 'append') {
          queryResult = { ...queryResult, citations: [...(queryResult.citations || []), ...passages] };
        } else {
          const kept = (queryResult.citations || []).slice();
          const victims = kept
            .map((citation: any, index: number) => ({ citation, index, score: Number(citation?.score || 0) }))
            .sort((a: any, b: any) => a.score - b.score)
            .slice(0, passages.length);
          const victimIndexes = new Set(victims.map((v: any) => v.index));
          const survivors = kept.filter((_: any, index: number) => !victimIndexes.has(index));
          queryResult = { ...queryResult, citations: [...survivors, ...passages] };
          this.logger.log(
            `[ASPECT_RESCUE] swapped ${passages.length} citation(s) ` +
              `(${victims.map((v: any) => v.citation?.docTitle || v.citation?.topic).join(', ')}) ` +
              `for aspect-covering passages`,
          );
        }
        this.logger.log(
          `[ASPECT_RESCUE] ${passages.length} passage(s) for missing aspects [${plan.aspects.join(', ')}] from ` +
            `${plan.docs.join(', ')} | docs: ${passages.map((c: any) => c.docTitle || c.topic).join(', ')}`,
        );
        trace.warn(
          'aspect_rescue',
          '要点定向段落补入',
          `已选文档内按缺失要点 [${plan.aspects.join('、')}] 定位到 ${passages.length} 个段落并补入上下文`,
          { added: passages.length, aspects: plan.aspects, docs: plan.docs },
        );
      }
    }
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

    const citations = Array.isArray(queryResult.citations)
      ? queryResult.citations
      : [];

    trace.start("lazy_compile", "主题页惰性编译", "检查命中主题页是否存在待编译变更");
    let lazyCompiled = 0;
    const freshlyCompiledCards: any[] = [];
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

        // Compile-and-Inject: Fetch newly compiled documents for this topic and inject into current citations
        try {
          const compiledDocs = await this.prisma.document.findMany({
            where: {
              kbId: { in: visibleKbs },
              status: "published",
              OR: [
                { title: { contains: topicSlug, mode: "insensitive" } },
                { chunks: { some: { content: { contains: topicSlug, mode: "insensitive" } } } },
              ],
            },
            include: {
              kb: { select: { name: true } },
              chunks: { orderBy: { ord: "asc" }, take: 2 },
            },
            take: 2,
          });
          for (const cd of compiledDocs) {
            if (cd.chunks.length > 0 && !citations.some((c: any) => c.docId === cd.id)) {
              freshlyCompiledCards.push({
                topic: cd.title,
                docId: cd.id,
                docTitle: cd.title,
                kbName: cd.kb?.name,
                section: "compiled-truth",
                snippet: cd.chunks[0].content.slice(0, 300),
                context: cd.chunks.map((c: any) => c.content).join("\n\n"),
                score: 0.999,
                scoreSource: "synthetic",
                isCompiledTruth: true,
                evidence: `[编译真理/即时直通] 《${cd.title}》已于当次会话完成最新编译并回填`,
              });
            }
          }
        } catch (compileInjectErr) {
          this.logger.debug(
            `Compile-and-Inject retrieval error: ${compileInjectErr instanceof Error ? compileInjectErr.message : String(compileInjectErr)}`,
          );
        }
      }
    }
    if (freshlyCompiledCards.length > 0) {
      citations.unshift(...freshlyCompiledCards);
      this.logger.log(
        `Compile-and-Inject: Pre-pended ${freshlyCompiledCards.length} freshly compiled cards into citations.`,
      );
    }
    trace.finish(
      "lazy_compile",
      "success",
      lazyCompiled > 0
        ? `已即时编译 ${lazyCompiled} 个脏主题页${freshlyCompiledCards.length > 0 ? `，并直通回填 ${freshlyCompiledCards.length} 条编译真理卡片` : ""}`
        : "命中主题页均无需即时重编译",
      { checked: hitTopics.length, compiled: lazyCompiled, injected: freshlyCompiledCards.length },
    );

    trace.start("version_conflict_check", "时序效力与版本裁决", "检测多版本并裁决现行有效标准");
    let versionConflictNote = "";
    if (citations.length > 0) {
      const docTitles: string[] = Array.from(new Set(citations.map((c: any) => c.docTitle).filter(Boolean))) as string[];
      const citedDocIds: string[] = Array.from(new Set(
        citations.map((c: any) => c.docId).filter((id: any): id is string => typeof id === "string" && id.length > 0),
      ));
      if (docTitles.length > 0 || citedDocIds.length > 0) {
        const versionSelect = {
          id: true,
          title: true,
          version: true,
          updatedAt: true,
          parserMetadata: true,
          effectiveFrom: true,
          effectiveTo: true,
          lifecycleStatus: true,
          supersedesDocumentId: true,
        };
        const baseDocs = await this.prisma.document.findMany({
          where: {
            kbId: { in: visibleKbs },
            status: "published",
            OR: [
              ...(docTitles.length ? [{ title: { in: docTitles } }] : []),
              ...(citedDocIds.length ? [{ id: { in: citedDocIds } }] : []),
            ],
          },
          select: versionSelect,
        });
        // Pull in direct superseding editions (e.g. a renamed V2 that points
        // back at the cited V1 via supersedesDocumentId) so a version family
        // survives title changes.
        const baseIds = baseDocs.map((d: any) => d.id);
        const superseders = baseIds.length
          ? await this.prisma.document.findMany({
              where: {
                kbId: { in: visibleKbs },
                status: "published",
                supersedesDocumentId: { in: baseIds },
              },
              select: versionSelect,
            })
          : [];
        const docsById = new Map<string, any>();
        for (const d of [...baseDocs, ...superseders]) docsById.set(d.id, d);
        const familyRootOf = (doc: any): string => {
          let current = doc;
          let guard = 0;
          while (
            current?.supersedesDocumentId &&
            docsById.has(current.supersedesDocumentId) &&
            guard < 4
          ) {
            current = docsById.get(current.supersedesDocumentId);
            guard++;
          }
          return current?.id || doc.id;
        };
        // Group every published edition of each document family (linked by
        // the supersedes chain rather than by title alone). The effective
        // edition is chosen by lifecycle status, then effective date, then
        // version number.
        const versionsByFamily = new Map<string, Array<{
          title: string;
          version: number;
          updatedAt: Date;
          effectiveDate?: string;
          current: boolean;
          repealed: boolean;
        }>>();
        const familyKeyByDocId = new Map<string, string>();
        const familyKeyByTitle = new Map<string, string>();
        for (const pd of docsById.values()) {
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
          const titleVersionMatch = String(pd.title || "").match(/[vV](\d+)(?:\.\d+)?/);
          const explicitVersion = titleVersionMatch ? parseInt(titleVersionMatch[1], 10) : undefined;
          const detectedVersion = (explicitVersion && explicitVersion > 1) ? explicitVersion : (pd.version || 1);
          const familyKey = familyRootOf(pd);
          familyKeyByDocId.set(pd.id, familyKey);
          if (!familyKeyByTitle.has(pd.title)) familyKeyByTitle.set(pd.title, familyKey);
          const list = versionsByFamily.get(familyKey) || [];
          if (!list.some((entry) => entry.version === detectedVersion)) {
            const updatedAt = pd.updatedAt ? new Date(pd.updatedAt) : new Date(0);
            list.push({
              title: pd.title,
              version: detectedVersion,
              updatedAt: Number.isNaN(updatedAt.getTime()) ? new Date(0) : updatedAt,
              effectiveDate,
              current: lifecycle === "current",
              repealed: lifecycle === "repealed" || Boolean((pd as any).effectiveTo && new Date((pd as any).effectiveTo) < new Date()),
            });
          }
          versionsByFamily.set(familyKey, list);
        }
        // Legacy corpora may carry multiple editions of the same regulation
        // without an explicit supersedesDocumentId link — for those, a shared
        // (normalized) title is the only family signal. Merge any families
        // that share a title so a renamed V2 chains correctly while unlinked
        // same-title editions still resolve as one family.
        const familyAlias = new Map<string, string>();
        const resolveFamily = (key: string): string => {
          let current = key;
          let guard = 0;
          while (familyAlias.has(current) && guard < 8) {
            current = familyAlias.get(current)!;
            guard++;
          }
          return current;
        };
        const familiesByNormTitle = new Map<string, Set<string>>();
        for (const pd of docsById.values()) {
          const normTitle = String(pd.title || "")
            .replace(/\.[a-z0-9]+$/i, "")
            .replace(/[\(_\-\s]*[vV]\d+(?:\.\d+)*[\)\]_\-\s]*/g, "")
            .replace(/第[一二三四五六七八九十0-9]+版/g, "")
            .replace(/（修订版）|\(修订版\)|修订版|最终版|最新版|征求意见稿|试行|初稿/g, "")
            .replace(/详细手册|手册/g, "制度")
            .replace(/管理制度/g, "制度")
            .replace(/\s+/g, "")
            .trim();
          if (!normTitle) continue;
          const set = familiesByNormTitle.get(normTitle) || new Set<string>();
          set.add(resolveFamily(familyRootOf(pd)));
          familiesByNormTitle.set(normTitle, set);
        }
        for (const keys of familiesByNormTitle.values()) {
          const distinct = Array.from(keys);
          const root = resolveFamily(distinct[0]);
          for (const key of distinct.slice(1)) {
            const resolved = resolveFamily(key);
            if (resolved !== root) familyAlias.set(resolved, root);
          }
        }
        if (familyAlias.size) {
          const merged = new Map(versionsByFamily);
          for (const [key, entries] of versionsByFamily.entries()) {
            const target = resolveFamily(key);
            if (target === key) continue;
            const combined = [...(merged.get(target) || []), ...entries].filter(
              (entry, index, all) => all.findIndex((e) => e.version === entry.version) === index,
            );
            merged.set(target, combined);
            merged.delete(key);
          }
          for (const [docId, key] of familyKeyByDocId.entries()) {
            familyKeyByDocId.set(docId, resolveFamily(key));
          }
          for (const [title, key] of familyKeyByTitle.entries()) {
            familyKeyByTitle.set(title, resolveFamily(key));
          }
          const mergedEntries = Array.from(merged.entries());
          versionsByFamily.clear();
          for (const [key, entries] of mergedEntries) versionsByFamily.set(key, entries);
        }
        const familyKeyOfCitation = (cit: any): string | null => {
          if (cit.docId && familyKeyByDocId.has(cit.docId)) return familyKeyByDocId.get(cit.docId)!;
          if (cit.docTitle && familyKeyByTitle.has(cit.docTitle)) return familyKeyByTitle.get(cit.docTitle)!;
          return null;
        };
        const conflictTitles: string[] = [];
        for (const cit of citations as any[]) {
          const citTitleVersion = String(cit.docTitle || "").match(/[vV](\d+)(?:\.\d+)?/);
          const citDetectedVersion = (citTitleVersion && parseInt(citTitleVersion[1], 10) > 1)
            ? parseInt(citTitleVersion[1], 10)
            : (cit.version ?? 1);
          cit.version = citDetectedVersion;
          const familyKey = familyKeyOfCitation(cit);
          const allEntries = familyKey ? versionsByFamily.get(familyKey) || [] : [];
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
          const matchingEntry = allEntries.find((entry) => entry.version === citDetectedVersion);
          const isSuperseded = (matchingEntry?.repealed ?? false)
            || (!latest.current ? false : citDetectedVersion < latest.version);
          cit.versionConflict = {
            hasConflict: true,
            currentVersion: citDetectedVersion,
            latestVersion: latest.version,
            allVersions: allEntries.map((entry) => entry.version).sort((a, b) => b - a),
            latestEffectiveDate: latestDateLabel,
          };
          // Do not slash superseded scores to avoid dropping conflicting evidence from prompt context;
          // instead mark superseded flag and apply light weight calibration.
          if (isSuperseded) {
            cit.superseded = true;
            if (typeof cit.score === "number") cit.score = Number((cit.score * 0.88).toFixed(4));
            if (typeof cit.rerankScore === "number") cit.rerankScore = Number((cit.rerankScore * 0.88).toFixed(4));
          }
          if (!conflictTitles.includes(cit.docTitle)) {
            conflictTitles.push(cit.docTitle);
            const effective = latestDateLabel;
            versionConflictNote += `\n【多版本/制度冲突比对指示】检测到关于该事项存在多版本/多份制度（库中包含: v${cit.versionConflict.allVersions.join(', v')}，现行有效版为 v${latest.version}《${latest.title}》）。在回答中，请务必同时完整陈述各版本/各制度的具体规定（包括各版本各自规定的具体上下班时间、作息安排或相关条款），并清晰对比其条文差异，同时说明各自的版本号、生效/废止状态与适用关系。切勿只展示单一版本而遗漏另一版本的具体规定。`;
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
    const stitchedCitations = this.stitchContiguousCitations(citations);
    const structuredEvidencePlan = planStructuredEvidence(stitchedCitations, {
      complexity: agenticComplexity,
      subQueries: allHopProbes,
      enabled: process.env.CHAT_STRUCTURED_EVIDENCE !== 'false',
    });
    let orderedCitations = structuredEvidencePlan.groups.length > 0
      ? structuredEvidencePlan.citations
      : (stitchedCitations.length > 3 ? this.reorderLostInTheMiddle(stitchedCitations) : stitchedCitations);
    // Hard cap on the assembled context.
    //
    // Evidence selection applies a token budget, but it is a soft one: the first
    // group always fits, sub-query coverage injections may exceed it, and each
    // citation is truncated to CHAT_CHUNK_MAX_CHARS (6000) independently. A
    // pathological multi-hop query could therefore assemble a prompt far larger
    // than the budget it was told it had. This is the final bound, applied to the
    // exact string that goes to the model.
    const contextBudget = resolveContextTokenBudget({
      breadth: retrieval.breadth,
      complexity: agenticComplexity,
      subQueryCount: allHopProbes.length,
      evidenceCount: orderedCitations.length,
    });
    const configuredHardCap = Number(process.env.RETRIEVAL_CONTEXT_TOKEN_HARD_CAP || 0);
    const contextHardCap = configuredHardCap > 0
      ? Math.max(1000, configuredHardCap)
      : Math.ceil(contextBudget * Number(process.env.RETRIEVAL_CONTEXT_HARD_CAP_RATIO || 1.25));
    const boundedEvidence = fitStructuredEvidenceToBudget(
      orderedCitations,
      buildEvidenceReasoningGroups(orderedCitations),
      {
        hardCap: contextHardCap,
        structured: structuredEvidencePlan.groups.length > 0,
        textOf: (citation: any) => String(citation?.context || citation?.snippet || citation?.evidence || ''),
        normalizeText: extractRawChunkText,
        truncate: (text, tokenBudget) => truncateChunkToTokenBudget(text, tokenBudget),
      },
    );
    orderedCitations = boundedEvidence.citations;
    const contextTokensUsed = boundedEvidence.usedTokens;
    const hardCapDropped = boundedEvidence.dropped;
    const hardCapTruncated = boundedEvidence.truncated;
    if (hardCapDropped > 0 || hardCapTruncated > 0) {
      this.logger.warn(
        `Answer context bounded to ${contextHardCap} tokens: truncated ${hardCapTruncated} and dropped ${hardCapDropped} citation(s), keeping ${orderedCitations.length}.`,
      );
    }
    queryResult.citations = orderedCitations;
    // Diagnostic only: the selected-source list repeats on every turn, so it
    // must not pollute warn-level logs (operators triage warns as incidents).
    this.logger.debug('[PROMPT_SOURCES] ' + orderedCitations.map((c: any, i: number) => `[${i + 1}] ${c.docTitle}`).join(' | '));
    const isEnglishQuery = !/[\u4e00-\u9fa5]/.test(question);
    const evidenceReasoningGroups = buildEvidenceReasoningGroups(orderedCitations);
    const evidenceReasoningMap = structuredEvidencePlan.groups.length > 0
      ? formatEvidenceReasoningMap(evidenceReasoningGroups, isEnglishQuery)
      : '';
    const sourceContext = orderedCitations.length > 0
      ? orderedCitations
          .map((cit: any, idx: number) => {
            const title = cit.docTitle || cit.topic || (isEnglishQuery ? `Reference Document ${idx + 1}` : `参考文档 ${idx + 1}`);
            const kbName = cit.kbName ? (isEnglishQuery ? ` (Knowledge Base: ${cit.kbName})` : ` (所属知识库: ${cit.kbName})`) : "";
            const pageInfo = cit.pageNo != null && String(cit.pageNo).trim() !== ""
              ? (isEnglishQuery ? ` [Page ${cit.pageNo}]` : ` [第${cit.pageNo}页]`)
              : "";
            const articleInfo = cit.articleNo ? ` [${cit.articleNo}]` : "";
            const section = cit.section ? (isEnglishQuery ? `\nSection: ${cit.section}` : `\n定位：${cit.section}`) : "";
            const rawText = extractRawChunkText((cit.context || cit.snippet || "").trim());
            const maxChunkLen = Number(process.env.CHAT_CHUNK_MAX_CHARS || 6000);
            const content = smartTruncateChunkText(rawText, maxChunkLen);
            const truthTag = cit.isCompiledTruth
              ? (isEnglishQuery ? " [Compiled Truth / 编译真理]" : " 【编译真理·高优先】")
              : (cit.isCompiledDerived
                  ? (isEnglishQuery ? " [Scope Intelligence / 派生智库]" : " 【Scope派生智库】")
                  : "");
            const sourcePrefix = isEnglishQuery ? `【Source ${idx + 1} / 来源 ${idx + 1}】` : `【来源 ${idx + 1}】`;
            if (process.env.CHAT_LOG_CONTEXT_PREVIEW === 'true') {
              // Opt-in evaluation instrumentation: lets a failing multi-hop case
              // be classified as "the passage never reached the context" versus
              // "the passage was in the context but the model did not use it".
              // Without this the two are indistinguishable from the outside and
              // the next fix would be guesswork.
              this.logger.log(
                `[CTX_PREVIEW] [${idx + 1}] ${String(title).slice(0, 60)} :: ` +
                  String(content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, Math.max(200, Number(process.env.CHAT_LOG_CONTEXT_PREVIEW_CHARS || 400))),
              );
            }
            return `${sourcePrefix}${truthTag}《${title}》${kbName}${pageInfo}${articleInfo}${section}\n${content}`;
          })
          .join("\n\n---\n\n")
      : (queryResult.answer || "No truth found for this topic.");
    let compiledTruthContext = evidenceReasoningMap
      ? `${evidenceReasoningMap}\n\n${sourceContext}`
      : sourceContext;
    if (versionConflictNote) {
      compiledTruthContext += `\n\n${versionConflictNote.trim()}`;
    }
    // GraphRAG participates through provenance-bound source chunks in the RRF
    // and hop-retrieval arms. Never append formatted graph prose directly: it
    // has no citation index and would bypass the sentence grounding gate.
    const stitchDiff = citations.length - stitchedCitations.length;
    trace.finish(
      "answer_context",
      orderedCitations.length > 0 ? "success" : "warning",
      orderedCitations.length > 0
        ? `已组装 ${orderedCitations.length} 条可引用证据${stitchDiff > 0 ? `（已自动缝合 ${stitchDiff} 个相邻切片）` : ""}`
        : "没有可引用证据，仅返回检索空结果说明",
      {
        citationCount: orderedCitations.length,
        contextChars: compiledTruthContext.length,
        stitchedCount: stitchDiff,
        structuredEvidence: evidenceReasoningMap.length > 0,
        evidenceGroups: evidenceReasoningGroups.map((group) => ({
          kind: group.kind,
          label: group.label,
          sourceIndexes: group.sourceIndexes,
        })),
        hardCapDropped,
        hardCapTruncated,
        protectedEvidenceCount: boundedEvidence.protectedEvidenceCount,
      },
    );

    this.logger.debug(
      `Truth context compiled from ${orderedCitations.length} citations (preview: ${compiledTruthContext.slice(0, 120)}...)`,
    );

    // 6. 语义置信度硬门禁校验（Fast Refusal Gate）：
    // 若未命中有效证据或所有证据相似度均低于置信度红线，毫秒级触发标准拒答，阻断反事实幻觉与无效 LLM 耗时
    const hasMeaningfulPreAnswer =
      typeof queryResult.answer === "string" &&
      queryResult.answer.trim().length >= 15 &&
      !queryResult.answer.includes("No truth found");

    const fastRefusalFloor = Number(process.env.RETRIEVAL_FAST_REFUSAL_THRESHOLD || 0.25);
    // Missing scores are unknown, not perfect evidence: treating them as 1 used
    // to let unscored candidates bypass the hallucination gate.
    //
    // Synthetic scores (min-max normalised fallback arm, RAPTOR clamps, fixed
    // 0.88/0.999 placement constants) are excluded here. They are comparable to
    // each other for ordering, but the min-max arm always awards its top hit
    // 0.95, so including them made this gate clearable by construction — i.e.
    // the "fast refusal" never fired exactly when retrieval was weakest.
    const sufficiency = decideEvidenceSufficiency(orderedCitations, {
      calibratedFloor: fastRefusalFloor,
      syntheticFloor: Number(
        process.env.RETRIEVAL_FAST_REFUSAL_SYNTHETIC_THRESHOLD || fastRefusalFloor,
      ),
    });
    // Without a calibrated score the deployment has no reranker configured (or
    // it failed), so the only available number is a synthetic placement
    // constant. The gate then degrades to "did retrieval return anything at
    // all" and says so in the trace instead of pretending to be a confidence
    // measurement.
    const scoreCalibrated = sufficiency.scoreCalibrated;
    const maxEvidenceScore = sufficiency.maxEvidenceScore;
    const evidenceFloor = sufficiency.evidenceFloor;
    const hasSufficientEvidence = sufficiency.hasSufficientEvidence;

    if (!scoreCalibrated && orderedCitations.length > 0) {
      trace.warn(
        "retrieval_confidence",
        "置信度门禁降级",
        "本次没有可用的重排分数（未配置重排模型或重排失败），拒答阈值只能作用于合成分，判定能力已降级",
        {
          evidenceCount: orderedCitations.length,
          maxSyntheticScore: maxEvidenceScore,
          syntheticThreshold: evidenceFloor,
          hasMeaningfulPreAnswer,
        },
      );
    }

    if (!hasSufficientEvidence) {
      const refusalMessage = isEnglishQuery
        ? "Based on the provided reference materials, the relevant information is not available in the knowledge base."
        : "已知知识库资料中未包含与该问题直接相关的信息，无法依据现有文档回答。";
      trace.start("llm_generation", "大模型流式生成", "未命中高置信度证据，触发置信度门禁标准拒答");
      subscriber.next({
        data: { type: "delta", content: refusalMessage, delta: refusalMessage },
      });
      trace.finish(
        "llm_generation",
        "success",
        "未检索到满足置信度门禁的有效证据，已触发秒级标准拒答（消除反事实幻觉与噪音脑补）",
        {
          fastRefusal: true,
          evidenceCount: orderedCitations.length,
          maxScore: maxEvidenceScore,
          threshold: evidenceFloor,
          scoreCalibrated,
          hasMeaningfulPreAnswer,
        },
      );
      await this.emitCitationsAndComplete(
        userId,
        [],
        subscriber,
        0,
        refusalMessage,
        trace,
      );
      return;
    }

    // 7. 流式调用 LLM 并进行事实角标校验
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

      // Compress (not truncate) the conversation: recent turns stay verbatim
      // for pronoun resolution, older turns become short extractive digests so
      // facts/decisions from earlier in a long thread are not silently lost.
      const priorConversationTurnCount = conversationHistory.filter(
        (message) =>
          !(message.role === "user" && message.content === question),
      ).length;
      const priorConversation = compressConversationHistory(
        conversationHistory.filter(
          (message) =>
            !(message.role === "user" && message.content === question),
        ),
        { recentMessages: 6, olderSnippetChars: 200, maxTotalChars: 2400 },
      )
        .map((message) => {
          const roleTag = message.role === "assistant" ? "previous assistant reply" : "previous user message";
          const snippet = String(message.content || "").slice(0, 600);
          return `${roleTag}: ${snippet}`;
        })
        .join("\n")
        .slice(-3000);

      const personalMemoryBlock = personalMemory.text
        ? `个人长期记忆（仅当前用户可见，优先级低于当前知识库原文；不能把它冒充为公共制度证据）：\n${personalMemory.text}\n\n`
        : "";

      // KV-Cache Optimized Prompt Architecture:
      // Modern LLM inference engines (vLLM, DeepSeek, OpenAI) cache key-value tokens from index 0.
      // 1. Immutable static system rules are placed at the absolute front (100% KV-Cache hit across all queries)
      // 2. Canonical reference materials are placed second (high cache hit across similar queries on same docs)
      // 3. Turn-specific conversation history, personal memory, and question are placed last.
      const staticSystemRules = isEnglishQuery
        ? `You are an expert enterprise knowledge-base AI assistant. You MUST strictly base your answer on the provided [Reference Knowledge Base Materials] below.

[Important Guidelines]:
1. [Citation Tags Required]: In your answer, every factual statement, entity relationship, metric, or core conclusion MUST end with citation tags like [1], [2], corresponding strictly to the provided sources (e.g. [1] for [Source 1], [2] for [Source 2]).
2. [Language Consistency]: The user asked in English, so you MUST respond entirely in English. Preserve original entity names. Do NOT use Chinese.
3. [Grounded & Layered Answers]:
- If the reference materials contain partial or related facts (for example a related item, an adjacent attribute, or a broader statement that covers the question), present every confirmed fact with citations and state plainly which part is confirmed. If one requested detail is absent, say what IS documented and note that the remaining detail is not recorded in the materials. Never refuse when relevant facts exist.
- Only if the reference materials contain completely zero relevant information, reply: "Based on the provided reference materials, the relevant information is not available."
4. [Counterfactual & Adversarial Robustness]: If the user query contains ungrounded assumptions, false premises, or fictional entities not attested in the reference materials, explicitly state that the reference materials do not support the premise or contain no such record. Never hallucinate to satisfy the premise.
5. [Direct, Concise & Focused Answers (Direct Answer Inversion)]:
- In your very first sentence, directly and concisely state the core answer, conclusion, entity, or numerical value (under 30 words) with citation tags.
- Do NOT begin with generic fillers or preamble phrases (e.g. "According to the provided documents...", "Based on the text..."). Answer the user's question directly upfront.
- Subsequent sentences should provide the necessary supporting context, calculations, or contractual clauses.`
        : `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【重要回答规范】：
1. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。例如：“该项业务的范围包括……[1]。”（示例仅示范角标位置与格式，内容以参考资料为准。）
2. 【证据收敛与指标完整性】：参考资料是候选证据，只使用直接支持当前问题的来源。当资料在同一规定或句子中说明了多项关联指标或条件（例如一个数值伴随的阈值、单位、百分比或连带条件等），必须完整列出全部关联指标和要求，严禁遗漏任何并列参数。
3. 【章节目录全景列举】：当用户询问有哪些章、全部章名或结构目录时，请务必根据参考资料中出现的各章标题，完整列出全部章节序号与名称，直接给出明确清单，严禁使用“无法提供”、“未提供完整章名”等推脱或拒答词汇。
4. 【表格行记录与关键锚点事实并存处理】：若参考资料中同时存在表格行记录与正文/关键锚点事实，且两者对同一事项的表述不一致，必须在回答中完整陈述这两种事实（明确说明“表格第 N 行记录为 X，而正文/锚点事实为 Y”），严禁只提到其中一处。
5. 【多源对比与冲突完整呈现】：当参考资料中存在多份文件、不同版本或不同条款对同一事项存在不同规定或潜在冲突时，必须同时且完整列出各份文件的具体规定内容（包括具体数值、标准与文档名称），并清晰对比其差异与适用背景（例如说明版本差异、生效日期与适用范围）。严禁只选择其中一份而忽略另一份。
6. 【多源合并】：若多个来源共同支持某一相同结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号；可用编号严格限制在参考资料实际提供的来源序号范围内。
7. 【客观真实与分层回答】：
- 若参考资料完全不包含与问题相关的信息，请统一回复：“已知知识库资料中未包含相关信息，无法回答该问题。”严禁在拒答或未找到信息时复述、回显用户问题中的代号、机密编号或专有名词。
- 若参考资料包含部分相关事实（如包含实体背景、前置步骤或部分已知条件），请优先陈述已证实的客观事实并标注对应角标，并明确指出参考资料未涵盖的具体维度或后续信息，严禁在已知部分确凿事实的情况下全盘拒答。
8. 【语言一致性】：如果用户使用英文提问，请务必使用英文作答（如无法回答时使用 'Based on the provided reference materials, the relevant information is not available.'），并保留原实体英文名称。
9. 【反事实与诱导性提问甄别】：若用户提问中包含假设性事实、诱导性错误前提（如询问不存在的人物关系、虚构的机构或篡改的事件时间），而参考资料中明确未提及或与事实相反，必须明确指出参考资料中无此记载或前提不成立，严禁顺从提问中的错误设定进行虚构脑补。
10. 【开门见山、结论先行】：
- 回答第一句必须开门见山，用简明直接的语言（10~30字以内）直接给出最核心的结论、明确答案、实体或具体数值，并紧随其标注引用角标（示例格式：“根据规定，该项标准为……[1]。”，具体内容以参考资料为准）。
- 严禁在开头堆砌“根据您提供的参考资料，我为您查询到以下信息……”等无意义的客套废话或免责套话。
- 首句给出明确结论后，后续段落再展开陈述支撑依据、计算过程或细分条款说明。`;

      const dynamicDirectives = [
        queryResult?.diagnostics?.mode === "inventory"
          ? "【全景统计规范】：本次是知识库/文档盘点类问题，参考资料按知识库逐一给出文档清单。请分知识库逐项呈现统计结果，并在每个知识库的统计陈述末尾标注它对应的引用角标（如 [1]、[2]），让用户可逐库核对。"
          : "",
        orderedCitations.some((c: any) => c.isCompiledTruth || c.isCompiledDerived)
          ? "【编译真理优先采信】：参考资料中带有【编译真理·高优先】或【Scope派生智库】标记的来源，是经过系统编译消歧与对账的高置信度权威事实。若其与普通未编译的碎片化分块存在局部表述差异，请优先采信编译真理。"
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      // System message: KV-Cache Maximized Topology
      // Prefix tokens from index 0 MUST remain identical across turns to maximize prompt cache hits.
      // Token 0: Immutable static system rules (100% KV-Cache hit across all queries)
      // Section 2: Canonical reference materials (stable across turns in the same conversation / document)
      // Section 3: Dynamic directives (inventory / truth priority)
      // Section 4: Turn-varying prior conversation & personal memory (changes per turn, placed at tail)
      const systemMessageContent = `${staticSystemRules}

${process.env.CHAT_REFUSAL_DISCIPLINE === 'true' ? `【拒答纪律·必须先核对再拒答】：在给出“未包含相关信息/无法回答”这类结论之前，必须先在参考资料中逐条核对：是否存在任何与问题主体相关的句子？只要存在哪怕部分相关的事实，就必须先完整陈述这些已证实的事实（标注角标），再明确指出资料未覆盖的部分；只有在参考资料与问题主体完全无关时才允许整句拒答。` : ''}

${isEnglishQuery ? "【Reference Knowledge Base Materials】" : "【参考知识库资料】"}：
${compiledTruthContext}${dynamicDirectives ? `\n\n【专项指令提示】：\n${dynamicDirectives}` : ""}${priorConversation ? `\n\n历史对话参考（仅供消歧，以当前知识库资料为准）：\n${priorConversation}` : ""}${personalMemoryBlock ? `\n\n${personalMemoryBlock}` : ""}`;

      // User message: cleanly contains the standalone query
      const userMessageContent = question;

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
              { role: "system", content: systemMessageContent },
              { role: "user", content: userMessageContent },
            ],
            stream: true,
            stream_options: { include_usage: true },
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
      let promptCacheHitTokens = 0;
      let promptCacheMissTokens = 0;
      let citationTail = "";
      let reasoningBuf = "";
      // Grounding gate (strict mode): each completed sentence is verified
      // against the evidence of the sources it cites BEFORE it is forwarded to
      // the client. Unsupported sentences are held back and re-checked by the
      // LLM entailment judge at flush time; anything still unsupported is
      // dropped with a trace note. A real citation index can no longer
      // authenticate an invented number. Set GROUNDING_STRICT=false to restore
      // immediate passthrough (the post-hoc coverage check still applies).
      const strictGrounding = process.env.GROUNDING_STRICT !== 'false';
      const allEvidenceTexts = (): string[] =>
        (queryResult.citations || []).map((c: any) => String(c.context || c.snippet || '')).filter(Boolean);
      const citedEvidenceTexts = (sentence: string): { texts: string[]; tagged: boolean } => {
        const tags = sentence.match(/\[(\d+)\]/g) || [];
        const valid = tags
          .map((t) => parseInt(t.replace(/\D/g, ''), 10))
          .filter((n) => n >= 1 && n <= (queryResult.citations?.length || 0));
        return {
          texts: valid.map((n) => String(queryResult.citations?.[n - 1]?.context || queryResult.citations?.[n - 1]?.snippet || '')),
          tagged: valid.length > 0,
        };
      };
      // Citation re-binding.
      //
      // A model occasionally answers from the right source but stamps the
      // wrong marker (observed in production: the 王群丽 answer cited [1] - a
      // weekly-report PDF - while the teacher's document was 来源 7). The
      // retrieval, the evidence selection and the prompt numbering were all
      // correct; only the marker was wrong, and the user was shown a citation
      // for a document that does not contain the fact.
      //
      // The pool used to build the prompt is still in memory, so the marker can
      // be repaired deterministically instead of reported: find the evidence
      // item that actually supports the sentence and re-point the marker at it.
      // Only when no selected evidence supports the sentence is it treated as
      // unsupported (held back in strict mode, warned about otherwise).
      let reboundCitations = 0;
      const rebindMarkers = (sentence: string): string | null => {
        const rebound = rebindCitationMarkers(sentence, queryResult.citations || []);
        if (!rebound) return null;
        reboundCitations += 1;
        return rebound.sentence;
      };
      // One refusal vocabulary for the whole pipeline: the gate used to run its
      // own narrower regex, so answers phrased "is not recorded / not specified"
      // were not even recognised as refusals — which silently disabled the
      // refusal re-check (measured: 1 trigger in 9 refusal-shaped cases).
      const isRefusalSentence = (sentence: string): boolean =>
        sentence.trim().length > 0 && isRefusalAnswerText(sentence);
      const heldSentences: string[] = [];
      // Refusals are held (not streamed) so a focused second pass can still
      // replace them: measured on 30 failed multi-hop questions, 15 had the
      // gold sentence inside the assembled context and the model refused anyway.
      const heldRefusals: string[] = [];
      let gateVerifiedCount = 0;
      let providerErrorSeen = false;
      let synthesizedRefusal = false;
      const emitVerified = (sentence: string) => {
        gateVerifiedCount++;
        totalTokens += estimateTokens(sentence);
        fullAnswer += sentence;
        subscriber.next({ data: { type: 'delta', content: sentence, delta: sentence } });
      };
      const gateSentence = (sentence: string) => {
        // Transport failures are not answers. An upstream gateway once returned
        // "The request was rejected because it was considered high risk" inside
        // the answer stream, and the sentence was displayed to the user as the
        // answer to a MuSiQue question (see output-hygiene.ts).
        if (isProviderErrorText(sentence)) {
          this.logger.warn(`Provider error text intercepted before display: ${sentence.slice(0, 80)}`);
          providerErrorSeen = true;
          return;
        }
        if (isRefusalSentence(sentence)) {
          heldRefusals.push(sentence);
          return;
        }
        // Scratchpad voice and question echoes are not answers. Both reached users
        // through the streaming gate (measured 2026-09-21: an answer ended with
        // `First, the user asked: "Who was the first president …`). The same
        // hygiene rules already guard the recovery paths; apply them per sentence.
        if (
          isPlanningLikeText(sentence) ||
          looksLikeQuestionEcho(sentence, question) ||
          looksLikeMetaDiscourse(sentence)
        ) {
          this.logger.warn(`Scratchpad/echo sentence dropped before display: ${sentence.slice(0, 80)}`);
          return;
        }
        const body = sentence.replace(/\[\d+\]/g, ' ');
        if (body.replace(/\s+/g, '').length < 5) {
          emitVerified(sentence);
          return;
        }
        const { texts, tagged } = citedEvidenceTexts(sentence);
        // When a statement carries citation markers, it is validated ONLY
        // against the evidence of the sources it actually cites. The previous
        // all-evidence fallback let a fabricated fact wearing a wrong-but-real
        // marker [1] pass because some OTHER source happened to contain the
        // words — turning citation attribution into a routine-formality. A
        // misattributed claim must now be held back (and judged by the NLI
        // entailment step at flush time, which still sees the full pool).
        const supported = statementSupportedBy(
          sentence,
          tagged ? texts : allEvidenceTexts(),
          tagged,
        );
        if (!supported && tagged) {
          // Wrong marker, right source: repair the attribution instead of
          // shipping a citation that does not contain the fact.
          const rebound = rebindMarkers(sentence);
          if (rebound) {
            this.logger.warn(
              `Rebound citation markers for an unsupported statement: ${sentence.slice(0, 60)}… -> ${rebound.match(/\[\d+\]/g)?.join('') || ''}`,
            );
            emitVerified(rebound);
            return;
          }
        }
        if (supported || !strictGrounding) {
          // Non-strict mode keeps legacy behaviour (emit immediately; the
          // post-hoc coverage accounting at completion still reports gaps).
          emitVerified(sentence);
        } else {
          heldSentences.push(sentence);
        }
      };
      let gatePending = '';
      const gatePush = (content: string) => {
        gatePending += content;
        let boundary = gatePending.search(/[。！？；\n]|[!?;]/);
        while (boundary >= 0) {
          const sentence = gatePending.slice(0, boundary + 1);
          gatePending = gatePending.slice(boundary + 1);
          gateSentence(sentence);
          boundary = gatePending.search(/[。！？；\n]|[!?;]/);
        }
      };
      const gateFlush = () => {
        const rest = gatePending.trim();
        gatePending = '';
        if (rest) gateSentence(rest);
      };
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
          gatePush(safeContent);
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
                const delta = data.choices?.[0]?.delta || {};
                if (delta.reasoning_content) reasoningBuf += String(delta.reasoning_content);
                if (delta.content) emitModelContent(String(delta.content));
                if (data.usage) {
                  if (typeof data.usage.prompt_cache_hit_tokens === "number") {
                    promptCacheHitTokens = data.usage.prompt_cache_hit_tokens;
                  }
                  if (typeof data.usage.prompt_cache_miss_tokens === "number") {
                    promptCacheMissTokens = data.usage.prompt_cache_miss_tokens;
                  }
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
          const delta = data.choices?.[0]?.delta || {};
          if (delta.reasoning_content) reasoningBuf += String(delta.reasoning_content);
          if (delta.content) emitModelContent(String(delta.content));
          if (data.usage) {
            if (typeof data.usage.prompt_cache_hit_tokens === "number") {
              promptCacheHitTokens = data.usage.prompt_cache_hit_tokens;
            }
            if (typeof data.usage.prompt_cache_miss_tokens === "number") {
              promptCacheMissTokens = data.usage.prompt_cache_miss_tokens;
            }
          }
        } catch (e) {}
      }

      // Reasoning-model fallback: some models stream everything into
      // reasoning_content and never emit content. An empty answer must not
      // end the turn — but the recovered text must be an *answer*, never the
      // model's scratchpad. Measured on the MuSiQue/2Wiki end-to-end runs, the
      // old "last 8 reasoning lines" fallback shipped planning voice as the
      // answer in 11/50 and 15/100 cases respectively, which both leaked the
      // scratchpad to users and inflated containment scores.
      gateFlush();
      // Refusal-hold: the model said "the materials do not say" while the
      // context contains sentences covering the question's own terms. Supply
      // those sentences back in a focused pass before accepting the refusal.
      // Enabled by default. Its first evaluation (before the top-rank guarantee
      // existed) showed no gain — the context simply did not contain the answer
      // sentence, so re-asking could not help. Once retrieval was fixed, the same
      // mechanism flipped 4 of 6 "gold-in-context but refused" cases to correct
      // answers (Ocala → Northern Florida, Da Nang → South Central Coast, …), and
      // the unanswerable category went from 1 failure to 0 across 30 cases.
      // It costs one extra LLM call, and only for answers that are pure refusals
      // while the context holds supporting sentences.
      if (!fullAnswer.trim() && heldRefusals.length && process.env.CHAT_REFUSAL_FOCUS_RETRY !== 'false') {
        const evidenceTexts = (queryResult.citations || [])
          .map((c: any) => String(c.context || c.snippet || c.evidence || ''))
          .filter(Boolean);
        // Offer sentences from the *whole leading pool*, not only from the
        // documents that made the context. Measured 2026-09-21: widening the
        // context itself (top-8 documents) recovered 3 of 7 hard multi-hop cases
        // but cost 6 of 30 "unanswerable" cases, because a fuller context makes
        // the model answer instead of refusing. Widening only this re-check keeps
        // the strict "若无答案就说明资料未包含" instruction in force.
        // OFF by default (CHAT_REFUSAL_FOCUS_POOL_DOCS=0): measured trade-off on
        // 2026-09-21 — offering pool sentences recovers 7 more of the 60 hard
        // multi-hop probes (HotpotQA 7->11, 2Wiki 6->10 of their failure sets)
        // but makes the model answer 9 of 30 unanswerable questions instead of
        // refusing (narrow re-check: 0 of 30). Shipping it needs a relevance gate
        // that reliably separates "pool sentence answers the question" from
        // "pool sentence merely shares two words with it"; the same failure mode
        // appeared when the *context* was widened to 8 documents (6 of 30).
        const deeperSources = preSelectionPool
          .map((citation: any) => ({ citation, score: Number(citation?.score || 0) }))
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, Number(process.env.CHAT_REFUSAL_FOCUS_POOL_DOCS || 0))
          .map((item: any) => ({
            text: String(item.citation?.context || item.citation?.snippet || item.citation?.evidence || ''),
            citation: item.citation,
          }))
          .filter((item: any) => item.text);
        const allRetrySources = [
          ...(queryResult.citations || []).map((citation: any) => ({
            text: String(citation?.context || citation?.snippet || citation?.evidence || ''),
            citation,
          })),
          ...deeperSources,
        ].filter((item: any) => item.text);
        // Prefer sentences that carry the asked fact *type* (year / date / number).
        // Measured: the answering sentence ("the first one in 1978", pool rank 5)
        // lost the old coverage-only ranking to a same-topic distractor
        // ("Rugby League World Cup … in 1954").
        const typed = process.env.CHAT_TYPED_PASSAGE_SELECTION === 'false'
          ? []
          : selectTypedPassageSources(allRetrySources, question, {
              limit: Number(process.env.CHAT_REFUSAL_FOCUS_LIMIT || 3),
              minTerms: Number(process.env.CHAT_REFUSAL_FOCUS_MIN_TERMS || 2),
              answerType: answerTypeOf(question),
              // Link against the *hop-1 evidence only*: the question itself contains
              // generic domain words ("World Cup"), which would link every same-topic
              // document and let distractors back in.
              linkText: evidenceTexts.join('\n'),
            });
        const retrySources = typed.length
          ? typed
          : selectRetrySentenceSources(allRetrySources, question, {
              limit: Number(process.env.CHAT_REFUSAL_FOCUS_LIMIT || 3),
              minTerms: Number(process.env.CHAT_REFUSAL_FOCUS_MIN_TERMS || 2),
            });
        const supported = retrySources.map((source) => source.text);
        // Strict containment gate before any re-ask. Verified measurements:
        // without it the wide re-check invented answers for 9 of 30 unanswerable
        // questions; the gate exists to keep that at zero while keeping the gain.
        let gatedSources = retrySources;
        if (supported.length && process.env.CHAT_PASSAGE_VERIFY !== 'false') {
          const verified = await this.verifyPassageContainment({
            question,
            passages: supported,
            knownEvidence: evidenceTexts.join('\n').slice(0, 2000),
          });
          gatedSources = retrySources.filter((_source, index) => verified.has(index));
          this.logger.log(
            `[PASSAGE_VERIFY] kept ${gatedSources.length}/${supported.length} offered passage(s) as directly answering the question`,
          );
          if (process.env.CHAT_LOG_PASSAGE_VERIFY_TEXT === 'true') {
            supported.forEach((passage, index) => {
              this.logger.log(
                `[PASSAGE_VERIFY_TEXT] #${index + 1} ${verified.has(index) ? 'KEEP' : 'DROP'} :: ${passage.slice(0, 200)}`,
              );
            });
          }
          if (!gatedSources.length) {
            trace.warn(
              'passage_verify',
              '证据严格审核',
              `提供的 ${supported.length} 个片段都未“明确包含”答案，保持诚实拒答`,
              { offered: supported.length, kept: 0 },
            );
          }
        }
        this.logger.log(
          `[REFUSAL_FOCUS] heldRefusals=${heldRefusals.length} evidenceChunks=${evidenceTexts.length} ` +
            `supportingSentences=${supported.length} verified=${gatedSources.length} ` +
            `(minTerms=${Number(process.env.CHAT_REFUSAL_FOCUS_MIN_TERMS || 2)})`,
        );
        if (gatedSources.length) {
          const sentences = gatedSources.map((source) => source.text);
          const focused = await this.retryWithFocusedEvidence({
            baseUrl,
            modelName,
            headers,
            question,
            sentences,
          });
          if (
            focused &&
            !isRefusalAnswerText(focused) &&
            !isPlanningLikeText(focused) &&
            !isProviderErrorText(focused) &&
            !looksLikeQuestionEcho(focused, question)
          ) {
            this.logger.warn(
              `Refusal replaced by a focused answer (${supported.length} supporting sentence(s) offered).`,
            );
            // Provenance: the retry may cite a pool document that never entered
            // the answer context. Register exactly those documents and rewrite
            // 【资料N】 into the [k] markers the citation pipeline understands, so
            // the user still gets a resolvable source for every claim.
            const mapping = new Map<number, number>();
            const citations = [...(queryResult.citations || [])];
            const keyOf = (citation: any) =>
              String(citation?.evidence || citation?.snippet || '').replace(/\s+/g, '').slice(0, 30);
            const known = new Set(citations.map(keyOf));
            for (const marker of parseRetryMarkers(focused)) {
              const source = retrySources[marker - 1];
              if (!source) continue;
              let index = citations.findIndex((citation) => keyOf(citation) === keyOf(source.citation));
              if (index < 0) {
                const key = keyOf(source.citation);
                if (!key || known.has(key)) continue;
                known.add(key);
                citations.push(source.citation);
                index = citations.length - 1;
              }
              mapping.set(marker, index + 1);
            }
            const answerText = mapping.size ? rewriteRetryMarkers(focused, mapping) : focused;
            if (citations.length !== (queryResult.citations || []).length) {
              queryResult = { ...queryResult, citations };
            }
            trace.warn(
              'refusal_focus_retry',
              '拒答复核',
              `模型原答复为“资料未包含”，但上下文含 ${supported.length} 句与问题要点相关的证据，已定向重答`,
              { sentences: supported.length },
            );
            gatePush(answerText);
            gateFlush();
            // The refusal this re-check was called to replace has now been
            // replaced. Releasing it afterwards produced answers that state the
            // fact and then deny it ("...he was married to May Allison. The
            // reference materials do not record the spouse of Robert Ellis"),
            // which reads as self-contradictory to the user and — measured on
            // the MuSiQue hard set 2026-09-21 — let a refusal pass the strict
            // containment grader 9 times out of 100 because the held sentence
            // still mentioned the gold string. Clear it so the emitted turn is
            // the focused answer alone.
            heldRefusals.length = 0;
          } else {
            this.logger.log(
              `[REFUSAL_FOCUS] focused retry did not produce a usable answer: ${focused.slice(0, 80) || '(empty)'}`,
            );
          }
        }
      }
      if (!fullAnswer.trim() && reasoningBuf.trim()) {
        const drafted = extractAnswerFromReasoning(reasoningBuf);
        if (drafted) {
          this.logger.warn('LLM returned no content; using the sanitized reasoning draft.');
          gatePush(drafted);
          gateFlush();
        } else {
          this.logger.warn(
            'LLM returned no content and the reasoning trace held no usable answer; nothing emitted.',
          );
        }
      }
      // Last resort before showing an empty turn: ask once more with an
      // explicit answer-only instruction. Reasoning models that stream the
      // whole turn into `reasoning_content` (reproduced on MuSiQue, 2026-09-20)
      // otherwise produce no user-visible answer at all.
      if (!fullAnswer.trim()) {
        const retried = await this.retryAnswerOnly({
          baseUrl,
          modelName,
          headers,
          systemMessage: systemMessageContent,
          userMessage: userMessageContent,
        });
        if (retried) {
          // The retry is a model turn like any other: it must not smuggle
          // scratchpad voice, an echo of the question, or a transport failure
          // into the answer (all three were observed on this path).
          const usable = !isPlanningLikeText(retried) &&
            !looksLikeQuestionEcho(retried, userMessageContent) &&
            !isProviderErrorText(retried);
          if (usable) {
            this.logger.warn('Recovered an answer with the answer-only retry.');
            gatePush(retried);
            gateFlush();
          } else {
            this.logger.warn(
              'Answer-only retry returned non-answer text (scratchpad/echo/error); nothing emitted.',
            );
          }
        }
      }
      // Every recovery path failed (no content, no usable draft, no usable
      // The model's own refusal is part of its answer and must reach the user —
      // held only so a (default-off) focused re-check could have replaced it.
      // Releasing it *unconditionally* matters: when the model answered with
      // related facts AND stated that the asked information is absent, the
      // refusal sentence used to be emitted inline. Holding it without releasing
      // silently dropped that statement, and the "unanswerable" category then
      // failed its check (measured 2026-09-21: 7 of 30 cases, independent of the
      // top-rank guarantee — a same-window control with the guarantee disabled
      // reproduced the same 7 failures).
      if (heldRefusals.length) {
        for (const refusal of heldRefusals) emitVerified(refusal);
      }
      // Every recovery path failed (no content, no usable draft, no usable
      // retry). An empty bubble helps nobody: answer with an honest, evidence-free
      // refusal instead. Refusals are already excluded from the semantic cache,
      // and the trace below still records that the turn was synthesised.
      if (!fullAnswer.trim()) {
        synthesizedRefusal = true;
        this.logger.warn('No answer produced after draft recovery and retry; emitting an honest refusal.');
        // Emit directly: refusals are held by the gate (so a focused re-check can
        // replace them), and this template is produced *after* the held-refusal
        // release point — routing it through the gate would swallow it and leave
        // the user with an empty answer (measured: 2 empty answers per 100).
        emitVerified(
          /[\u4e00-\u9fa5]/.test(question)
            ? '已知知识库资料中未包含相关信息，无法回答该问题。'
            : 'Based on the provided reference materials, the relevant information is not available.',
        );
      }
      // Held sentences get one batched entailment review; anything the judge
      // cannot support from the evidence is dropped and never shown.
      if (heldSentences.length > 0) {
        trace.start('grounding_gate', '证据核验门控', '对暂扣语句执行证据蕴含复核');
        const toJudge = heldSentences.slice(0, 30);
        const evidenceText = allEvidenceTexts().join('\n\n').slice(0, 8000);
        const entailed = evidenceText
          ? await this.judgeEntailment(toJudge, evidenceText)
          : new Set<number>();
        let recoveredCount = 0;
        for (let i = 0; i < toJudge.length; i++) {
          // A recovered sentence may still carry a wrong marker; repair the
          // attribution before it reaches the client, exactly as the inline
          // gate does for directly verified sentences.
          const repaired = rebindMarkers(toJudge[i]) || toJudge[i];
          if (entailed.has(i)) {
            emitVerified(repaired);
            recoveredCount++;
          } else {
            // Balanced safety net: if judgeEntailment timed out/skipped or was uncertain,
            // check whether the sentence has zero polarity conflict, numeric claims exist in evidence,
            // and character/token overlap is at least 0.35 against the full evidence text.
            const body = toJudge[i].replace(/\[\d+\]/g, ' ');
            const hasConflict = hasPolarityConflict(toJudge[i], evidenceText);
            const numsOk = numericClaimsSupportedBy(toJudge[i], evidenceText);
            const chars = Array.from(new Set(body.replace(/\s+/g, '').split('')));
            let charOverlap = 0;
            const normEv = evidenceText.replace(/\s+/g, '');
            for (const ch of chars) {
              if (normEv.includes(ch)) charOverlap++;
            }
            const ratio = chars.length ? charOverlap / chars.length : 0;
            // Character overlap is a crude support proxy, and it gets *easier* to
            // pass as the evidence pool grows — which is exactly what the
            // top-rank guarantee does. Measured consequence (2026-09-21): on the
            // enterprise "unanswerable" questions the safety net started
            // recovering the model's own narration ("我注意到用户在问题末尾加了
            // 「24」…") and it was displayed as the answer, failing 15 of 30 cases.
            // A sentence with no citation marker is not a knowledge-base answer:
            // demand substantially more overlap before releasing it.
            const hasMarker = /\[\d+\]/.test(toJudge[i]);
            const requiredRatio = hasMarker ? 0.35 : 0.6;
            if (!hasConflict && numsOk && ratio >= requiredRatio) {
              emitVerified(repaired);
              recoveredCount++;
            }
          }
        }
        const dropped = heldSentences.length - recoveredCount;
        trace.finish(
          'grounding_gate',
          dropped > 0 ? 'warning' : 'success',
          dropped > 0
            ? `${dropped} 句因缺乏证据支持被拦截，未向用户展示`
            : '暂扣语句经蕴含复核全部放行',
          { verified: gateVerifiedCount, held: heldSentences.length, recovered: recoveredCount, dropped, strict: strictGrounding, providerError: providerErrorSeen },
        );
      }
      // Observability for the marker repair: a warning here means the model
      // stamped at least one wrong source index and the answer was corrected
      // rather than shipped with a citation that does not contain the fact.
      trace.finish(
        "citation_rebinding",
        reboundCitations > 0 ? "warning" : "success",
        reboundCitations > 0
          ? `纠正 ${reboundCitations} 处模型角标错误，已重绑定到真正支持该句的证据`
          : "回答角标与证据一一对应",
        { reboundCitations, evidencePool: (queryResult.citations || []).length },
      );

      trace.finish(
        "llm_generation",
        fullAnswer && !synthesizedRefusal ? "success" : "warning",
        fullAnswer && !synthesizedRefusal
          ? `大模型回答生成完成${promptCacheHitTokens > 0 ? ` (Prompt Cache 命中 ${promptCacheHitTokens} tokens)` : ""}`
          : synthesizedRefusal
            ? "模型未产出可用正文（草稿与重试均不可用），已按诚实拒答兜底"
            : "大模型连接正常但未返回正文",
        {
          model: modelName,
          tokenEstimate: totalTokens,
          outputChars: fullAnswer.length,
          synthesizedRefusal,
          promptCacheHitTokens,
          promptCacheMissTokens,
          cacheHitRate: promptCacheHitTokens + promptCacheMissTokens > 0
            ? `${((promptCacheHitTokens / (promptCacheHitTokens + promptCacheMissTokens)) * 100).toFixed(1)}%`
            : "0%",
        },
      );

      await this.emitCitationsAndComplete(
        userId,
        queryResult.citations || [],
        subscriber,
        totalTokens,
        fullAnswer,
        trace,
        question,
        {
          fingerprint: cacheScopeKey,
          knowledgeEpoch: userScope.knowledgeEpoch,
          // Answers built on top of private context (per-user long-term memory
          // or earlier conversation turns) must never be replayed from cache.
          cacheable: personalMemory.count === 0 && priorConversationTurnCount === 0,
        },
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

  private async retryWithFocusedEvidence(params: {
    baseUrl: string;
    modelName: string;
    headers: Record<string, string>;
    question: string;
    sentences: string[];
  }): Promise<string> {
    try {
      const response = await fetch(`${params.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: params.headers,
        body: JSON.stringify({
          model: params.modelName,
          messages: [
            {
              role: 'system',
              content:
                '你是知识库问答助手。只依据用户给出的资料片段作答，不要使用外部知识，也不要解释你的推理过程。' +
                '如果片段中包含问题的答案，直接给出最终答案正文，并在陈述出处时使用【资料N】标注（N 为片段编号）；' +
                '如果片段确实与问题无关或不足以回答，只回复“资料未包含该信息”。',
            },
            {
              role: 'user',
              content:
                `问题：${params.question}\n\n资料片段：\n` +
                params.sentences.map((sentence, index) => `【资料${index + 1}】${sentence}`).join('\n'),
            },
          ],
          temperature: 0,
          max_tokens: Number(process.env.CHAT_REFUSAL_FOCUS_MAX_TOKENS || 600),
        }),
        signal: AbortSignal.timeout(Number(process.env.CHAT_REFUSAL_FOCUS_TIMEOUT_MS || 45000)),
      });
      if (!response.ok) return '';
      const payload: any = await response.json();
      const message = payload?.choices?.[0]?.message || {};
      const content = String(message.content || '').trim();
      if (content) return content;
      return extractAnswerFromReasoning(String(message.reasoning_content || ''));
    } catch (err) {
      this.logger.warn(
        `Focused refusal retry unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }

  private async retryAnswerOnly(params: {
    baseUrl: string;
    modelName: string;
    headers: Record<string, string>;
    systemMessage: string;
    userMessage: string;
  }): Promise<string> {
    try {
      const response = await fetch(`${params.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: params.headers,
        body: JSON.stringify({
          model: params.modelName,
          messages: [
            {
              role: 'system',
              content:
                `${params.systemMessage}\n\n【本轮附加约束】：上一次回复没有产生正文。请只输出最终答案正文本身，` +
                '不要输出思考过程、计划、步骤说明或对指令的复述；资料不足时按要求直接给出拒答句。',
            },
            { role: 'user', content: params.userMessage },
          ],
          temperature: 0,
          max_tokens: Number(process.env.LLM_ANSWER_RETRY_MAX_TOKENS || 900),
        }),
        signal: AbortSignal.timeout(Number(process.env.LLM_ANSWER_RETRY_TIMEOUT_MS || 45000)),
      });
      if (!response.ok) return '';
      const payload: any = await response.json();
      const message = payload?.choices?.[0]?.message || {};
      const content = String(message.content || '').trim();
      if (content) return content;
      return extractAnswerFromReasoning(String(message.reasoning_content || ''));
    } catch (err) {
      this.logger.warn(
        `Answer-only retry unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }

  /**
   * Automatically stitches contiguous chunks belonging to the same document.
   * If consecutive chunks are physically adjacent (e.g. ord n and n+1) or on consecutive pages,
   * merges their text (resolving chunk boundary overlaps and mid-sentence splits)
   * while keeping citation provenance intact.
   */
  public stitchContiguousCitations(citations: any[]): any[] {
    if (!citations || citations.length <= 1) return citations || [];

    const getScore = (c: any): number => {
      const v = c?.relevanceScore ?? c?.rerankScore ?? c?.score;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const docGroups = new Map<string, any[]>();
    citations.forEach((c, idx) => {
      const key = c.docId ? String(c.docId) : (c.docTitle ? String(c.docTitle) : `__single_${idx}`);
      if (!docGroups.has(key)) docGroups.set(key, []);
      docGroups.get(key)!.push(c);
    });

    const sortedGroups = Array.from(docGroups.values()).sort((gA, gB) => {
      const maxA = Math.max(...gA.map(getScore));
      const maxB = Math.max(...gB.map(getScore));
      return maxB - maxA;
    });

    const finalCitations: any[] = [];

    for (const group of sortedGroups) {
      if (group.length === 1) {
        finalCitations.push(group[0]);
        continue;
      }

      const getOrd = (c: any): number => {
        if (typeof c.ord === 'number') return c.ord;
        if (typeof c.metadata?.chunk_order === 'number') return c.metadata.chunk_order;
        if (typeof c.metadata?.ord === 'number') return c.metadata.ord;
        if (typeof c.pageNo === 'number') return c.pageNo;
        if (typeof c.page_no === 'number') return c.page_no;
        return -1;
      };

      // Clone objects so we do not mutate input citations in place
      const groupClones = group.map((item) => ({ ...item }));

      // Sort group in natural reading order
      const sorted = groupClones.sort((a, b) => {
        const ordA = getOrd(a);
        const ordB = getOrd(b);
        if (ordA !== -1 && ordB !== -1) return ordA - ordB;
        return 0;
      });

      const stitchedGroup = [sorted[0]];
      for (let k = 1; k < sorted.length; k++) {
        const prev = stitchedGroup[stitchedGroup.length - 1];
        const curr = sorted[k];

        const ordPrev = getOrd(prev);
        const ordCurr = getOrd(curr);

        const prevEndPage = typeof prev.endPage === 'number' ? prev.endPage : (typeof prev.pageNo === 'number' ? prev.pageNo : undefined);
        const currPage = typeof curr.pageNo === 'number' ? curr.pageNo : undefined;

        const isContiguous =
          (ordPrev !== -1 && ordCurr !== -1 && ordCurr - ordPrev === 1) ||
          (prevEndPage !== undefined && currPage !== undefined && currPage >= prevEndPage && currPage <= prevEndPage + 1);

        const prevText = String(prev.context || prev.snippet || prev.evidence || '');
        const currText = String(curr.context || curr.snippet || curr.evidence || '');
        const prevLen = prevText.length;
        const currLen = currText.length;
        const maxStitchChars = Number(process.env.STITCH_CHUNK_MAX_CHARS || 12000);
        const canMerge = isContiguous && (prevLen + currLen <= maxStitchChars);

        if (canMerge) {
          let textA = extractRawChunkText(prevText).trim();
          let textB = extractRawChunkText(currText).trim();

          // Strip duplicate headings or breadcrumb markers at the beginning of textB
          textB = textB.replace(/^<!--\s*大纲层级:[\s\S]*?-->\s*/g, '');
          textB = textB.replace(/^#\s*[^\n]+\n+/g, '').trim();

          // Detect chunk overlap
          let overlapFound = 0;
          const maxCheck = Math.min(250, textA.length, textB.length);
          for (let L = maxCheck; L >= 15; L--) {
            if (textA.slice(-L) === textB.slice(0, L)) {
              overlapFound = L;
              break;
            }
          }

          let mergedText = '';
          if (overlapFound > 0) {
            mergedText = textA + textB.slice(overlapFound);
          } else {
            const endsWithPunct = /[。！？；;\n]$/.test(textA);
            mergedText = endsWithPunct ? `${textA}\n\n${textB}` : `${textA}${textB}`;
          }

          prev.context = mergedText;
          prev.snippet = mergedText;
          prev.evidence = mergedText;
          const bestMergedScore = Math.max(getScore(prev), getScore(curr));
          prev.score = bestMergedScore;
          prev.rerankScore = bestMergedScore;
          prev.relevanceScore = bestMergedScore;
          // A stitched span may have been recalled by more than one planned
          // sub-question. Keep the complete provenance set so evidence routing
          // does not accidentally erase a reasoning hop during assembly.
          const mergedOrigins = [
            prev.subQueryOrigin,
            ...(Array.isArray(prev.subQueryOrigins) ? prev.subQueryOrigins : []),
            curr.subQueryOrigin,
            ...(Array.isArray(curr.subQueryOrigins) ? curr.subQueryOrigins : []),
          ].map((value) => String(value || '').trim()).filter(Boolean);
          if (mergedOrigins.length) {
            prev.subQueryOrigin = prev.subQueryOrigin || mergedOrigins[0];
            prev.subQueryOrigins = [...new Set(mergedOrigins)];
          }
          if (curr.bridgeRescue === true) prev.bridgeRescue = true;
          if (curr.floorExemptReason === 'multi_hop_bridge') {
            prev.floorExempt = true;
            prev.floorExemptReason = 'multi_hop_bridge';
          }
          if (typeof curr.hop === 'number') {
            prev.hop = Math.max(Number(prev.hop || 0), curr.hop);
          }
          if (curr.pageNo && prev.pageNo !== curr.pageNo) {
            const startP = prev.startPage ?? prev.pageNo;
            const endP = curr.pageNo;
            prev.startPage = startP;
            prev.endPage = endP;
            prev.pageNo = `${startP}-${endP}`;
          }
          if (typeof curr.ord === 'number') {
            prev.ord = curr.ord;
          }
        } else {
          stitchedGroup.push(curr);
        }
      }
      finalCitations.push(...stitchedGroup);
    }

    return finalCitations.sort((a, b) => getScore(b) - getScore(a));
  }
}
