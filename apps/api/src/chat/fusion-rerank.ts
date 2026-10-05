import { calibrateRerankScore } from '../retrieval/evidence-calibration';
import { getRequestContext } from '../observability/request-context';
import { metricsService } from '../observability/metrics.service';
import { rerankPairs } from '../retrieval/pair-reranker';
import { recordFailopen } from '../observability/failopen';
import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { assertRequestAuthorization, rethrowAuthorizationFailure } from '../permission/authorization-revision';
import type { RetrievedEvidence } from "../retrieval/weknora-client";
import type { ModelConfigService } from "../model-config.service";
import { extractRawChunkText } from "./retrieval-arms";
import { extractCapitalisedCandidates as extractCapitalisedCandidatesImpl } from "./bridge-rescue";

export interface FusionRerankDeps {
  logger: Logger;
  modelConfigService?: ModelConfigService;
}

/** Classify a rerank failure for the rerank_calls_total{outcome} metric. */
function rerankOutcomeOf(error: unknown): 'timeout' | 'error' {
  const name = String((error as any)?.name || '');
  const message = String(error instanceof Error ? error.message : error);
  return name === 'TimeoutError' || name === 'AbortError' || /timeout|timed?\s*out|aborted/i.test(message)
    ? 'timeout'
    : 'error';
}

/** Time one rerank call and report it (P1-6). Rethrows the original error. */
async function timedRerankPairs(
  config: { modelName: string; provider: { baseUrl: string; apiKey?: string } },
  query: string,
  documents: string[],
  timeoutMs: number,
  kind: 'pool' | 'probe_group',
): Promise<Array<{ index: number; relevance_score: number }>> {
  const startedAt = Date.now();
  try {
    const ranked = await rerankPairs(config, query, documents, timeoutMs);
    metricsService.observeRerankCall(kind, documents.length, Date.now() - startedAt, 'ok');
    return ranked;
  } catch (error) {
    metricsService.observeRerankCall(kind, documents.length, Date.now() - startedAt, rerankOutcomeOf(error));
    throw error;
  }
}

/**
 * Rerank input format version (review §3.4): bump whenever the text layout
 * changes (field priority, hierarchy assembly, dedup rules). Embedded in the
 * in-process rerank cache key so a format change cannot replay stale rankings
 * from the previous format within the TTL.
 */
export const RERANK_TEXT_FORMAT_VERSION = 'v2';

/** Structural placeholders that carry no information for the reranker. */
const PLACEHOLDER_HIERARCHY = new Set(['文档正文', '正文', 'default', 'body', 'main', 'content']);

function isMeaningfulHierarchyPart(part: string): boolean {
  const trimmed = String(part || '').trim();
  return Boolean(trimmed) && !PLACEHOLDER_HIERARCHY.has(trimmed.toLowerCase());
}

/**
 * Assemble a contextualized document text for Cross-Encoder reranking.
 * Prepends document title and structural section/article hierarchy so
 * concise factual passages are not penalized for missing query context.
 *
 * Field priority is evidence > context > snippet (review P2): engines may
 * return a truncated preview as `snippet`, and the reranker must score the
 * fullest text available, not a preview.
 */
