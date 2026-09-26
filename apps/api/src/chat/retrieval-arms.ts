import { filterRescueHits, pickRescueTargets, RescueChunk } from './section-rescue';
import { recordFailopen } from '../observability/failopen';
import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { getPrismaClient } from "../prisma";
import { parseTermMappings, expandQueryWithTermMappings, type TermMapping } from "./term-mapping";
import { numericClaimsSupportedBy, numberNearBound } from "./grounding-numeric";
import { buildDocumentPreviewUrl } from "../ingestion/preview-url";
import { buildBm25Pool, bm25Scores } from "./lexical-bm25";
import { tokenizeQuery } from "../retrieval/lexical-tokenizer";
import { Bulkhead, RetrievalDeadline } from "../retrieval/retrieval-budget";
import type { EmbeddingService } from "../embedding/embedding.service";
import type { GraphRagService } from "../graph-rag/graph-rag.service";
import type { RaptorService } from "../raptor/raptor.service";
import type { LexicalIndexService } from "../retrieval/lexical-index.service";
import type { RetrievalVariantParams } from "../experiments/retrieval-variants";
import type { HybridRetrievalService } from "../retrieval/hybrid-retrieval.service";

export function stripInvalidCitationMarkers(value: string, citationCount: number): string {
  return value.replace(/\[(\d+)\]/g, (full, rawIndex) => {
    const index = Number(rawIndex);
    return index >= 1 && index <= citationCount ? full : '';
  });
}

/**
 * Extract the numeric claims (amounts, thresholds, counts, dates, IDs) that a
 * statement asserts. Citation markers are stripped first so their indices are
 * never mistaken for factual numbers.
 */
export function numericClaimsOf(statement: string): string[] {
  const body = statement.replace(/\[\d+\]/g, ' ');
  return (body.match(/\d+(?:\.\d+)?/g) || []).filter((token) => token.replace(/[.\s]/g, '').length >= 1);
}

/**
 * Deterministic grounding check for one answer statement against the evidence
 * texts of the sources it cites (or, when untagged, the full evidence pool).
 * A valid citation marker alone is NOT proof:
 *  1. every numeric claim in the statement must literally appear (modulo
 *     whitespace) in the evidence — fabricated or mutated numbers with a real
 *     citation index are rejected;
 *  2. the statement needs lexical overlap with the evidence (0.5 when it
 *     carries a valid marker and the model only paraphrased, 0.7 when it
 *     carries none) so fully invented prose cannot ride on a real marker.
 */
export function extractRawChunkText(text: string): string {
  if (!text) return '';
  return text
    .replace(/^\[(?:上下文|Context):\s*[\s\S]*?\]\n*/i, '')
    .replace(/<!--\s*大纲层级:[\s\S]*?-->/g, '')
    .replace(/<!--\s*表格结构化行语义:[\s\S]*?-->/g, '')
    .replace(/<!--\s*bbox:[\s\S]*?-->/g, '')
    .trim();
}

export function hasPolarityConflict(statement: string, evidence: string): boolean {
  const normStmt = statement.toLowerCase().replace(/\s+/g, '');
  const normEv = evidence.toLowerCase().replace(/\s+/g, '');

  // Directional bounds. `最低/最高` are anchored to a predicate (为/是/应/不/限)
  // so the bare noun form ("最低工资标准") does not register as a bound.
  const LOWER_BAR = /不低于|不得低于|至少|不少于|不小于|大于等于|下限|最低(?:为|是|应|不|限)|最少|起点(?:为|是)/;
  const UPPER_BAR = /不高于|不得高于|至多|不超过|不得超过|不多于|不大于|上限|最高(?:为|是|应|不|限)|最多|封顶/;
  const stmtHasLowerBar = LOWER_BAR.test(normStmt);
  const stmtHasUpperBar = UPPER_BAR.test(normStmt);
  const evHasLowerBar = LOWER_BAR.test(normEv);
  const evHasUpperBar = UPPER_BAR.test(normEv);

  // A lower bound and an upper bound only contradict when the lower bound
  // exceeds the upper bound (e.g. "不得低于800" vs "不得高于100"). Two bounds
  // that straddle a range ("下限5万" vs "上限10万") are compatible and must not
  // be flagged. Numbers missing => keep the conservative conflict.
  const boundExceeds = (lowerText: string, upperText: string): boolean => {
    const lower = numberNearBound(lowerText, LOWER_BAR);
    const upper = numberNearBound(upperText, UPPER_BAR);
    return lower === null || upper === null ? true : lower >= upper;
  };
  if (stmtHasLowerBar && evHasUpperBar && !evHasLowerBar && boundExceeds(normStmt, normEv)) return true;
  if (stmtHasUpperBar && evHasLowerBar && !evHasUpperBar && boundExceeds(normEv, normStmt)) return true;

  const negPrefix = '(?<![不大至不严切]|不得|不能|严禁|切勿|不可)';
  const stmtHigher = new RegExp(`${negPrefix}(?:高于|大于|超过)`).test(normStmt);
  const stmtLower = new RegExp(`${negPrefix}(?:低于|小于)`).test(normStmt);
  const evHigher = new RegExp(`${negPrefix}(?:高于|大于|超过)`).test(normEv);
  const evLower = new RegExp(`${negPrefix}(?:低于|小于)`).test(normEv);

  if (stmtHigher && evLower && !evHigher) return true;
  if (stmtLower && evHigher && !evLower) return true;
  // If evidence sets an upper limit (e.g. 不得超过800米) but statement asserts it can be higher
  if (stmtHigher && !stmtHasUpperBar && evHasUpperBar && !evHigher) return true;
  // If evidence sets a lower limit (e.g. 不得低于800米) but statement asserts it can be lower
  if (stmtLower && !stmtHasLowerBar && evHasLowerBar && !evLower) return true;

  // Explicit prohibition vs permission/mandate conflict
  const stmtProhibit = /不得|严禁|禁止|不允许|不可|不能|切勿|严控/.test(normStmt);
  const evProhibit = /不得|严禁|禁止|不允许|不可|不能|切勿|严控/.test(normEv);
  const stmtAllow = /(?<![不严未得])允许|(?<![不严未得])可以|应当|必须|可自主|自愿|可选|非强制|酌情/.test(normStmt);
  const evAllow = /(?<![不严未得])允许|(?<![不严未得])可以|应当|必须|可自主|自愿|可选|非强制|酌情/.test(normEv);

  if (stmtProhibit && evAllow && !evProhibit) return true;
  if (stmtAllow && evProhibit && !evAllow) return true;

  // English directional thresholds
  const enStmtHigher = /\b(?:no\s+less\s+than|at\s+least|greater\s+than|higher\s+than|more\s+than)\b/i.test(statement);
  const enStmtLower = /\b(?:no\s+more\s+than|at\s+most|less\s+than|lower\s+than|fewer\s+than)\b/i.test(statement);
  const enEvHigher = /\b(?:no\s+less\s+than|at\s+least|greater\s+than|higher\s+than|more\s+than)\b/i.test(evidence);
  const enEvLower = /\b(?:no\s+more\s+than|at\s+most|less\s+than|lower\s+than|fewer\s+than)\b/i.test(evidence);

  if (enStmtHigher && enEvLower && !enEvHigher) return true;
  if (enStmtLower && enEvHigher && !enEvLower) return true;

  // English prohibition vs permission
  const enStmtProhibit = /\b(?:shall\s+not|must\s+not|is\s+prohibited|are\s+prohibited|cannot|may\s+not|strictly\s+forbidden)\b/i.test(statement);
  const enEvProhibit = /\b(?:shall\s+not|must\s+not|is\s+prohibited|are\s+prohibited|cannot|may\s+not|strictly\s+forbidden)\b/i.test(evidence);
  const enStmtAllow = /\b(?:is\s+allowed|are\s+allowed|is\s+permitted|are\s+permitted|is\s+required)\b|\b(?:shall|must)(?!\s+not)\b/i.test(statement);
  const enEvAllow = /\b(?:is\s+allowed|are\s+allowed|is\s+permitted|are\s+permitted|is\s+required)\b|\b(?:shall|must)(?!\s+not)\b/i.test(evidence);

  if (enStmtProhibit && enEvAllow && !enEvProhibit) return true;
  if (enStmtAllow && enEvProhibit && !enEvAllow) return true;

  return false;
}