export function buildContextualizedRerankText(citation: any): string {
  const title = String(citation?.docTitle || citation?.title || '').trim();
  const text = String(citation?.evidence || citation?.context || citation?.snippet || citation?.topic || '');
  const raw = extractRawChunkText(text);

  const breadcrumb = String(citation?.breadcrumb || citation?.metadata?.breadcrumb || '').trim();
  const section = String(citation?.section || citation?.metadata?.section || '').trim();
  // headingHierarchy is passed under either naming (camel from the fallback
  // arm, snake from section metadata); both are honoured, segments filtered.
  const headingHierarchyRaw: unknown[] = Array.isArray(citation?.headingHierarchy)
    ? citation.headingHierarchy
    : Array.isArray(citation?.heading_hierarchy)
      ? citation.heading_hierarchy
      : Array.isArray(citation?.metadata?.heading_hierarchy)
        ? citation.metadata.heading_hierarchy
        : [];
  const headingTrail = headingHierarchyRaw
    .map((h) => String(h || '').trim())
    .filter(isMeaningfulHierarchyPart)
    .join(' > ');
  const articleNo = String(citation?.articleNo || (citation?.metadata?.article_no ? `第${citation.metadata.article_no}条` : '')).trim();

  const structural: string[] = [];
  if (headingTrail) {
    structural.push(headingTrail);
  } else if (isMeaningfulHierarchyPart(breadcrumb) && breadcrumb !== title) {
    structural.push(breadcrumb);
  } else if (isMeaningfulHierarchyPart(section) && section !== title) {
    structural.push(section);
  }
  // The fallback arm bakes 【第X章】【第X条】 into the evidence text itself, so
  // the clause number must not be repeated in the hierarchy (review P2).
  const articleAlreadyInText = Boolean(articleNo) && raw.includes(articleNo);
  if (articleNo && !articleAlreadyInText && !structural.some((p) => p.includes(articleNo))) {
    structural.push(articleNo);
  }
  const hierarchy = structural.filter(Boolean).join(' > ');

  return [title, hierarchy, raw || text]
    .filter(Boolean)
    .join('\n')
    .slice(0, 3000)
    .trim();
}

/**
 * Coarse stage of the two-stage rerank cascade (review §3.2).
 *
 * The pool arrives RRF/score-ordered from the merge. A plain head-slice to
 * RERANK_MAX_DOCS starves a channel whose strong semantic hits sit deeper in
 * the merged order (review 根因 1) and pushes every overflow candidate into
 * un-measured territory (P0-2). This keeps the head candidates of EVERY probe
 * channel admitted regardless of rank, then fills the remaining cross-encoder
 * slots by merged rank. When the retrieval stack attached MaxSim coarse
 * scores (`maxsimScore`, BGE-M3 late interaction), those order the pool
 * instead of the merged rank.
 */
export function coarseSelectRerankPool(citations: any[], keep: number): any[] {
  if (keep >= citations.length) return citations.slice();
  if (keep <= 0) return [];
  const hasMaxsim = citations.some((c: any) => typeof c?.maxsimScore === 'number');
  if (hasMaxsim) {
    return citations
      .slice()
      .sort((a, b) => (Number(b?.maxsimScore) || -Infinity) - (Number(a?.maxsimScore) || -Infinity))
      .slice(0, keep);
  }
  const channelHeads = Math.max(1, Number(process.env.RERANK_CASCADE_CHANNEL_HEADS || 3));
  const selected: any[] = [];
  const taken = new Set<any>();
  const channelCount = new Map<string, number>();
  // Pass 1: every channel's head candidates are guaranteed a pool slot.
  for (const c of citations) {
    const channel = String(c?.subQueryOrigin || '').trim() || '__primary__';
    const count = channelCount.get(channel) || 0;
    if (count >= channelHeads) continue;
    channelCount.set(channel, count + 1);
    selected.push(c);
    taken.add(c);
    if (selected.length >= keep) break;
  }
  // Pass 2: fill the remaining slots by merged rank order.
  for (const c of citations) {
    if (selected.length >= keep) break;
    if (!taken.has(c)) {
      selected.push(c);
      taken.add(c);
    }
  }
  return selected;
}

/**
 * RRF fusion, probe-group / whole-pool rerank and lost-in-the-middle reordering.
 * Extracted from ChatService; behaviour is unchanged (code move + ctor injection).
 */
export class FusionRerankService {
  private readonly logger: Logger;
  private readonly modelConfigService?: ModelConfigService;

  constructor(deps: FusionRerankDeps) {
    this.logger = deps.logger;
    this.modelConfigService = deps.modelConfigService;
  }

  /**
   * Reciprocal Rank Fusion (RRF, Cormack et al., 2009) to federate candidates from
   * the local/GBrain stack and external WeKnora cluster engine. Overlapping hits
   * receive an additive rank boost, reflecting dual independent verification.
   */
  fuseWithWeKnoraRRF(
    baseCitations: any[],
    weknoraEvidences: RetrievedEvidence[],
    rrfK = 60,
  ): any[] {
    if (!weknoraEvidences.length) return baseCitations;
    if (!baseCitations.length) {
      return weknoraEvidences.map((we, rank) => ({
        topic: we.documentId,
        docId: we.documentId,
        kbId: we.kbId,
        version: we.documentVersion,
        evidence: we.content,
        snippet: we.content,
        context: we.content,
        score: we.score,
        rrfScore: 1 / (rrfK + rank + 1),
        externalProvider: "weknora",
      }));
    }

    const fused = new Map<string, { citation: any; rrf: number; sources: Set<string> }>();

    // Fusion key is (document, passage) — not (document). Keying only on the
    // document id collapsed every chunk of a document into a single entry whose
    // evidence was the concatenation of all matched passages, which both lost
    // block-level granularity and merged unrelated passages from the same file.
    // Two systems agreeing on the *same passage* is the signal worth boosting
    // (dual verification); two systems finding different passages of one
    // document are simply two candidates.
    const passageKey = (docId: unknown, text: unknown): string => {
      const normalized = String(text || "").replace(/\s+/g, "").slice(0, 80);
      return `${docId || 'unknown'}::${normalized}`;
    };

    // 1. Ingest base citations (GBrain / local hybrid)
    baseCitations.forEach((cit, rank) => {
      const docKey = passageKey(
        cit.docId || cit.documentId || cit.topic,
        cit.evidence || cit.snippet || cit.context || cit.topic,
      );
      const rrf = 1 / (rrfK + rank + 1);
      fused.set(docKey, {
        citation: { ...cit },
        rrf,
        sources: new Set([cit.externalProvider || 'local_gbrain']),
      });
    });

    // 2. Ingest WeKnora evidences with RRF weight
    const weknoraWeight = Number(process.env.WEKNORA_RRF_WEIGHT || 1.0);
    const weknoraDocIds = new Set(weknoraEvidences.map((we) => String(we.documentId)));
    weknoraEvidences.forEach((we, rank) => {
      const docKey = passageKey(we.documentId, we.content);
      const rrfIncrement = (1 / (rrfK + rank + 1)) * weknoraWeight;
      const existing = fused.get(docKey);
      if (existing) {
        existing.rrf += rrfIncrement;
        existing.sources.add('weknora');
        // Same document *and* same passage retrieved by both engines.
        existing.citation.dualVerified = true;
      } else {
        fused.set(docKey, {
          citation: {
            topic: we.documentId,
            docId: we.documentId,
            kbId: we.kbId,
            version: we.documentVersion,
            evidence: we.content,
            snippet: we.content,
            context: we.content,
            score: we.score,
            externalProvider: "weknora",
          },
          rrf: rrfIncrement,
          sources: new Set(['weknora']),
        });
      }
    });

    // 2b. Document-level corroboration. Passage granularity above decides what
    // the answer sees; this pass decides what the *confidence signal* is: a
    // document that both engines independently surfaced is corroborated, and that
    // document's strongest base passage receives the fusion bonus (once — the
    // bonus is a document-level fact, not a per-chunk one).
    const corroboratedDocs = new Set(
      baseCitations
        .map((cit) => String(cit.docId || cit.documentId || cit.topic || ''))
        .filter((docId) => docId && weknoraDocIds.has(docId)),
    );
    if (corroboratedDocs.size) {
      const bonusByDoc = new Map<string, number>();
      weknoraEvidences.forEach((we, rank) => {
        const docId = String(we.documentId);
        if (!corroboratedDocs.has(docId)) return;
        const bonus = (1 / (rrfK + rank + 1)) * weknoraWeight;
        bonusByDoc.set(docId, Math.max(bonusByDoc.get(docId) || 0, bonus));
      });
      const strongestKeyByDoc = new Map<string, string>();
      for (const [key, entry] of fused) {
        const docId = String(entry.citation.docId || entry.citation.documentId || entry.citation.topic || '');
        if (!corroboratedDocs.has(docId)) continue;
        entry.citation.dualVerified = true;
        const previousKey = strongestKeyByDoc.get(docId);
        if (!previousKey || entry.rrf > (fused.get(previousKey)?.rrf || 0)) {
          strongestKeyByDoc.set(docId, key);
        }
      }
      for (const [docId, key] of strongestKeyByDoc) {
        const entry = fused.get(key);
        if (!entry) continue;
        entry.rrf += bonusByDoc.get(docId) || 0;
      }
    }

    // 3. Sort by combined RRF score descending
    return Array.from(fused.values())
      .sort((a, b) => b.rrf - a.rrf)
      .map(({ citation, rrf, sources }) => ({
        ...citation,
        rrfScore: rrf,
        providers: Array.from(sources),
      }));
  }