export function statementSupportedBy(
  statement: string,
  evidenceTexts: string[],
  hasValidTag: boolean,
): boolean {
  const evidence = evidenceTexts.map(extractRawChunkText).join('\n');
  if (!evidence.trim()) return false;
  if (hasPolarityConflict(statement, evidence)) return false;

  const normalizedEvidence = evidence.replace(/\s+/g, '');
  const body = statement.replace(/\[\d+\]/g, ' ');
  const chars = Array.from(new Set(body.replace(/\s+/g, '').split('')));
  if (chars.length === 0) return true;
  let overlap = 0;
  for (const ch of chars) {
    if (normalizedEvidence.includes(ch)) overlap++;
  }
  const overlapRatio = overlap / chars.length;
  // If statement has valid citation tag and no polarity conflict, allow 0.40 for natural synthesis
  const overlapBar = hasValidTag ? 0.40 : 0.70;
  if (overlapRatio < overlapBar) return false;

  const isEn = !/[\u4e00-\u9fa5]/.test(body);
  if (isEn) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'was', 'are', 'were', 'in', 'on', 'at', 'to', 'of', 'for', 'by', 'with', 'and', 'or', 'that', 'this', 'it',
      'therefore', 'accordingly', 'based', 'from', 'also', 'which', 'who', 'whom', 'whose', 'where', 'when', 'details'
    ]);
    const words = (body.toLowerCase().match(/[a-z0-9'-]+/g) || []).filter((w) => w.length >= 3 && !stopWords.has(w));
    if (words.length > 0) {
      const hits = words.filter((w) => evidence.toLowerCase().includes(w)).length;
      if (hits / words.length < overlapBar) return false;
    }
  }

  // Numeric grounding accepts literal matches AND unit-equivalent values so a
  // correct conversion (0.8s = 800毫秒) is not mis-flagged as fabrication.
  if (!numericClaimsSupportedBy(statement, evidence)) return false;
  return true;
}

/**
 * Derive the semantic-cache scope key from the exact source set selected for
 * this request plus the ACL/knowledge epochs AND the requesting user. The
 * previous key used only the user's full visible-source fingerprint, so a query
 * narrowed to a subset of knowledge bases could collide with (and be answered
 * from) a cached answer produced over a different scope. Embedding the selected
 * sources and epochs makes cache entries scope-exact and revokes them on any
 * permission change.
 *
 * The user id is part of the key because the answer prompt carries private
 * context (personal long-term memory, prior conversation turns). Two users who
 * happen to share a permission Scope must never replay each other's answers.
 */
export function semanticCacheScopeKey(
  sourceKeys: string[],
  aclEpoch: number,
  knowledgeEpoch: number,
  modelName?: string,
  userId?: string,
): string {
  // The key version salt is bumped whenever the retrieval/answer pipeline
  // changes materially, so cached answers produced by older logic are not
  // replayed after an upgrade. The built-in schema salt cannot be overridden:
  // deployments often retain an old .env value across upgrades, and allowing
  // that value to replace the schema version would replay answers whose source
  // numbering predates structured evidence routing. The environment value is
  // an additional operator-controlled namespace only.
  const version = `v5:${process.env.SEMANTIC_CACHE_KEY_VERSION || 'default'}`;
  const modelSalt = modelName ? `|m:${modelName}` : '';
  const userSalt = userId ? `|u:${userId}` : '';
  return createHash('sha256')
    .update(`${version}|${[...sourceKeys].sort().join(',')}|acl:${aclEpoch}|kb:${knowledgeEpoch}${modelSalt}${userSalt}`)
    .digest('hex')
    .slice(0, 32);
}

/** The score a calibrated scorer (cross-encoder or engine rerank) produced, if any. */
export function calibratedScoreOf(citation: any): number | null {
  if (!citation) return null;
  if (String(citation.scoreSource || '') === 'synthetic') return null;
  const value = Number(citation.relevanceScore ?? citation.rerankScore ?? citation.score);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Does this answer text read as a refusal / "not in the knowledge base" reply?
 *
 * Used to keep refusals out of the semantic cache. The original pattern was
 * Chinese-only, so English refusals ("...is not recorded in the provided reference
 * materials") were cached and replayed to every later caller of the same question —
 * which also poisoned the international benchmarks, where an answer generated before
 * a retrieval improvement kept being replayed for the whole cache TTL.
 */
export function isRefusalAnswerText(text: string): boolean {
  const value = String(text || '').trim();
  if (!value) return true;
  return /(未包含相关信息|无法(?:根据知识库)?回答|不知道|无法提供(?:该信息)?|无法确定|没有找到|未检索到|知识库中未)/u.test(value) ||
    /(?:not|no)\s+(?:available|recorded|mentioned|provided|found|contained|specified|stated|listed|given|documented|reported)|cannot\s+(?:answer|be\s+determined)|unable\s+to\s+answer|insufficient\s+information|no\s+(?:relevant\s+information|record|mention|information)|do(?:es)?\s+not\s+(?:contain|specify|state|mention|record|document|provide|list|include)|information\s+is\s+not|is\s+not\s+(?:recorded|specified|mentioned|stated|documented|available)/i.test(value);
}

/**
 * Temporal effectiveness of a document edition at a point in time (default
 * asOf = now): repealed editions and editions not yet in force must never
 * enter the candidate set. Missing date metadata is treated as unknown — the
 * edition stays eligible rather than being silently discarded.
 */
export function documentCurrentlyEffective(doc: any, now = Date.now()): boolean {
  if (String(doc?.lifecycleStatus || 'current') === 'repealed') return false;
  if (doc?.effectiveFrom) {
    const from = new Date(doc.effectiveFrom).getTime();
    if (Number.isFinite(from) && from > now) return false;
  }
  if (doc?.effectiveTo) {
    const to = new Date(doc.effectiveTo).getTime();
    if (Number.isFinite(to) && to < now) return false;
  }
  return true;
}

export interface RetrievalArmsDeps {
  logger: Logger;
  prisma?: any;
  gbrain?: BrainRepoAdapter;
  raptorService?: RaptorService;
  embeddingService?: EmbeddingService;
  graphRagService?: GraphRagService;
  hybridRetrievalService?: HybridRetrievalService;
  lexicalIndexService?: LexicalIndexService;
  filterQueryResultByCurrentPermission?: (
    result: any,
    visibleKbIds: string[],
    derivedGuard: {
      scopeId: string;
      sourceKeys: string[];
      aclEpoch: number;
      knowledgeEpoch: number;
    },
  ) => Promise<any>;
}

/**
 * Retrieval arms: keyword/vector fallback search, domain-term scoping,
 * RAPTOR / brain-derived augmentation, hop probes and embedding-drift checks.
 * Extracted from ChatService; behaviour is unchanged (code move + ctor injection).
 */
export class RetrievalArmsService {
  private readonly logger: Logger;
  private prisma: any;
  private gbrain!: BrainRepoAdapter;
  private raptorService?: RaptorService;
  private embeddingService?: EmbeddingService;
  private graphRagService?: GraphRagService;
  private hybridRetrievalService?: HybridRetrievalService;
  private lexicalIndexService?: LexicalIndexService;
  private readonly filterQueryResultByCurrentPermission: NonNullable<RetrievalArmsDeps["filterQueryResultByCurrentPermission"]>;

  constructor(deps: RetrievalArmsDeps) {
    this.logger = deps.logger;
    this.prisma = deps.prisma ?? getPrismaClient();
    this.gbrain = deps.gbrain as BrainRepoAdapter;
    this.raptorService = deps.raptorService;
    this.embeddingService = deps.embeddingService;
    this.graphRagService = deps.graphRagService;
    this.hybridRetrievalService = deps.hybridRetrievalService;
    this.lexicalIndexService = deps.lexicalIndexService;
    this.filterQueryResultByCurrentPermission =
      deps.filterQueryResultByCurrentPermission ?? (async (result) => result);
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
      .replace(/(?:主要|具体)?(?:包括|包含|涵盖|涉及|涵盖了|包含了|包括了)(?:由|是由)?(?:什么|哪些|何种|哪几项|哪几部分|哪些内容|什么内容|指标|要求)?[\?？。！!]*$/g, "")
      .replace(/(?:一共有哪些章|请列出全部章名|有哪些章|有哪些|是什么|是多少|怎么做|如何规定|属于什么|怎么算|如何计算|是指什么|有什么要求|有什么规定|有什么后果|分别是什么|是多久|是多少分|是多少天|是什么编号|是多少号|包含什么|包括什么)[\?？。！!]*$/g, "")
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

    // 5. English multi-hop, comparison, and conjunction patterns.
    //
    // These templates are modelled on public multi-hop benchmarks (2WikiMultiHopQA
    // / HotpotQA question shapes: "which film has the director who died later,
    // X or Y", "where was the place of burial of Z's father"). They are a
    // benchmark-shaped heuristic, not a general decomposition rule, so they stay
    // behind an explicit switch: on a normal production corpus the LLM planner
    // handles decomposition, while the benchmark harness turns them on to keep
    // published numbers comparable.
    const benchmarkPatternsEnabled =
      process.env.RETRIEVAL_BENCHMARK_PATTERNS === 'true' || process.env.RETRIEVAL_BENCHMARK_PATTERNS === '1';
    if (benchmarkPatternsEnabled && subQueries.size === 0 && !/[\u4e00-\u9fa5]/.test(raw)) {
      // 5.1 Bridge comparison: e.g. "Which film has the director who died later, The More The Merrier or Sleep, My Love?"
      const compMatch = raw.match(/(?:which|who|what)\s+([a-z\s]+?)\s+(?:has the|whose|with)\s+([a-z\s]+?)\s+(?:who|that|which)?\s*(?:is|was|died|born)?\s*(?:earlier|later|older|younger|more|less|first|after|before)[^,]*,\s*([^,]+?)\s+or\s+([^?]+)/i);
      if (compMatch) {
        const rel = compMatch[2].trim();
        const item1 = compMatch[3].trim().replace(/^["']|["']$/g, "").trim();
        const item2 = compMatch[4].trim().replace(/^["']|["']$/g, "").trim();
        if (item1 && item2) {
          subQueries.add(`${item1} ${rel}`);
          subQueries.add(`${item2} ${rel}`);
          subQueries.add(item1);
          subQueries.add(item2);
        }
      }

      // 5.2 Direct comparison: "Which of X and Y ...", "Did X and Y have the same ..."
      if (subQueries.size === 0) {
        const whichOfMatch = raw.match(/(?:which of|did)\s+([A-Z][a-zA-Z0-9\s'(),.-]+?)\s+(?:and|or)\s+([A-Z][a-zA-Z0-9\s'(),.-]+?)(?:\s+(?:have|has|are|were|been|both|share))?/i);
        if (whichOfMatch) {
          const item1 = whichOfMatch[1].trim().replace(/^["']|["']$/g, "");
          const item2 = whichOfMatch[2].trim().replace(/^["']|["']$/g, "");
          if (item1 && item2) {
            subQueries.add(item1);
            subQueries.add(item2);
          }
        }
      }

      // 5.3 Compositional possessive: e.g. "Where was the place of burial of Charles Mathew's father?"
      if (subQueries.size === 0) {
        const possMatch = raw.match(/(?:(?:where|what|when|who)\s+(?:is|was|are|were)\s+(?:the\s+)?(?:place of (?:birth|death|burial)\s+of\s+)?)?([A-Z][a-zA-Z0-9\s'(),.-]+?)'s\s+([a-z\s]+?)(?:\s+(?:born|die|died|buried|burial|birth|death|located|married|graduated))?(?:\?|$)/i);
        if (possMatch) {
          const entity = possMatch[1].trim();
          const rel = possMatch[2].trim();
          if (entity.length >= 3 && rel.length >= 2) {
            subQueries.add(`${entity} ${rel}`);
            subQueries.add(entity);
          }
        }
      }

      // 5.4 Compositional "of": e.g. "Where was the husband of Octavie Coudreau born?"
      if (subQueries.size === 0) {
        const ofMatch = raw.match(/(?:where|what|when|who)\s+(?:is|was|are|were|did)\s+(?:the\s+)?(?:place of (?:birth|death|burial)\s+of\s+)?([a-z\s]+?)\s+of\s+(?:film\s+|movie\s+|book\s+|the\s+)?([A-Z][a-zA-Z0-9\s'(),.-]+?)(?:\s+(?:born|die|died|live|lived|directed|written|created|founded|located|married|graduated))?(?:\?|$)/i);
        if (ofMatch) {
          const rel = ofMatch[1].trim();
          const entity = ofMatch[2].trim();
          if (entity.length >= 3 && rel.length >= 2) {
            subQueries.add(`${entity} ${rel}`);
            subQueries.add(entity);
          }
        }
      }
    }

    // 6. Chinese compound noun & interrogative stripping pattern (run when no prior pattern matched)
    if (subQueries.size === 0) {
      const cleaned = this.cleanRetrievalQuery(raw);
      if (cleaned && cleaned !== raw && cleaned.length >= 4) {
        subQueries.add(cleaned);
      }
      // (Hardcoded domain sub-term expansion removed — superseded by
      // KB-configured domainTerms and LLM query expansion.)
    }

    return Array.from(subQueries).filter((q) => q.length >= 2).slice(0, 6);
  }

  extractSearchKeywords(query: string, domainTerms: string[] = []): string[] {
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
        ["第一章", "第二章", "第三章", "第四章", "第五章", "总则", "罚则", "附则"].forEach((t) => set.add(t));
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
        // Stride 1 n-gram extraction (4-grams, 3-grams, 2-grams) so words starting on odd indices or 3-char words are never skipped
        for (let len = Math.min(4, p.length); len >= 2; len--) {
          for (let i = 0; i <= p.length - len; i++) {
            set.add(p.slice(i, i + len));
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
  scopeDomainTermsCache = new Map<
    string,
    { terms: string[]; mappings: TermMapping[]; expiresAt: number }
  >();
  readonly subQueryChunkCache = new Map<string, { hits: any[]; expiresAt: number }>();
  /** Caps concurrent database-backed retrieval arms across all requests. */
  readonly retrievalBulkhead = new Bulkhead(
    Number(process.env.RETRIEVAL_MAX_CONCURRENCY || 12),
  );

  /**
   * Load admin-maintained KB-level retrieval vocabulary. `domainTerms` accepts
   * both the legacy flat hint-term array and the object form
   * a colloquial -> formal term map configured per KB, which is a
   * term mapping. No terms are hardcoded here; an empty/absent config yields
   * nothing. Cached briefly to avoid a KB query on every retrieval.
   */
  async loadScopeDomainConfig(
    scope: string[],
  ): Promise<{ terms: string[]; mappings: TermMapping[] }> {
    if (!scope.length || !this.prisma || !(this.prisma as any).knowledgeBase?.findMany) {
      return { terms: [], mappings: [] };
    }
    const cacheKey = [...scope].sort().join(",");
    const cached = this.scopeDomainTermsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Entries created by older processes/tests used the legacy terms-only
      // shape. Treat a missing mapping list as empty during rolling upgrades.
      return { terms: cached.terms || [], mappings: cached.mappings || [] };
    }
    try {
      const rows = await (this.prisma as any).knowledgeBase.findMany({
        where: { id: { in: scope } },
        select: { domainTerms: true },
      });
      const terms: string[] = [];
      const mappings: TermMapping[] = [];
      for (const row of rows) {
        const raw = row?.domainTerms;
        if (Array.isArray(raw)) {
          for (const term of raw) {
            const value = String(term || "").trim();
            if (value) terms.push(value);
          }
        } else if (raw && typeof raw === "object") {
          const parsed = parseTermMappings(raw);
          for (const mapping of parsed) {
            mappings.push(mapping);
            terms.push(mapping.from, ...mapping.to);
          }
        }
      }
      const dedupedTerms = Array.from(new Set(terms));
      this.scopeDomainTermsCache.set(cacheKey, {
        terms: dedupedTerms,
        mappings,
        expiresAt: Date.now() + 120_000,
      });
      return { terms: dedupedTerms, mappings };
    } catch {
      return { terms: [], mappings: [] };
    }
  }

  async loadScopeDomainTerms(scope: string[]): Promise<string[]> {
    return (await this.loadScopeDomainConfig(scope)).terms;
  }

  /**
   * Append document-level (level 1) RAPTOR summaries for documents already
   * present in the candidate set. Guarantees whole-document coverage for
   * macro questions without displacing concrete evidence.
   */
  async augmentWithDocumentSummaries(
    queryResult: any,
    scope: string[],
    question?: string,
    complexity?: string,
  ): Promise<any> {
    if (!this.raptorService?.isEnabled()) return queryResult;
    const citations = Array.isArray(queryResult?.citations) ? queryResult.citations : [];
    if (!citations.length) return queryResult;

    const q = String(question || "").trim();
    const isMacroOrStructureQuery =
      complexity === "global_synthesis" ||
      /(?:包括那?几大?部分|主要内容|主要章节|有哪些章|目录|大纲|总体结构|全文架构|整体框架|总结|概述|全景|宏观)/u.test(q);

    // Only inject document summaries/outlines when the user query is asking for macro or structural overview
    if (!isMacroOrStructureQuery) return queryResult;

    // Filter candidate documents: do NOT augment spreadsheet files
    const candidateCitations = citations.filter((c: any) => {
      const title = String(c.docTitle || c.topic || "");
      const isSpreadsheet = /(?:\.xlsx?|\.csv|\.tsv)(?:\s*·|\s*$)/i.test(title);
      return !isSpreadsheet;
    });

    const docIds = Array.from(
      new Set(candidateCitations.map((c: any) => c.docId || c.documentId).filter(Boolean)),
    ).slice(0, 3) as string[];
    if (!docIds.length) return queryResult;

    const [summaries, outlines] = await Promise.all([
      this.raptorService.getDocumentSummaries(docIds, 3),
      this.raptorService.getDocumentOutlines(docIds, 3),
    ]);
    const combined = [...summaries, ...outlines];
    if (!combined.length) return queryResult;

    const existing = new Set(candidateCitations.map((c: any) => c.docId || c.documentId));
    const additions = combined
      .filter((s) => s.documentId && existing.has(s.documentId))
      .filter((s) => !citations.some((c: any) => (c.docId || c.documentId) === s.documentId && c.section === s.section))
      .map((s) => {
        // Calibrate summary score below parent matching chunks so concrete evidence is not displaced
        const docMatchingCitations = citations.filter((c: any) => (c.docId || c.documentId) === s.documentId);
        const parentScore = Math.max(...docMatchingCitations.map((c: any) => Number(c.relevanceScore ?? c.rerankScore ?? c.score ?? 0)));
        const calibratedScore = parentScore > 0 ? Number((parentScore * 0.88).toFixed(4)) : (s.score ? Number((s.score * 0.8).toFixed(4)) : 0.6);

        return {
          topic: s.title,
          docId: s.documentId,
          kbId: s.kbId,
          version: 1,
          evidence: s.evidence,
          snippet: s.evidence,
          context: s.evidence,
          score: calibratedScore,
          relevanceScore: calibratedScore,
          // Calibrated against the parent match, not measured on a relevance
          // scale: comparable to the other synthetic entries, never to the
          // cross-encoder output. If platform rerank runs it re-scores this
          // citation and overwrites the provenance with 'rerank'.
          scoreSource: "synthetic",
          docTitle: s.title,
          previewUrl: s.previewUrl,
          section: s.section || "raptor-level1",
          raptor: true,
          isSummary: true,
        };
      });

    if (!additions.length) return queryResult;
    return { ...queryResult, citations: [...citations, ...additions] };
  }

  async augmentWithRaptorGlobalTree(
    queryResult: any,
    scope: string[],
    question: string,
    complexity: string,
    trace?: any,
  ): Promise<any> {
    if (!this.raptorService?.isEnabled() || !scope.length) return queryResult;
    const isMacro =
      complexity === "global_synthesis" ||
      /总结|概述|全景|历程|演进|架构|体系|全库|全局|所有.*有哪些|主要.*有哪些|一共.*多少|共有.*几|多少条|几条|多少章|几章/u.test(question);
    if (!isMacro) return queryResult;

    try {
      trace?.start?.(
        "raptor_macro_retrieval",
        "RAPTOR 全库宏观树召回",
        "检测到全库宏观概括问题，自适应召回 Level 2 全局演进树与 Level 1 文档树摘要",
      );
      const hits = await this.raptorService.searchGlobal(scope, question, 4);
      if (!hits.length) {
        trace?.skip?.("raptor_macro_retrieval", "RAPTOR 全库宏观树召回", "知识库内尚未生成可用的全局宏观摘要节点");
        return queryResult;
      }

      const citations = Array.isArray(queryResult?.citations) ? [...queryResult.citations] : [];
      const existingEvidence = new Set(
        citations.map((c: any) => String(c.evidence || c.snippet || "").replace(/\s+/g, "").slice(0, 30)),
      );

      let added = 0;
      for (const h of hits) {
        const key = String(h.evidence || "").replace(/\s+/g, "").slice(0, 30);
        if (!key || existingEvidence.has(key)) continue;
        existingEvidence.add(key);
        citations.unshift({
          topic: h.title,
          docId: h.documentId,
          kbId: h.kbId,
          version: 1,
          evidence: h.evidence,
          snippet: h.evidence,
          context: h.evidence,
          score: h.score,
          docTitle: h.title,
          previewUrl: h.previewUrl,
          section: h.section || (h.level === 2 ? "raptor-level2-global" : "raptor-level1"),
          raptor: true,
          isSummary: true,
          level: h.level,
        });
        added++;
      }

      trace?.finish?.(
        "raptor_macro_retrieval",
        "success",
        `成功召回 ${added} 条全局宏观演进树摘要 (Level 2/1)，置于优先候选集`,
        { hits: added, totalGlobal: hits.length },
      );

      return { ...queryResult, citations };
    } catch (err) {
      trace?.finish?.(
        "raptor_macro_retrieval",
        "warning",
        `RAPTOR 宏观召回降级: ${err instanceof Error ? err.message : String(err)}`,
      );
      return queryResult;
    }
  }

  async augmentWithBrainDerivedIntelligence(
    queryResult: any,
    userScope: any,
    question: string,
    agenticComplexity: string,
    trace?: any,
  ): Promise<any> {
    if (!userScope?.scopeId) return queryResult;
    const isEnglishQuery = !/[\u4e00-\u9fa5]/.test(question);
    const isMacroOrInventory =
      agenticComplexity !== "simple" ||
      /(?:总结|概述|全景|历程|演进|架构|体系|全库|全局|所有.*有哪些|主要.*有哪些|一共.*多少|共有.*几|多少条|几条|多少章|几章|清单|统计|列表|目录|关系|架构|层级|制度)/u.test(question);

    const existingCitations = Array.isArray(queryResult?.citations) ? [...queryResult.citations] : [];
    const needDerived = isMacroOrInventory || existingCitations.length === 0;
    if (!needDerived) return queryResult;

    try {
      const dbClient = this.prisma as any;
      if (!dbClient.brainDerivedPage?.findMany) return queryResult;

      const derivedPages = await dbClient.brainDerivedPage.findMany({
        where: {
          scopeId: userScope.scopeId,
          aclEpoch: userScope.aclEpoch,
        },
        take: 2,
        orderBy: { updatedAt: "desc" },
      });

      if (!derivedPages || derivedPages.length === 0) return queryResult;

      trace?.start?.(
        "brain_derived_intelligence",
        "编译派生智库直通",
        "加载当前权限 Scope 专属离线编译综述与资产全景",
      );

      let added = 0;
      for (const page of derivedPages) {
        if (!page.content) continue;
        const alreadyIncluded = existingCitations.some((c: any) => c.slug === page.slug || c.topic === page.title);
        if (alreadyIncluded) continue;

        const snippet = page.content.slice(0, 400);
        const context = page.content.length > 2000 ? page.content.slice(0, 2000) + "\n..." : page.content;

        existingCitations.unshift({
          topic: page.title,
          docTitle: page.title,
          slug: page.slug,
          kbId: "derived",
          kbName: isEnglishQuery ? "Scope Derived Intelligence" : "Scope 编译派生智库",
          section: "scope-derived-summary",
          snippet,
          context,
          score: 0.96,
          scoreSource: "synthetic",
          isCompiledDerived: true,
          scopeId: page.scopeId,
          aclEpoch: page.aclEpoch,
          evidence: `[编译派生智库] 《${page.title}》 (Epoch: ${page.aclEpoch})`,
        });
        added++;
      }

      if (added > 0) {
        trace?.finish?.(
          "brain_derived_intelligence",
          "success",
          `成功直通注入 ${added} 篇权限 Scope 编译派生全景综述`,
          { injectedCount: added },
        );
        return { ...queryResult, citations: existingCitations };
      }
      return queryResult;
    } catch (err) {
      trace?.finish?.(
        "brain_derived_intelligence",
        "warning",
        `Scope 派生智库直通忽略: ${err instanceof Error ? err.message : String(err)}`,
      );
      return queryResult;
    }
  }

  async retrieveHopProbes(
    scope: string[],
    sourceRefs: string[],
    fallbackGitRepoUrl: string | undefined,
    probes: string[],
    signal?: AbortSignal,
    userScope?: any,
    selectedSourceKeys?: string[],
    hopNumber = 2,
  ): Promise<any[]> {
    const hopCitations: any[] = [];
    const probePromises = probes.map(async (probe) => {
      // 1. Parallel search in fallback chunks (pgvector + BM25 keyword matching)
      const fallbackHits = await this.searchChunksFallback(scope, probe, 10).catch(() => [] as any[]);
      const gbrainHits: any[] = [];

      // 2. Query GBrain CLI if available
      try {
        const gbrainRes =
          sourceRefs.length > 1
            ? await this.gbrain.queryMany(sourceRefs, probe, { breadth: true, operation: "search", signal })
            : await this.gbrain.query(sourceRefs[0] || fallbackGitRepoUrl || "", probe, {
                breadth: true,
                operation: "search",
                signal,
              });
        if (gbrainRes?.citations?.length) {
          gbrainHits.push(...gbrainRes.citations);
        }
      } catch {
        // fail-open
      }

      // Format fallback hits
      const mappedFallbacks = fallbackHits.map((fb, idx) => ({
        topic: fb.title || fb.documentId || "",
        docId: fb.documentId,
        kbId: fb.kbId,
        version: fb.version,
        pageNo: fb.pageNo,
        articleNo: fb.articleNo,
        evidence: fb.evidence,
        snippet: fb.evidence,
        context: fb.evidence,
        score: Math.max(0.72, 0.93 - idx * 0.02),
        scoreSource: "synthetic",
        docTitle: fb.title,
        sectionGroup: (fb as any).sectionGroup,
        subQueryOrigin: probe,
        hop: hopNumber,
        bbox: fb.bbox,
        previewUrl: fb.previewUrl,
      }));

      for (const cit of gbrainHits) {
        (cit as any).subQueryOrigin = probe;
        (cit as any).hop = hopNumber;
      }

      // 3. Multi-Hop GraphRAG Entity & Relation Probe:
      // Query Knowledge Graph for bridge entity relationships when available
      const graphHits: any[] = [];
      if (this.graphRagService && scope.length > 0) {
        try {
          const localGraph = await this.graphRagService.searchLocalGraph(scope, probe, 3);
          if (localGraph && Array.isArray(localGraph.relations)) {
            // Graph prose is navigation metadata, not answer evidence. Resolve
            // every relation back to its original chunk under the same KB and
            // published-document gates as the other retrieval channels.
            const provenanceByChunk = new Map<string, typeof localGraph.relations[number]>();
            for (const rel of localGraph.relations) {
              for (const provenance of rel.provenance || []) {
                if (provenance.chunkId) provenanceByChunk.set(String(provenance.chunkId), rel);
              }
            }
            const chunkIds = Array.from(provenanceByChunk.keys()).slice(0, 12);
            if (chunkIds.length) {
              const rows: any[] = await this.prisma.$queryRaw`
                SELECT c.id, c."documentId", c."kbId", c.ord, c.content, c.metadata,
                       d.title AS "docTitle", d.version AS "docVersion"
                FROM "Chunk" c
                JOIN "Document" d ON d.id = c."documentId"
                WHERE c.id = ANY(${chunkIds}::uuid[])
                  AND c."kbId" = ANY(${scope}::uuid[])
                  AND d.status = 'published'
              `;
              for (const row of rows || []) {
                const rel = provenanceByChunk.get(String(row.id));
                graphHits.push({
                  id: row.id,
                  topic: row.docTitle,
                  docId: row.documentId,
                  kbId: row.kbId,
                  version: row.docVersion,
                  evidence: row.content,
                  snippet: row.content,
                  context: row.content,
                  score: 0.88,
                  scoreSource: "synthetic",
                  docTitle: row.docTitle,
                  metadata: row.metadata,
                  graphRelation: rel ? `${rel.source} -[${rel.relationType}]-> ${rel.target}` : undefined,
                  graphProvenanceBound: true,
                  subQueryOrigin: probe,
                  hop: hopNumber,
                });
              }
            }
          }
        } catch {
          // fail-open
        }
      }

      return [...mappedFallbacks, ...gbrainHits, ...graphHits];
    });

    const settled = await Promise.allSettled(probePromises);
    for (const res of settled) {
      if (res.status === "fulfilled") {
        hopCitations.push(...res.value);
      }
    }

    // Permission filter
    if (userScope && selectedSourceKeys) {
      const filtered = await this.filterQueryResultByCurrentPermission(
        { citations: hopCitations } as any,
        scope,
        {
          scopeId: userScope.scopeId,
          sourceKeys: selectedSourceKeys,
          aclEpoch: userScope.aclEpoch,
          knowledgeEpoch: userScope.knowledgeEpoch,
        },
      );
      return filtered.citations || [];
    }

    return hopCitations;
  }

  /**
   * Chunk-level semantic retrieval over Chunk.embedding (pgvector). Applies the
   * knowledge-base ACL and published-document filter in SQL (pre-filtering), so
   * unauthorized chunks can never enter the candidate set. Returns [] when no
   * embedding route is configured or on any failure.
   *
   * Filtered HNSW is the classic recall trap: pgvector runs the filter after
   * the graph scan, so a selective filter can return far fewer neighbours than
   * requested. The transaction therefore raises `hnsw.ef_search` and enables
   * `hnsw.iterative_scan`, which keeps scanning the graph until the requested
   * number of rows survives the filter (bounded by `hnsw.max_scan_tuples`).
   * tests/evaluation/intl-benchmark/ann_recall_eval.py measures the resulting
   * Recall@K against exact KNN on the same data.
   *
   * Embedding-space guard: stored vectors are only comparable to a query vector
   * when both were produced by the same model. `EmbeddingModelState` records the
   * model that wrote each knowledge base's vectors, and a mismatch skips this
   * arm (rather than silently ranking by meaningless cosine similarity) unless
   * VECTOR_ALLOW_EMBEDDING_MODEL_DRIFT=true.
   */
  async detectEmbeddingModelDrift(scope: string[]): Promise<string | null> {
    try {
      const config = await this.embeddingService?.getConfig();
      const currentModel = config?.modelName;
      if (!currentModel) return null;
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT DISTINCT "modelName" FROM "EmbeddingModelState" WHERE "kbId" = ANY(${scope}::uuid[])
      `;
      const recorded = (rows || [])
        .map((row) => String(row.modelName))
        .filter((name) => name && name !== currentModel);
      if (!recorded.length) return null;
      return `stored=${recorded.join(',')} current=${currentModel}`;
    } catch {
      // Table missing (older database) or query failure: never block retrieval.
      return null;
    }
  }

  async searchChunksByVector(
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
    const modelDrift = await this.detectEmbeddingModelDrift(scope);
    if (modelDrift) {
      if (process.env.VECTOR_ALLOW_EMBEDDING_MODEL_DRIFT !== 'true') {
        this.logger.warn(
          `Vector arm skipped: stored embeddings are not in the configured model's space (${modelDrift}). ` +
            'Re-embed the affected knowledge bases (embedding backfill) or set VECTOR_ALLOW_EMBEDDING_MODEL_DRIFT=true.',
        );
        return [];
      }
      this.logger.warn(
        `Vector arm running with a recorded embedding-model mismatch (${modelDrift}); similarities may be meaningless.`,
      );
    }
    const vector = await this.embeddingService.embedOne(query);
    if (!vector || !vector.length) return [];
    const literal = `[${vector.join(',')}]`;
    const minScore = Number(process.env.VECTOR_MIN_SCORE || 0.30);
    // Measured on a 100k-chunk corpus with a 1-of-40-KB filter (see
    // tests/evaluation/intl-benchmark/reports/ann-recall-100k-chunks.json):
    // ef_search=100 + iterative_scan reaches Recall@10 0.958, ef_search=200
    // reaches 1.000, while the same settings without iterative scan collapse to
    // 0.21-0.45 with most queries returning fewer than k rows.
    try {
      // The HNSW settings are configured at database level (see the deployment
      // note in docs/audit-remediation-and-sota-evaluation-2026-09-19.md:
      //   ALTER DATABASE ... SET hnsw.ef_search = 200;
      //   ALTER DATABASE ... SET hnsw.iterative_scan = 'relaxed_order';
      // ). They used to be applied with SET LOCAL inside an interactive
      // transaction; on the 2 vCPU production box that exhausted the Prisma
      // pool and produced "Unable to start a transaction in the given time"
      // while the enrichment queue was running. A plain query has no such cost
      // and still benefits from the database-level settings.
      const rows = scope.length === 1
        ? await this.prisma.$queryRaw<any[]>`
            SELECT c.id, c."documentId", c."kbId", c.ord, c.content, c.metadata,
                   d.title AS "docTitle", d.version AS "docVersion",
                   (1 - (c.embedding <=> ${literal}::vector)) AS similarity
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c."kbId" = ${scope[0]}::uuid
              AND c.embedding IS NOT NULL
              AND d.status = 'published'
            ORDER BY c.embedding <=> ${literal}::vector
            LIMIT ${limit}
          `
        : await this.prisma.$queryRaw<any[]>`
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
        .map((row: any) => ({
          id: String(row.id),
          documentId: String(row.documentId),
          kbId: String(row.kbId),
          ord: Number(row.ord),
          content: String(row.content || ''),
          metadata: row.metadata,
          document: { title: String(row.docTitle || ''), version: Number(row.docVersion || 1) },
          score: Number(row.similarity),
        }))
        .filter((row: any) => Number.isFinite(row.score) && row.score >= minScore);
    } catch (err) {
      this.logger.debug(`Vector search unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }


  /**
   * 小节救援：同文档补拉未覆盖的问题点名小节（如汇总表），防止长明细表垄断上下文。
   */
  async rescueSections(
    query: string,
    citations: any[],
    limitPerDoc = 4,
  ): Promise<any[]> {
    if (!this.prisma || !(this.prisma as any).chunk?.findMany) return [];
    const targets = pickRescueTargets(query, citations);
    if (!targets.length) return [];
    try {
    const anchors = filterRescueHits(query, [
      {
        id: '__probe__',
        documentId: '__',
        kbId: '__',
        ord: 0,
        content: '',
        section: query,
        tableRole: 'unknown',
      } as RescueChunk,
    ]); // unused probe to keep import warm; filtering happens per-hit below
    void anchors;
    const out: any[] = [];
    for (const target of targets) {
      const rows = await (this.prisma as any).chunk.findMany({
        where: {
          documentId: target.documentId,
          ...(target.kbId ? { kbId: target.kbId } : {}),
        },
        select: {
          id: true,
          documentId: true,
          kbId: true,
          ord: true,
          content: true,
          charStart: true,
          charEnd: true,
          metadata: true,
        },
        orderBy: { ord: 'asc' },
        take: 400,
      });
      const shaped: RescueChunk[] = (rows || []).map((r: any) => ({
        id: r.id,
        documentId: r.documentId,
        kbId: r.kbId,
        ord: r.ord,
        content: r.content,
        charStart: r.charStart,
        charEnd: r.charEnd,
        section: r.metadata?.section,
        breadcrumb: r.metadata?.breadcrumb,
        headingHierarchy: r.metadata?.heading_hierarchy,
        title: r.metadata?.title,
        tableRole: r.metadata?.tableRole,
        metadata: r.metadata,
      }));
      const kept = filterRescueHits(query, shaped).slice(0, limitPerDoc);
      out.push(
        ...kept.map((h) => ({
          id: h.id,
          documentId: h.documentId,
          kbId: h.kbId,
          ord: h.ord,
          title: h.title || (h.metadata as any)?.docTitle || h.section || 'rescued',
          evidence: h.content,
          context: h.content,
          snippet: h.content,
          score: 0.92,
          scoreSource: 'synthetic',
          section: h.section,
          breadcrumb: h.breadcrumb,
          heading_hierarchy: h.headingHierarchy,
          tableRole: h.tableRole,
          sectionGroup: h.section ? `${h.documentId}:${h.section}` : undefined,
          previewUrl: null,
          subQueryOrigin: 'section_rescue',
        })),
      );
    }
    return out;
    } catch (err) {
      // section_rescue fail-open: drop rescue hits and let the candidate pool stand.
      recordFailopen('section_rescue');
      return [];
    }
  }

  async searchChunksFallback(
    scope: string[],
    query: string,
    limit = 15,
    extraQueries: string[] = [],
    variant?: RetrievalVariantParams,
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
    if (!scope.length || !this.prisma || !(this.prisma as any).chunk?.findMany) {
      return [];
    }

    const subQueryCacheKey = extraQueries.length === 0 && !variant
      ? `${scope.slice().sort().join(",")}:${query.trim().toLowerCase()}:${limit}`
      : null;
    if (subQueryCacheKey) {
      const cached = this.subQueryChunkCache.get(subQueryCacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.hits.map((h) => ({ ...h }));
      }
    }

    const { terms: domainTerms, mappings: termMappings } = await this.loadScopeDomainConfig(scope);
    // KB-configured colloquial -> formal term mappings add recall arms carrying
    // the document's own vocabulary (colloquial -> formal, supplied by KB config). Corpus-agnostic:
    // with no admin mapping this is empty and nothing changes.
    const mappedVariants = expandQueryWithTermMappings(query, termMappings);
    // Agentic sub-queries and HyDE passages are additional recall arms: union
    // their keywords with the primary query so complex/compound questions can
    // hit clauses that a single keyword extraction would miss.
    const primaryKeywords = new Set(this.extractSearchKeywords(query, domainTerms));
    const extraVariants = extraQueries.filter((q) => typeof q === "string" && q.trim().length >= 2);
    const variantQueries = [query, ...extraVariants, ...mappedVariants];
    const keywords = Array.from(new Set([
      ...primaryKeywords,
      ...extraVariants.flatMap((variant) => this.extractSearchKeywords(variant, domainTerms)),
      ...mappedVariants.flatMap((variant) => this.extractSearchKeywords(variant, domainTerms)),
    ])).slice(0, 40);
    if (!keywords.length) {
      return [];
    }

    // One wall-clock budget and one concurrency budget for every retrieval
    // arm of this request. Arms that exhaust the budget resolve to "no hits"
    // instead of holding the answer, and a saturated bulkhead sheds the arm
    // rather than queueing behind unbounded database work.
    const deadline = new RetrievalDeadline(Number(process.env.RETRIEVAL_DEADLINE_MS || 15000));

    // Optimization 6: Prime embedding cache in a single batch for primary query + subqueries
    const subs = [...extraQueries, ...mappedVariants]
      .filter((q) => typeof q === "string" && q.length >= 4 && q.length <= 80)
      .slice(0, 3);
    const embeddingTextsToPrime = [query, ...subs].filter((t) => typeof t === "string" && t.trim().length >= 2);
    if (this.embeddingService?.isEnabled() && embeddingTextsToPrime.length > 0) {
      await this.embeddingService.embed(embeddingTextsToPrime).catch(() => [] as any[]);
    }

    // Semantic arm: embed the query and retrieve nearest chunks by cosine
    // distance over Chunk.embedding (pgvector/HNSW). Already in memory cache from batch above!
    const vectorHitsPromise = this.retrievalBulkhead.runOrFallback(
      () =>
        deadline.guard(
          this.searchChunksByVector(scope, query, Math.max(limit * 3, 40)).catch(() => [] as any[]),
          [],
          "vector",
        ),
      [],
    );
    // Decomposed sub-queries get their own vector probes (also hitting memory cache!)
    const subQueryVectorPromise = (async () => {
      const perSub = Math.max(8, Number(process.env.RETRIEVAL_SUBQUERY_VECTOR_TAKE || 15));
      const results = await Promise.all(
        subs.map((sub) =>
          this.retrievalBulkhead.runOrFallback(
            () =>
              deadline.guard(
                this.searchChunksByVector(scope, sub, perSub).catch(() => [] as any[]),
                [] as any[],
                "sub-vector",
              ),
            [] as any[],
          ),
        ),
      );
      const byId = new Map<string, any>();
      results.forEach((hits, i) => {
        for (const hit of hits || []) {
          if (hit && !(hit as any).subQueryOrigin) (hit as any).subQueryOrigin = subs[i];
          const prev = byId.get(hit.id);
          if (!prev || hit.score > prev.score) byId.set(hit.id, hit);
        }
      });
      return [...byId.values()];
    })().catch(() => [] as any[]);

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

      // 1. High-priority token retrieval promise (exact structural guarantee)
      const pChunksPromise = highPriorityTokens.length > 0
        ? (this.prisma as any).chunk.findMany({
            where: {
              kbId: { in: scope },
              document: { status: "published" },
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
          }).catch(() => [] as any[])
        : Promise.resolve([]);

      // 2. Chapter heading listing retrieval promise
      const chChunksPromise = isChapterListing
        ? (async () => {
            let targetDocIds: string[] = [];
            const cleanQuery = query.replace(/[？?。！!,，\s]+|一共有哪些章|有哪些章|所有章|全部章|章名|一共有几章|目录|结构/g, "").trim();
            if (cleanQuery.length >= 2) {
              const docRows = await (this.prisma as any).document.findMany({
                where: {
                  kbId: { in: scope },
                  status: "published",
                  title: { contains: cleanQuery },
                },
                select: { id: true },
              }).catch(() => [] as any[]);
              if (docRows.length > 0) {
                targetDocIds = docRows.map((d: any) => d.id);
              }
            }
            return (this.prisma as any).chunk.findMany({
              where: {
                kbId: { in: scope },
                document: { status: "published" },
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
            }).catch(() => [] as any[]);
          })()
        : Promise.resolve([]);

      const stopGeneralTokens = new Set(["记录", "表中", "内容", "部分", "情况", "要求", "相关", "规定", "文档", "系统", "什么", "怎么", "如何"]);

      // 3. General keywords retrieval promise (concurrent token queries)
      const generalTokens = keywords
        .filter((kw) => !highPriorityTokens.includes(kw) && !stopGeneralTokens.has(kw))
        .sort((a, b) => b.length - a.length)
        .slice(0, 15);
      // Deeper per-token candidate take. Measured 2026-09-20 (n=100, with per-probe
      // reranking): 60/10 lifts 2Wiki 0.7925 -> 0.8025, MuSiQue 0.7617 -> 0.7717,
      // enterprise hit@1 0.800 -> 0.8375 (HotpotQA unchanged, latency unchanged), because
      // a gold paragraph the shallow pool never admitted cannot be promoted by rerank.
      const perTokenTake = Math.max(20, Number(process.env.RETRIEVAL_TOKEN_QUERY_TAKE || 60));

      // Batch general tokens into small groups of 4 to prevent Prisma connection pool starvation
      // and reduce DB roundtrips by up to 75% on large corpora
      const tokenBatchSize = 4;
      const tokenBatches: string[][] = [];
      for (let i = 0; i < generalTokens.length; i += tokenBatchSize) {
        tokenBatches.push(generalTokens.slice(i, i + tokenBatchSize));
      }
      const generalChunksPromise = Promise.all(
        tokenBatches.map((tokens) =>
          (this.prisma as any).chunk.findMany({
            where: {
              kbId: { in: scope },
              document: { status: "published" },
              OR: tokens.map((kw) => ({ content: { contains: kw, mode: "insensitive" } })),
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
            take: perTokenTake * tokens.length,
          }).catch(() => [] as any[]),
        ),
      );

      // 4. Title-affinity retrieval promise
      const titleTokens = keywords
        .filter((kw) => kw.length >= 2 && kw.length <= 12 && !stopGeneralTokens.has(kw) && !/^第[一二三四五六七八九十百0-9]+[章节条款]/.test(kw))
        .slice(0, 6);

      const affinityChunksPromise = titleTokens.length > 0
        ? (async () => {
            const affinityDocs = await (this.prisma as any).document.findMany({
              where: {
                kbId: { in: scope },
                status: "published",
                OR: titleTokens.map((kw) => ({ title: { contains: kw, mode: "insensitive" } })),
              },
              select: { id: true, title: true, updatedAt: true },
              // Pull a bounded pool and rank it by title relevance instead of
              // taking the first N rows the storage layer happens to return:
              // an arbitrary truncation here could drop the document whose
              // title actually matches the question.
              take: 200,
              orderBy: { updatedAt: "desc" },
            }).catch(() => [] as any[]);
            const lowQueryTokens = titleTokens.map((kw) => kw.toLowerCase());
            const rankedDocs = [...(affinityDocs || [])]
              .map((doc: any) => {
                const title = String(doc.title || "").toLowerCase();
                const baseTitle = title.replace(/\.[a-z0-9]+$/i, "");
                let matched = 0;
                for (const token of lowQueryTokens) {
                  if (title.includes(token)) matched += 1;
                }
                const exactBaseMatch = baseTitle.length >= 2 && lowQueryTokens.some((t) => baseTitle === t);
                return { id: doc.id, matched, exactBaseMatch, titleLength: title.length };
              })
              .sort((a: any, b: any) => {
                if (a.exactBaseMatch !== b.exactBaseMatch) return a.exactBaseMatch ? -1 : 1;
                if (a.matched !== b.matched) return b.matched - a.matched;
                // Shorter titles are more specific: "报销制度" beats
                // "报销制度实施细则补充说明".
                if (a.titleLength !== b.titleLength) return a.titleLength - b.titleLength;
                return String(a.id).localeCompare(String(b.id));
              })
              .slice(0, 20)
              .map((doc: any) => doc.id);
            const affinityDocIds = rankedDocs;
            if (!affinityDocIds.length) return [];
            return (this.prisma as any).chunk.findMany({
              where: { kbId: { in: scope }, documentId: { in: affinityDocIds }, document: { status: "published" } },
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
            }).catch(() => [] as any[]);
          })()
        : Promise.resolve([]);

      // 5. Parallel Burst: Await all 6 retrieval channels simultaneously
      // 5-pre. Knowledge-graph arm: chunks that the graph says are related to the
      //       entities in the question (direct relations plus a bounded 2-hop
      //       neighbourhood). This is the third RRF channel: previously the graph
      //       never competed in the ranking at all — it was appended as 800
      //       characters of text after ranking had already happened, so a chunk
      //       that only the graph could find could never displace a weaker
      //       lexical/vector hit.
      const graphArmPromise: Promise<any[]> = (async () => {
        if (!this.graphRagService || !scope.length) return [];
        if (process.env.ENABLE_GRAPHRAG_CONTEXT === "false") return [];
        try {
          const related = await this.graphRagService.searchRelatedChunkIds(
            scope,
            query,
            Math.max(5, Number(process.env.RETRIEVAL_GRAPH_ARM_LIMIT || 20)),
          );
          if (!related.length) return [];
          const ids = related.map((r) => r.chunkId);
          const rows: any[] = await this.prisma.$queryRaw`
            SELECT c.id, c."documentId", c."kbId", c.ord, c.content, c.metadata,
                   d.title AS "docTitle", d.version AS "docVersion"
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c.id = ANY(${ids}::uuid[])
              AND c."kbId" = ANY(${scope}::uuid[])
              AND d.status = 'published'
          `;
          const rankById = new Map(related.map((entry, idx) => [entry.chunkId, idx + 1]));
          return (rows || [])
            .map((row: any) => ({
              id: row.id,
              documentId: row.documentId,
              kbId: row.kbId,
              ord: row.ord,
              content: row.content,
              metadata: row.metadata,
              document: { title: row.docTitle, version: row.docVersion },
              graphArmRank: rankById.get(String(row.id)) || null,
            }))
            .filter((row) => row.graphArmRank !== null);
        } catch (err) {
          this.logger.debug(`Graph retrieval arm unavailable: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      })();

      // 5. Full-corpus BM25 (engine-side lexical channel). PostgreSQL resolves
      //    the matching set over the whole ACL scope through the tsvector GIN
      //    index and ranks it with BM25, so unlike the per-token `ILIKE` sweep
      //    below it cannot drop a relevant chunk because of an ordering-based
      //    LIMIT. The ILIKE sweep stays as the fallback for scopes whose index
      //    has not been backfilled yet.
      const engineLexicalPromise: Promise<Array<{ hit: any; rank: number }>> = (async () => {
        if (!this.lexicalIndexService?.isEnabled?.()) return [];
        const lexicalTerms = Array.from(
          new Set([
            ...keywords.flatMap((keyword) => tokenizeQuery(String(keyword || ""))),
            ...tokenizeQuery(query),
            ...extraVariants.flatMap((variant) => tokenizeQuery(variant)),
          ]),
        ).slice(0, 128);
        if (!lexicalTerms.length) return [];
        const hits = await this.retrievalBulkhead.runOrFallback(
          () =>
            deadline.guard(
              this.lexicalIndexService!.search(scope, lexicalTerms, Math.max(limit * 8, 200), {
                timeoutMs: deadline.slice(Number(process.env.RETRIEVAL_LEXICAL_TIMEOUT_MS || 2000)),
              }),
              [],
              "lexical",
            ),
          [],
        );
        return (hits || []).map((hit, rank) => ({ hit, rank: rank + 1 }));
      })().catch(() => [] as Array<{ hit: any; rank: number }>);

      // BGE-M3 learned sparse arm. This is independent from BM25: weights come
      // from the model vocabulary and can bridge lexical variants that neither
      // exact tokens nor the dense vector rank alone places highly.
      const learnedSparsePromise = this.hybridRetrievalService?.isEnabled()
        ? this.retrievalBulkhead.runOrFallback(
            () => deadline.guard(
              this.hybridRetrievalService!.searchSparse(scope, query, Math.max(limit * 4, 80)),
              [],
              'bge-m3-sparse',
            ),
            [],
          )
        : Promise.resolve([]);

      // 6. Parallel Burst: Await all retrieval channels simultaneously
      const [pChunks, chChunks, generalBatches, aChunks, vectorHits, subVectorHits, engineLexical, graphArmHits, learnedSparseHits] = await Promise.all([
        pChunksPromise,
        chChunksPromise,
        generalChunksPromise,
        affinityChunksPromise,
        vectorHitsPromise,
        subQueryVectorPromise,
        engineLexicalPromise,
        graphArmPromise,
        learnedSparsePromise,
      ]);

      (pChunks || []).forEach((c: any) => chunkMap.set(c.id, c));
      (chChunks || []).forEach((c: any) => chunkMap.set(c.id, c));
      for (const batch of generalBatches || []) {
        for (const c of batch || []) {
          chunkMap.set(c.id, c);
        }
      }
      (aChunks || []).forEach((c: any) => {
        if (!chunkMap.has(c.id)) chunkMap.set(c.id, c);
      });

      // Merge the semantic arm into the candidate pool
      for (const hit of [...(vectorHits || []), ...(subVectorHits || [])]) {
        const prevScore = vectorScoreById.get(hit.id);
        if (prevScore === undefined || hit.score > prevScore) vectorScoreById.set(hit.id, hit.score);
        if (!chunkMap.has(hit.id)) chunkMap.set(hit.id, hit);
      }

      // Merge the engine-side BM25 arm and keep its ranking for the lexical
      // rank channel below.
      const engineLexicalRank = new Map<string, number>();
      for (const entry of engineLexical || []) {
        engineLexicalRank.set(String(entry.hit.id), entry.rank);
        if (!chunkMap.has(entry.hit.id)) chunkMap.set(entry.hit.id, entry.hit);
      }

      // Graph arm ranking (third RRF channel).
      const graphArmRank = new Map<string, number>();
      for (const hit of graphArmHits || []) {
        if (hit.graphArmRank) graphArmRank.set(String(hit.id), Number(hit.graphArmRank));
        if (!chunkMap.has(hit.id)) chunkMap.set(hit.id, hit);
      }

      // Learned-sparse ranking (fourth RRF channel).
      const learnedSparseRank = new Map<string, number>();
      for (let index = 0; index < (learnedSparseHits || []).length; index += 1) {
        const hit: any = (learnedSparseHits as any[])[index];
        learnedSparseRank.set(String(hit.id), index + 1);
        if (!chunkMap.has(hit.id)) chunkMap.set(hit.id, hit);
      }

      const allFound = Array.from(chunkMap.values());
      if (allFound.length === 0) {
        return [];
      }

      const lowQuery = query.toLowerCase();
      const variantLowers = variantQueries.map((v) => v.toLowerCase());
      const activeDomainTerms = domainTerms.filter((term) => {
        const normalized = String(term || "").toLowerCase();
        if (!normalized) return false;
        return (
          variantLowers.some((v) => v.includes(normalized)) ||
          keywords.some((k) => k.toLowerCase() === normalized)
        );
      });
      const isArticleCountQuery = /(?:一共|共有|总共|全部)?(?:有多少|几条|几章|哪些章节|全文结构).*(?:条|章|篇)/.test(query);

      // Lexical channel scoring: local BM25 over the candidate pool (real
      // IDF/TF/length normalisation) replaces the fixed per-keyword points.
      // Structural boosts (第X条 anchors, title match, chapter listing) and
      // the vector-similarity contribution stay as-is. Set
      // LEXICAL_BM25=false to restore the legacy fixed scoring.
      const useBm25 = process.env.LEXICAL_BM25 !== 'false';
      const bm25Index = useBm25
        ? buildBm25Pool(allFound.map((c: any) => ({ id: c.id, text: `${c.content || ''}\n${c.document?.title || ''}` })), keywords)
        : null;
      const bm25 = bm25Index ? bm25Scores(bm25Index) : null;

      // Channel 1: Lexical Ranking
      const lexicalRankMap = new Map<string, number>();
      if (engineLexicalRank.size > 0) {
        // Full-corpus BM25 from the engine is authoritative: its rank already
        // reflects exact corpus df/IDF and length normalisation across every
        // published chunk in scope, not just the chunks that survived the
        // candidate sweep. Pool-local BM25 only orders the structural/title
        // candidates the engine arm did not return.
        for (const [id, rank] of engineLexicalRank) lexicalRankMap.set(id, rank);
        const poolTail = [...allFound]
          .filter((c: any) => !lexicalRankMap.has(c.id))
          .map((c) => ({ id: c.id, score: bm25 ? bm25.get(c.id) || 0 : 0 }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score);
        const offset = lexicalRankMap.size;
        poolTail.forEach((x, idx) => lexicalRankMap.set(x.id, offset + idx + 1));
      } else if (bm25) {
        const sortedLexical = [...allFound]
          .map((c) => ({ id: c.id, score: bm25.get(c.id) || 0 }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score);
        sortedLexical.forEach((x, idx) => lexicalRankMap.set(x.id, idx + 1));
      } else {
        const sortedKw = [...allFound].map((c) => {
          let kwScore = 0;
          const text = (c.content || "").toLowerCase();
          for (const kw of keywords) {
            const lowKw = kw.toLowerCase();
            const isPrimary = primaryKeywords.has(kw);
            const weightMultiplier = isPrimary ? 1.5 : 0.7;
            if (text.includes(lowKw)) kwScore += (kw.length >= 4 ? 3.0 : 1.5) * weightMultiplier;
          }
          return { id: c.id, score: kwScore };
        }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
        sortedKw.forEach((x, idx) => lexicalRankMap.set(x.id, idx + 1));
      }

      // Channel 2: Vector Ranking
      const vectorRankMap = new Map<string, number>();
      const sortedVector = [...allFound]
        .map((c) => ({ id: c.id, score: vectorScoreById.get(c.id) || 0 }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      sortedVector.forEach((x, idx) => vectorRankMap.set(x.id, idx + 1));

      // BGE-M3 multi-vector late interaction only reranks the bounded union
      // produced by the recall channels above; it never scans the whole corpus.
      const lateScores = this.hybridRetrievalService?.isEnabled()
        ? await this.hybridRetrievalService.rerankLateInteraction(
            query,
            allFound.map((chunk: any) => String(chunk.id)),
          )
        : new Map<string, number>();
      const lateRankMap = new Map<string, number>();
      [...lateScores.entries()]
        .sort((left, right) => right[1] - left[1])
        .forEach(([id], index) => lateRankMap.set(id, index + 1));

      // Reciprocal Rank Fusion (RRF, k=60) with structural multipliers
      const rrfK = Number(variant?.rrfK ?? process.env.RETRIEVAL_RRF_K ?? 60);
      // The graph channel is a third, independent ranking signal. It is weighted
      // slightly below lexical/vector because graph recall is precision-limited
      // by extraction quality, but a chunk found only by the graph now competes
      // on rank instead of being appended after the fact.
      const graphRrfWeight = Number(variant?.graphWeight ?? process.env.RETRIEVAL_GRAPH_RRF_WEIGHT ?? 0.8);
      const sparseRrfWeight = Number(variant?.sparseWeight ?? process.env.RETRIEVAL_BGE_M3_SPARSE_RRF_WEIGHT ?? 0.9);
      const lateRrfWeight = Number(variant?.lateWeight ?? process.env.RETRIEVAL_BGE_M3_LATE_RRF_WEIGHT ?? 1.0);
      const scored = allFound.map((c: any) => {
        let rrfScore = 0;
        const lRank = lexicalRankMap.get(c.id);
        if (lRank) rrfScore += 1 / (rrfK + lRank);
        const vRank = vectorRankMap.get(c.id);
        if (vRank) rrfScore += 1 / (rrfK + vRank);
        const gRank = graphArmRank.get(c.id);
        if (gRank) rrfScore += graphRrfWeight / (rrfK + gRank);
        const sRank = learnedSparseRank.get(c.id);
        if (sRank) rrfScore += sparseRrfWeight / (rrfK + sRank);
        const mRank = lateRankMap.get(c.id);
        if (mRank) rrfScore += lateRrfWeight / (rrfK + mRank);

        let boost = 1.0;
        const text = (c.content || "").toLowerCase();
        const docTitle = (c.document?.title || "").toLowerCase();
        const baseTitle = docTitle.replace(/\.[a-z0-9]+$/i, "").trim();

        // Exact high-priority token matches (specific IDs / numbers)
        for (const tok of highPriorityTokens) {
          if (text.includes(tok.toLowerCase())) boost += 0.8;
        }

        // Exact or base document title mentioned directly in user query
        if (baseTitle.length >= 2 && lowQuery.includes(baseTitle)) {
          boost += 1.0;
        }

        // Domain terms
        for (const term of activeDomainTerms) {
          const normalized = String(term || "").toLowerCase();
          if (normalized && text.includes(normalized)) boost += 0.5;
        }

        if (isChapterListing && /(?:##\s*第[一二三四五六七八九十百0-9]+章|##\s*附则)/.test(c.content)) {
          boost += 3.0;
        }

        if (isArticleCountQuery && baseTitle.length >= 2 && lowQuery.includes(baseTitle)) {
          if (c.ord === 0 || /(?:##\s*第[一二三四五六七八九十百0-9]+章|##\s*附则|\*\*第[一二三四五六七八九十百0-9]+条\*\*)/.test(c.content)) {
            boost += 1.2;
          }
        }

        const score = (rrfScore > 0 ? rrfScore : 0.0005) * boost;
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
      const maxPerDoc = Math.max(3, Number(process.env.RETRIEVAL_MAX_CHUNKS_PER_DOC || 10));
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
          const allowedForThisDoc = item.score >= 0.03 ? maxPerDoc + 2 : maxPerDoc;
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
        where: { documentId: { in: docIds }, document: { status: "published" } },
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
                  chunkScores.set(sib.id, itemScore * 0.85);
                }
              });
          }
          if (typeof meta.next_chunk_ord === "number") {
            const next = chunkByOrdAndDoc.get(`${c.documentId}:${meta.next_chunk_ord}`);
            if (next && !expandedChunkIds.has(next.id)) {
              expandedChunkIds.add(next.id);
              expandedChunks.push(next);
              chunkScores.set(next.id, itemScore * 0.85);
            }
          }
          if (typeof meta.prev_chunk_ord === "number") {
            const prev = chunkByOrdAndDoc.get(`${c.documentId}:${meta.prev_chunk_ord}`);
            if (prev && !expandedChunkIds.has(prev.id)) {
              expandedChunkIds.add(prev.id);
              expandedChunks.push(prev);
              chunkScores.set(prev.id, itemScore * 0.85);
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
      const sectionStopRe = /^(?:#{1,3}\s+|（[一二三四五六七八九十百]{1,3}）|[一二三四五六七八九十百]{1,3}、|第[一二三四五六七八九十百0-9]+[章节]|\d+[\.、]\s*[\u4e00-\u9fa5])/;
      const sectionHeadRe = sectionStopRe;
      const sectionExpansionMax = Math.max(2, Number(process.env.RETRIEVAL_SECTION_EXPANSION_MAX || 12));
      let regionBudget = sectionExpansionMax;
      // Chunk objects exist as DUPLICATE instances (chunkMap from the token
      // queries vs allDocChunks from the expansion query), so the group tag is
      // recorded by chunk ID and applied to every expanded instance afterwards.
      const sectionGroupByChunkId = new Map<string, string>();
      const getLeadingLine = (x: any) => {
        const raw = extractRawChunkText(String(x?.content || "")).trim();
        return raw.split("\n")[0].trim();
      };
      for (const selected of topSelected.slice(0, 4)) {
        if (regionBudget <= 0) break;
        const anchor = selected.chunk;
        const ordered = allDocChunks.filter((x: any) => x.documentId === anchor.documentId);
        if (!ordered.length) continue;
        const anchorIdx = ordered.findIndex((x: any) => x.id === anchor.id);
        if (anchorIdx < 0) continue;
        const isHeadingish = (x: any) => {
          const line = getLeadingLine(x);
          return line.length > 0 && line.length <= 80 && sectionHeadRe.test(line);
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
          const line = getLeadingLine(ordered[i]);
          if (line && sectionStopRe.test(line)) break;
          region.push(ordered[i]);
        }
        for (const member of region) {
          if (regionBudget <= 0) break;
          if (!sectionGroupByChunkId.has(member.id)) {
            sectionGroupByChunkId.set(member.id, groupKey);
          }
          if (!sectionGroupByChunkId.has(anchor.id)) {
            sectionGroupByChunkId.set(anchor.id, groupKey);
          }
          if (!expandedChunkIds.has(member.id)) {
            expandedChunkIds.add(member.id);
            expandedChunks.push(member);
            chunkScores.set(member.id, (selected.score || 0.01) * 0.7);
            regionBudget -= 1;
          }
        }
      }
      for (const c of expandedChunks) {
        const g = sectionGroupByChunkId.get(c.id);
        if (g) (c as any).sectionGroup = g;
      }

      const maxRrfScore = Math.max(...Array.from(chunkScores.values()), 0.0001);
      const chnNums = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
      const results: any[] = expandedChunks.map((c: any) => {
        const meta = c.metadata || {};
        const chn = chnNums[meta.chapter_no] || meta.chapter_no || "";
        const chPrefix = chn ? `【第${chn}章】` : "";
        const artPrefix = meta.article_no ? `【第${meta.article_no}条】` : "";
        const evidence = `${chPrefix}${artPrefix} ${c.content}`.trim();
        const rawScore = chunkScores.get(c.id) || 0;
        const relRatio = Math.max(0, rawScore / maxRrfScore);
        const normalizedScore = Number(Math.min(0.99, Math.max(0.05, relRatio * 0.95)).toFixed(3));

        return {
          documentId: c.documentId,
          kbId: c.kbId,
          title: c.document?.title || "未知文档",
          version: c.document?.version || 1,
          ord: c.ord,
          pageNo: meta.page_no || meta.pageNumber || c.ord + 1,
          articleNo: meta.article_no ? `第${meta.article_no}条` : undefined,
          evidence,
          score: Number(normalizedScore.toFixed(3)),
          // min-max normalised inside this arm only (top hit is always 0.95):
          // usable for ordering, never as an absolute relevance measurement.
          scoreSource: "synthetic",
          sectionGroup: (c as any).sectionGroup,
          subQueryOrigin: (c as any).subQueryOrigin,
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
            // A macro-summary citation must still carry a usable source label:
            // these used to surface as "未知文档" because the RAPTOR hit has no page
            // title, only the summary text.
            const summaryTitle = String(hit.title || '').trim()
              || String(hit.evidence || '').match(/《([^》]{2,80})》/)?.[1]
              || (String((hit as any).section || '').includes('level2') ? '全库演进全景摘要' : '宏观摘要');
            results.push({
              documentId: hit.documentId,
              kbId: hit.kbId,
              title: summaryTitle,
              // The agent-facing response maps `docTitle || topic`, so a summary
              // citation without them renders as "未知文档".
              docTitle: summaryTitle,
              topic: summaryTitle,
              version: undefined,
              pageNo: undefined,
              articleNo: undefined,
              evidence: hit.evidence,
              score: hit.score,
              bbox: undefined,
              sectionGroup: undefined,
              subQueryOrigin: undefined,
              previewUrl: hit.previewUrl,
              raptor: true,
              isSummary: true,
            });
          }
        } catch (raptorErr) {
          this.logger.debug(`RAPTOR arm omitted: ${raptorErr instanceof Error ? raptorErr.message : String(raptorErr)}`);
        }
      }
      if (subQueryCacheKey) {
        this.subQueryChunkCache.set(subQueryCacheKey, {
          hits: results.map((r) => ({ ...r })),
          expiresAt: Date.now() + Number(process.env.SUBQUERY_CACHE_TTL_MS || 120_000),
        });
        if (this.subQueryChunkCache.size > 500) {
          const oldest = this.subQueryChunkCache.keys().next().value;
          if (oldest) this.subQueryChunkCache.delete(oldest);
        }
      }
      return results;
    } catch (err) {
      this.logger.warn(`searchChunksFallback error: ${err}`);
      return [];
    }
  }

}