  readonly rerankCache = new Map<string, { expiresAt: number; order: number[]; scores: number[] }>();
  rerankModelMissingWarned = false;

  /**
   * Weight auxiliary-probe evidence against primary-query evidence.
   *
   * Sub-question, bridge-entity and LLM-planned probes run *in addition to* the
   * primary query, and each hit carries its own arm-local score (a min-max
   * normalised 0.05-0.99 whose top hit is always ~0.95). Two failure modes were
   * measured and both are wrong:
   *
   *  - no weighting: probe noise competes with primary evidence on equal terms
   *    (2Wiki Recall@10 0.7925 → 0.7375 while MRR stayed 0.98);
   *  - hard banding below the primary *minimum*: probe hits can then never enter the
   *    top-k at all, which defeats their purpose — measured on MuSiQue, 36 of the 40
   *    missed gold paragraphs were rank-1 hits for their own probe, i.e. only probes
   *    could surface them, yet banding pushed them past the whole primary list
   *    (LLM probes added just +0.005 Recall@10).
   *
   * So probe scores are *scaled* (default ×0.9, env RETRIEVAL_PROBE_SCORE_SCALE) and
   * capped below the primary arm's best hit: probe evidence can still enter the top-k
   * — that is how the second/third hop is found — but it never outranks an equally
   * strong primary hit.
   */
  bandProbeHits<T extends { score?: number }>(items: T[], probeHits: Set<any>): T[] {
    const scale = Math.max(0, Math.min(1, Number(process.env.RETRIEVAL_PROBE_SCORE_SCALE || 0.8)));
    if (!probeHits.size || scale >= 1) return items;
    const primaryScores = items
      .filter((item) => !probeHits.has(item))
      .map((item) => Number(item.score))
      .filter((value) => Number.isFinite(value));
    if (!primaryScores.length) return items;
    // Band below the primary arm's *minimum*: measured best on MuSiQue
    // (0.7042 vs 0.6783 when probes were allowed to interleave at ×0.9 and 0.6992
    // with probes off). Probe expansion only pays off once the merged pool is
    // re-scored by a cross-encoder — the search path does not do that yet, so
    // letting probe evidence into the top-k costs more gold than it adds.
    const ceiling = Math.min(...primaryScores) * scale;
    items
      .filter((item) => probeHits.has(item))
      .slice()
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .forEach((item, index) => {
        item.score = Number(Math.max(0.01, ceiling - index * 0.002).toFixed(4));
      });
    return items;
  }

  /**
   * A candidate recalled by a *different* probe than the one the cross-encoder
   * scores it against (bridge entity, hop >= 2, or a distinct sub-question) must
   * not be pruned just because that score is low. Shared by the fresh and cached
   * rerank paths so both agree.
   */
  isMultiHopBridgeCandidate(
    citation: any,
    question: string,
    breadth: boolean,
    result: any,
  ): boolean {
    const origin = String(citation?.subQueryOrigin || "").trim().toLowerCase();
    if (!origin) {
      return Boolean(
        citation?.isBridgeEntity || (typeof citation?.hop === 'number' && citation.hop >= 2),
      );
    }
    const qLower = question.trim().toLowerCase();
    const isSubphraseOfQuery = qLower.includes(origin) || origin.includes(qLower);
    return Boolean(
      citation?.isBridgeEntity ||
        (typeof citation?.hop === 'number' && citation.hop >= 2) ||
        ((breadth || Boolean(result?.isMultiHop)) && !isSubphraseOfQuery),
    );
  }

  /**
   * Whether the query is self-contained enough to be reranked.
   *
   * A cross-encoder scores candidates against the query text. A referential query
   * ("那它具体是怎么定义的") carries no content of its own — its meaning lives in the
   * conversation — so reranking against it is noise. Measured on the enterprise
   * Chinese golden set (190 cases, /chat/search): enabling the probe-group rerank
   * for referential queries dropped hit@5 from 0.842 to 0.789, entirely from the
   * multi-turn category (1.000 -> 0.667), while it improved hit@1 0.621 -> 0.695 and
   * MRR 0.716 -> 0.742 everywhere else. Short/referential queries therefore keep
   * their arm ordering.
   */
  isSelfContainedQuery(query: string): boolean {
    const trimmed = String(query || '').trim();
    // Keep the length floor near zero: a short but specific question ("第十条规定了
    // 什么？") reranks perfectly well, and a length gate measurably threw away the
    // reranker's gains on the enterprise set (hit@1 0.674 -> 0.626 with a 12-char
    // floor). What actually hurts is *referential* text, handled below.
    const minChars = Math.max(0, Number(process.env.RETRIEVAL_RERANK_MIN_CHARS || 2));
    if (trimmed.length < minChars) return false;
    if (/^(?:那|这|它|他|她|该|上述|前面|之前|刚才|继续|同样|还有呢)/u.test(trimmed)) return false;
    return true;
  }

  /** Title comparison key: case/extension/whitespace-insensitive. */
  normalizeTitleForMatch(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\.(docx?|pdf|xlsx?|pptx?|txt|md|csv|html?)$/, '')
      .replace(/[\s\-_·．。()（）\[\]【】]+/g, '');
  }

  /**
   * Capitalised multi-word candidates in a passage (2-4 tokens), stopping-word filtered.
   * Deliberately *not* a relation pattern: the precision comes from checking each
   * candidate against the corpus (does a document with this title exist?), not from
   * guessing which names matter.
   */
  extractCapitalisedCandidates(text: string, limit = 8): string[] {
    // Single implementation (unicode-aware, see bridge-rescue.ts): the previous
    // duplicate here truncated "Andrei Ujică" to "Andrei Ujic", so the bridge hop
    // searched for a name that does not exist.
    return extractCapitalisedCandidatesImpl(text, limit);
  }

  async rerankByProbeGroups(question: string, citations: any[]): Promise<void> {
    if (!citations?.length) return;
    const config = this.modelConfigService
      ? await this.modelConfigService.getDefault('rerank')
      : null;
    if (!config) return;
    const primaryWeight = Number(process.env.RETRIEVAL_PRIMARY_GROUP_WEIGHT || 1);
    const probeWeight = Number(process.env.RETRIEVAL_PROBE_GROUP_WEIGHT || 0.9);
    const maxDocs = Math.max(2, Number(process.env.RERANK_MAX_DOCS || 60));
    const timeoutMs = Math.max(1000, Number(process.env.RERANK_TIMEOUT_MS || 60000));

    const groups = new Map<string, any[]>();
    for (const citation of citations) {
      const key = String(citation?.subQueryOrigin || '').trim() || '__primary__';
      const list = groups.get(key) || [];
      list.push(citation);
      groups.set(key, list);
    }

    await Promise.all(
      Array.from(groups.entries()).map(async ([key, list]) => {
        const rerankQuery = key === '__primary__' ? question : key;
        const pool = list.slice(0, maxDocs);
        const documents = pool
          .map((citation) => buildContextualizedRerankText(citation))
          .filter(Boolean);
        if (documents.length < 2 || documents.length !== pool.length) return;
        try {
          await assertRequestAuthorization();
          const ranked = await timedRerankPairs(config, rerankQuery, documents, timeoutMs, 'probe_group');
          const weight = key === '__primary__' ? primaryWeight : probeWeight;
          for (const item of ranked) {
            const index = Number(item?.index);
            const target = pool[index];
            if (!target) continue;
            const raw = Number(item.relevance_score);
            if (!Number.isFinite(raw)) continue;
            target.relevanceScore = raw;
            target.calibratedProbability = calibrateRerankScore(raw,config.provider.baseUrl,config.modelName);
            target.rerankScore = raw;
            target.score = Number((raw * weight).toFixed(4));
            target.scoreSource = 'rerank';
            target.rerankQuery = rerankQuery === question ? undefined : rerankQuery;
          }
        } catch (error) {
          rethrowAuthorizationFailure(error);
          // Fail-open: this group keeps its arm scores.
        }
      }),
    );
  }

  /**
   * Rerank the merged pool for the chat path.
   *
   * Uses per-probe-group reranking when the pool actually contains probe evidence
   * (sub-question / bridge / hop candidates carry `subQueryOrigin`) and the question is
   * self-contained, because a cross-encoder scoring everything against the original
   * question cannot rank second-hop evidence — the measured effect on the agent search
   * path was 2Wiki 0.7925 -> 0.8025 with FullEvidence 0.52 -> 0.54, and the same
   * blindness applies here. Otherwise it delegates to the existing whole-pool rerank.
   */
  async rerankPool(question: string, result: any, breadth = false): Promise<any> {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const hasProbeGroups = citations.some((citation: any) =>
      String(citation?.subQueryOrigin || '').trim().length > 0,
    );
    if (
      process.env.RETRIEVAL_CHAT_GROUP_RERANK === 'false' ||
      !hasProbeGroups ||
      !this.isSelfContainedQuery(question)
    ) {
      return this.applyRerank(question, result, breadth);
    }
    try {
      await this.rerankByProbeGroups(question, citations);
      const rescored = citations.filter((citation: any) => citation?.scoreSource === 'rerank');
      if (!rescored.length) return this.applyRerank(question, result, breadth);
      return { ...result, citations, reranked: true, platformRerankApplied: true };
    } catch (err) {
      recordFailopen("rerank");
      this.logger.warn(
        `Chat probe-group rerank failed, falling back to whole-pool rerank: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.applyRerank(question, result, breadth);
    }
  }

  async applyRerank(
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
    if (!config) {
      // Previously silent: without this line an unconfigured/unreachable
      // reranker was indistinguishable from "no rerank needed", and operators
      // saw only "重排服务不可用" in the trace with no cause.
      if (!this.rerankModelMissingWarned) {
        this.rerankModelMissingWarned = true;
        this.logger.warn(
          "Platform rerank skipped: no default rerank model (need ModelConfig kind=rerank, isDefault=true, provider.enabled=true). " +
            "Consequences: candidates keep their native/synthetic scores, the relevance floor is only relative, and the fast refusal gate cannot use a calibrated score.",
        );
      }
      return result;
    }
    if (citations.length < 2) {
      this.logger.debug(`Platform rerank skipped: only ${citations.length} candidate(s).`);
      return result;
    }

    // Memoize by (question, candidate-set, rerank-text-format) — section
    // expansion makes candidate sets stable, so repeated questions reuse the
    // same ranking. The format version salt keeps a layout change (field
    // priority, hierarchy assembly) from replaying rankings produced by the
    // previous format within the cache TTL (review P2).
    const candidateHash = createHash("sha256")
      .update(`${RERANK_TEXT_FORMAT_VERSION}||${question}||${citations.map((c: any) => c.evidence || c.snippet || c.docId || c.topic || "").join("\u0001")}`)
      .digest("hex")
      .slice(0, 24);
    const cacheKey = JSON.stringify([config.provider.baseUrl, config.modelName, process.env.RERANK_DEPLOYMENT_REVISION,
      getRequestContext()?.userId, getRequestContext()?.authorization?.revision, candidateHash]);
    const cached = process.env.RERANK_DEPLOYMENT_REVISION ? this.rerankCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > Date.now() && cached.order.length === citations.length) {
      const reranked = cached.order.map((idx, rank) => ({
        ...citations[idx],
        score: cached.scores[rank],
        rerankScore: cached.scores[rank],
        relevanceScore: cached.scores[rank],
        calibratedProbability: calibrateRerankScore(cached.scores[rank],config.provider.baseUrl,config.modelName),
        scoreSource: "rerank",
        // The rerank cache stores only order+scores, so re-derive the multi-hop
        // floor exemption here too; otherwise a bridge candidate recalled by a
        // different probe would lose its exemption on a cache hit and be pruned
        // by a score the cross-encoder produced for the wrong question.
        ...(this.isMultiHopBridgeCandidate(citations[idx], question, breadth, result)
          ? { floorExempt: true, floorExemptReason: "multi_hop_bridge" as const }
          : {}),
      }));
      return { ...result, citations: reranked, topics: reranked.map((c: any) => c.topic), answer: reranked.map((c: any) => c.context || c.snippet).filter(Boolean).join("\n\n"), reranked: true, platformRerankApplied: true };
    }

    // Cross-encoding every candidate is the dominant cost: a 180-candidate
    // request with 3k-char documents cannot finish inside a sane timeout on a
    // small instance, and the list is already score-ordered, so the tail adds
    // little. Two-stage cascade (review §3.2, P1-6): the coarse stage below
    // caps the pool at RERANK_MAX_DOCS (default 60 — raised capacity was the
    // 27cd327 default and measurably increased whole-batch timeout risk),
    // preserving every probe channel's head candidates instead of a plain
    // head slice. Keep the index mapping exact.
    const maxRerankDocs = Math.max(2, Number(process.env.RERANK_MAX_DOCS || 60));
    const rerankPool = citations.length > maxRerankDocs
      ? (process.env.RERANK_CASCADE_ENABLED !== 'false'
        ? coarseSelectRerankPool(citations, maxRerankDocs)
        : citations.slice(0, maxRerankDocs))
      : citations;
    const documents = rerankPool
      .map((citation: any) => buildContextualizedRerankText(citation))
      .filter(Boolean);
    if (documents.length < 2) return result;

    // Build mapping from filtered document index → original citation index
    // This is critical because filter(Boolean) compresses the array, so API
    // indices won't match original citation positions.
    const docIndexToCitationIdx = rerankPool
      .map((citation: any, i: number) => {
        const trimmed = buildContextualizedRerankText(citation);
        return trimmed ? i : null;
      })
      .filter((i: any): i is number => i !== null);
    try {
      await assertRequestAuthorization();
      const ranked = await timedRerankPairs(config, question, documents, Number(process.env.RERANK_TIMEOUT_MS || 60000), 'pool');
      if (!ranked.length) return result;

      const scoredItems = ranked
        .map((item) => {
          const docIdx = Number(item.index);
          // Map filtered document index back to original citation index
          const citIdx = docIndexToCitationIdx[docIdx];
          if (citIdx === undefined) return null; // Should not happen if logic is correct
          const cit = citations[citIdx];
          const rawCrossScore = item.relevance_score;
          // Multi-hop / bridge candidates recalled by a specific subquery probe should not be
          // destroyed by cross-encoder comparing them against the original (hop-1) question.
          // However, single-hop queries or sub-queries that are simply reformulations/substrings of the
          // main question are competing on the EXACT same question, so the cross-encoder score is authoritative.
          const origin = String(cit?.subQueryOrigin || "").trim().toLowerCase();
          const qLower = question.trim().toLowerCase();
          const isSubphraseOfQuery = origin.length > 0 && (qLower.includes(origin) || origin.includes(qLower));
          const isTrueBridgeOrMultiHop = this.isMultiHopBridgeCandidate(cit, question, breadth, result);
          // A bridge/hop-2 candidate was recalled by a different probe than the
          // one the cross-encoder scores it against, so a low cross-encoder
          // score is not evidence that it is irrelevant. Previously this was
          // handled by lifting the *score* (max with the retrieval score or a
          // 0.85 constant), which put a fabricated number on the same scale as
          // real cross-encoder output and let it clear the relevance floor and
          // the refusal gate. Keep the measured score and exempt the citation
          // from score-based pruning explicitly instead.
          const floorExempt = isTrueBridgeOrMultiHop && rawCrossScore < 0.70;
          return {
            idx: citIdx,
            citation: floorExempt
              ? { ...cit, floorExempt: true, floorExemptReason: 'multi_hop_bridge' }
              : cit,
            score: rawCrossScore,
          };
        })
        .filter((item): item is { idx: number; citation: any; score: number } => item !== null);
      if (!scoredItems.length) return result;
      scoredItems.sort((a, b) => b.score - a.score);

      const order = scoredItems.map((item) => item.idx);
      const scores = scoredItems.map((item) => item.score);
      if (process.env.RERANK_DEPLOYMENT_REVISION) this.rerankCache.set(cacheKey, { expiresAt: Date.now() + Number(process.env.RERANK_CACHE_TTL_MS || 300000), order, scores });
      if (this.rerankCache.size > 200) {
        const oldest = this.rerankCache.keys().next().value;
        if (oldest) this.rerankCache.delete(oldest);
      }

      // No truncation here: the single evidence-selection stage decides what
      // enters the answer context, using these comparable scores.
      //
      // Candidates the cross-encoder did not score (never sent because the
      // candidate list exceeded RERANK_MAX_DOCS, or dropped for empty text) are
      // appended in their original order instead of being deleted. Dropping
      // them silently removed recall nothing downstream could restore — a gold
      // chunk ranked below the cap could never re-enter the evidence set. They
      // keep their own provenance and carry no fabricated cross-encoder score.
      const reranked = scoredItems.map((item) => ({
        ...item.citation,
        score: item.score,
        rerankScore: item.score,
        relevanceScore: item.score,
        calibratedProbability: calibrateRerankScore(item.score,config.provider.baseUrl,config.modelName),
        // Measured cross-encoder output: the only score kind an absolute
        // threshold (refusal floor, relevance floor) may be compared against.
        scoreSource: "rerank",
      }));
      if (process.env.RERANK_KEEP_UNSCORED !== 'false') {
        const scoredIndexes = new Set(scoredItems.map((item) => item.idx));
        for (let index = 0; index < citations.length; index += 1) {
          if (scoredIndexes.has(index)) continue;
          reranked.push({ ...citations[index], rerankSkipped: true });
        }
      }
      return {
        ...result,
        citations: reranked,
        topics: reranked.map((c: any) => c.topic),
        answer: reranked.map((c: any) => c.context || c.snippet).filter(Boolean).join("\n\n"),
        reranked: true,
        platformRerankApplied: true,
      };
    } catch (error) {
      recordFailopen("rerank");
      this.logger.warn(`Rerank unavailable; retaining GBrain ranking: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Lost-in-the-middle context reordering (Liu et al., 2023):
   * Places the most relevant evidence chunks at the beginning and end of the context
   * prompt, avoiding the attention decay in the middle.
   */
  reorderLostInTheMiddle<T>(items: T[]): T[] {
    if (!items || items.length <= 4) return items ? [...items] : [];
    // Keep the top 2 primary hop/evidence chunks anchored at the front so multi-hop reasoning
    // is never severed by intervening distractors.
    const topAnchors = items.slice(0, 2);
    const rest = items.slice(2);
    const result: T[] = new Array(rest.length);
    let left = 0;
    let right = rest.length - 1;
    for (let i = 0; i < rest.length; i++) {
      if (i % 2 === 0) {
        result[left++] = rest[i];
      } else {
        result[right--] = rest[i];
      }
    }
    return [...topAnchors, ...result];
  }

}
