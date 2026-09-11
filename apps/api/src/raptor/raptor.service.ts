import { Injectable, Logger, Optional } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ModelConfigService } from '../model-config.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { estimateTokens } from '../chat/context-budget';
import { buildDocumentPreviewUrl } from '../ingestion/preview-url';

interface RaptorSearchHit {
  documentId: string | null;
  kbId: string;
  title: string;
  evidence: string;
  score: number;
  previewUrl: string | null;
  level: number;
  raptor: true;
  section?: string;
}

/**
 * RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval,
 * Sarthi et al., 2024) builds a hierarchy of summaries on top of the precise
 * clause-level chunks:
 *   level 0 -> per-section/chapter/cluster summary
 *   level 1 -> whole-document summary
 *   level 2 -> knowledge-base global evolution summary
 *
 * The tree gives macro-level recall (e.g. "what is this standard about?")
 * without sacrificing the micro-level exact-clause index. Summaries are
 * generated with the configured LLM and fall back to an extractive summary
 * when the model gateway is unavailable, so indexing never hard-fails.
 */
@Injectable()
export class RaptorService {
  private readonly logger = new Logger(RaptorService.name);
  private readonly prisma = getPrismaClient();
  private readonly maxSourceChars = Number(process.env.RAPTOR_MAX_SOURCE_CHARS || 6000);
  private readonly globalTreePendingKbs = new Map<string, NodeJS.Timeout>();
  private readonly globalTreeRunningKbs = new Set<string>();

  constructor(
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {}

  /**
   * Debounced schedule for building KB Level 2 global tree.
   * Prevents batch ingestion of multiple documents from triggering sequential redundant LLM calls.
   */
  scheduleBuildKbGlobalTree(kbId: string, debounceMs = Number(process.env.RAPTOR_GLOBAL_TREE_DEBOUNCE_MS || 15000)): void {
    const existing = this.globalTreePendingKbs.get(kbId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.globalTreePendingKbs.delete(kbId);
      if (this.globalTreeRunningKbs.has(kbId)) {
        this.scheduleBuildKbGlobalTree(kbId, 10000);
        return;
      }
      this.globalTreeRunningKbs.add(kbId);
      try {
        await this.buildKbGlobalTree(kbId);
      } catch (err) {
        this.logger.warn(`Debounced buildKbGlobalTree failed for KB ${kbId}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.globalTreeRunningKbs.delete(kbId);
      }
    }, debounceMs);
    timer.unref?.();
    this.globalTreePendingKbs.set(kbId, timer);
  }

  isEnabled(): boolean {
    // On by default (macro-level recall); set RAPTOR_ENABLED=false to disable.
    return process.env.RAPTOR_ENABLED !== 'false';
  }

  /** Build/refresh the summary tree for one document. Idempotent per document. */
  async indexDocument(kbId: string, documentId: string): Promise<{ nodes: number }> {
    const document = await (this.prisma as any).document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        title: true,
        version: true,
        chunks: {
          orderBy: { ord: 'asc' },
          take: Math.max(20, Number(process.env.RAPTOR_MAX_CHUNKS || 300)),
          select: { id: true, ord: true, content: true, metadata: true },
        },
      },
    });
    if (!document || !document.chunks?.length) return { nodes: 0 };

    const llm = await this.llmConfig();
    // Bound the number of summary groups: a 2600-paragraph document would
    // otherwise trigger thousands of sequential LLM calls and stall the queue.
    const maxGroups = Math.max(1, Number(process.env.RAPTOR_MAX_GROUPS || 12));
    const groups = (await this.clusterChunks(document.chunks)).slice(0, maxGroups);
    const modelVersion = llm ? llm.modelName : 'extractive-v1';
    const sectionNodes: Array<{ title: string; content: string; chunkIds: string[]; clusterKey: string }> = [];

    for (const group of groups) {
      const summary = await this.summarize(`章节《${group.title}》`, group.text, llm);
      sectionNodes.push({ title: group.title, content: summary, chunkIds: group.chunkIds, clusterKey: group.clusterKey });
    }

    const docSummary = await this.summarize(
      `文档《${document.title}》全景`,
      groups.map((g) => `【${g.title}】${g.text.slice(0, 800)}`).join('\n\n').slice(0, this.maxSourceChars),
      llm,
    );

    // Rebuild is wholesale per document: the RaptorNode table has no natural
    // unique key, so delete this document's tree and re-insert it atomically.
    await (this.prisma as any).$transaction([
      (this.prisma as any).raptorNode.deleteMany({ where: { documentId } }),
      (this.prisma as any).raptorNode.createMany({
        data: [
          ...sectionNodes.map((node) => ({
            kbId,
            documentId,
            level: 0,
            title: node.title,
            content: node.content,
            sourceChunkIds: node.chunkIds,
            metadata: { clusterKey: node.clusterKey, modelVersion, tokenCount: estimateTokens(node.content) },
          })),
          {
            kbId,
            documentId,
            level: 1,
            title: `${document.title} · 全文摘要`,
            content: docSummary,
            sourceChunkIds: document.chunks.map((c: any) => c.id),
            metadata: { clusterKey: 'document', modelVersion, tokenCount: estimateTokens(docSummary) },
          },
        ],
      }),
    ]);

    const nodes = sectionNodes.length + 1;
    this.logger.log(`RAPTOR indexed ${nodes} summary nodes for document ${documentId}.`);

    // Refresh Level 2 Knowledge Base Global Tree with debouncing to avoid LLM storm on batch uploads
    this.scheduleBuildKbGlobalTree(kbId);

    return { nodes };
  }

  /**
   * Fetch the document-level (level 1) summary nodes for specific documents.
   * Used to guarantee whole-document coverage when a question touches a
   * document, regardless of how the query is phrased.
   */
  async getDocumentSummaries(documentIds: string[], limit = 4): Promise<RaptorSearchHit[]> {
    if (!this.isEnabled() || !documentIds.length) return [];
    try {
      const nodes = await (this.prisma as any).raptorNode.findMany({
        where: { documentId: { in: documentIds }, level: 1 },
        take: Math.max(1, limit),
      });
      return nodes.map((node: any) => ({
        documentId: node.documentId,
        kbId: node.kbId,
        title: node.title,
        evidence: `【宏观摘要 · 全文】${node.title}\n${node.content}`,
        score: 0.9,
        previewUrl: node.documentId ? buildDocumentPreviewUrl(node.kbId, node.documentId) : null,
        level: 1,
        raptor: true,
        section: 'raptor-level1',
      }));
    } catch (err) {
      this.logger.warn(`Document summary fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Deterministic document structure outline: the ordered list of the
   * document's own headings (一、/（一）/第X章/clause numbering), extracted
   * from chunk boundaries. Model-independent, so "which major parts / what is
   * the structure" questions are answered completely even when the configured
   * summarisation model produces weak narrative summaries.
   */
  async getDocumentOutlines(documentIds: string[], limit = 3): Promise<RaptorSearchHit[]> {
    const ids = documentIds.filter(Boolean).slice(0, Math.max(1, limit));
    if (!ids.length) return [];
    try {
      const docs = await (this.prisma as any).document.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          kbId: true,
          title: true,
          chunks: {
            orderBy: { ord: 'asc' },
            take: Number(process.env.RAPTOR_OUTLINE_MAX_CHUNKS || 400),
            select: { content: true },
          },
        },
      });
      const headingRe = /^(?:#{1,6}\s*)?(?:[一二三四五六七八九十百0-9]+[、.]|第[一二三四五六七八九十百0-9]+[章节])/;
      const hits: RaptorSearchHit[] = [];
      for (const doc of docs) {
        const lines: string[] = [];
        const articleMatches: string[] = [];
        for (const chunk of doc.chunks || []) {
          const rawLines = String(chunk.content || '')
            .replace(/\r/g, '')
            .split(/\n+/)
            .map((l) => l.trim())
            .filter(Boolean);
          for (const l of rawLines) {
            if (headingRe.test(l)) {
              const label = l.replace(/^#{1,6}\s*/, '').slice(0, 50).trim();
              if (label && !/第\s*\d+\s*页/.test(label) && lines[lines.length - 1] !== label) {
                lines.push(label);
                if (lines.length >= Number(process.env.RAPTOR_OUTLINE_MAX_LINES || 60)) break;
              }
            }
          }
          const arts = String(chunk.content || '').match(/(?:^|\s|\*\*)(第[一二三四五六七八九十百0-9]+条)(?:\*\*|\s|$)/g) || [];
          for (const a of arts) {
            const clean = a.replace(/[\s\*]/g, '');
            if (clean && !articleMatches.includes(clean)) {
              articleMatches.push(clean);
            }
          }
        }
        if (articleMatches.length > 0) {
          lines.push(`【条款统计】全文共包含 ${articleMatches.length} 条（自${articleMatches[0]}至${articleMatches[articleMatches.length - 1]}）。`);
        }
        if (!lines.length) continue;
        hits.push({
          documentId: doc.id,
          kbId: doc.kbId,
          title: `${doc.title} · 结构大纲`,
          evidence: `【文档结构大纲 · ${doc.title}】\n${lines.join('\n')}`,
          score: 0.93,
          previewUrl: buildDocumentPreviewUrl(doc.kbId, doc.id),
          level: 1,
          raptor: true,
          section: 'doc-outline',
        });
      }
      return hits;
    } catch (err) {
      this.logger.warn(`Document outline failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Keyword search over summary nodes, scoped to the caller's visible KBs. */
  /** Keyword & macro search over summary nodes, scoped to visible KBs. */
  async search(kbIds: string[], query: string, limit = 5): Promise<RaptorSearchHit[]> {
    if (!this.isEnabled() || !kbIds.length) return [];
    const keywords = this.keywords(query);
    if (!keywords.length) return [];
    try {
      const nodes = await (this.prisma as any).raptorNode.findMany({
        where: {
          kbId: { in: kbIds },
          OR: keywords.flatMap((kw) => [
            { title: { contains: kw, mode: 'insensitive' } },
            { content: { contains: kw, mode: 'insensitive' } },
          ]),
        },
        orderBy: [{ level: 'desc' }],
        take: limit * 4,
      });
      const scored = nodes
        .map((node: any) => {
          const text = `${node.title}\n${node.content}`.toLowerCase();
          const hits = keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
          return { node, hits };
        })
        .filter((item: any) => item.hits > 0)
        .sort((a: any, b: any) => b.hits - a.hits || b.node.level - a.node.level)
        .slice(0, limit);

      return scored.map((item: any, index: number) => ({
        documentId: item.node.documentId,
        kbId: item.node.kbId,
        title: item.node.title,
        evidence: `【宏观摘要 · ${item.node.level === 2 ? '全库演进全景' : item.node.level === 1 ? '全文' : '章节'}】${item.node.title}\n${item.node.content}`,
        score: Math.max(0.75, 0.9 - index * 0.02),
        previewUrl: item.node.documentId ? buildDocumentPreviewUrl(item.node.kbId, item.node.documentId) : null,
        level: item.node.level,
        raptor: true,
        section: item.node.level === 2 ? 'raptor-level2-global' : item.node.level === 1 ? 'raptor-level1' : 'raptor-level0',
      }));
    } catch (err) {
      this.logger.warn(`RAPTOR search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Search specifically for macro/global questions, giving top priority to
   * Level 2 (KB global evolution) and Level 1 (Document panorama) nodes.
   */
  async searchGlobal(kbIds: string[], query: string, limit = 5): Promise<RaptorSearchHit[]> {
    if (!this.isEnabled() || !kbIds.length) return [];
    const keywords = this.keywords(query);
    try {
      const nodes = await (this.prisma as any).raptorNode.findMany({
        where: {
          kbId: { in: kbIds },
          level: { in: [1, 2] },
        },
        orderBy: [{ level: 'desc' }],
        take: limit * 4,
      });

      if (!nodes.length) return [];

      const scored = nodes.map((node: any) => {
        let score = 0.82;
        // Level 2 priority boost for macro queries
        if (node.level === 2) score += 0.12;
        else if (node.level === 1) score += 0.05;

        // Keyword hits
        const text = `${node.title}\n${node.content}`.toLowerCase();
        const hits = keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
        score += Math.min(0.1, hits * 0.02);

        return { node, score };
      });

      scored.sort((a: any, b: any) => b.score - a.score || b.node.level - a.node.level);
      const topHits = scored.slice(0, limit);

      return topHits.map((item: any, index: number) => ({
        documentId: item.node.documentId,
        kbId: item.node.kbId,
        title: item.node.title,
        evidence: `【宏观摘要 · ${item.node.level === 2 ? '全库演进全景' : '全文'}】${item.node.title}\n${item.node.content}`,
        score: Math.max(0.78, Math.min(0.98, item.score - index * 0.02)),
        previewUrl: item.node.documentId ? buildDocumentPreviewUrl(item.node.kbId, item.node.documentId) : null,
        level: item.node.level,
        raptor: true,
        section: item.node.level === 2 ? 'raptor-level2-global' : 'raptor-level1',
      }));
    } catch (err) {
      this.logger.warn(`RAPTOR searchGlobal failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Build/refresh the Level 2 Knowledge-Base Global Evolution Tree.
   * Aggregates all Level 1 document summaries in the KB into a cohesive,
   * macro-level architecture and evolution overview node.
   */
  async buildKbGlobalTree(kbId: string): Promise<{ nodes: number }> {
    if (!this.isEnabled()) return { nodes: 0 };
    try {
      const docNodes = await (this.prisma as any).raptorNode.findMany({
        where: { kbId, level: 1 },
        select: { id: true, title: true, content: true, documentId: true },
      });

      if (!docNodes.length) return { nodes: 0 };

      const llm = await this.llmConfig();
      const modelVersion = llm ? llm.modelName : 'extractive-v1';

      const aggregatedText = docNodes
        .map((n: any) => `【${n.title}】\n${n.content}`)
        .join('\n\n')
        .slice(0, this.maxSourceChars * 2);

      let summary = '';
      if (llm) {
        try {
          const response = await fetch(`${llm.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: llm.headers,
            body: JSON.stringify({
              model: llm.modelName,
              messages: [
                {
                  role: 'system',
                  content: `你是企业知识体系战略架构专家。请对当前知识库中包含的 ${docNodes.length} 篇核心文档全景进行跨文档全局宏观全景与演进总结。
涵盖：
1. 【全库核心业务全貌】：涵盖的主要业务域、职能分工与规范目标；
2. 【制度与规范体系架构】：跨文档间的逻辑依赖、业务流程承接与管理闭环；
3. 【演进历程与核心准则】：知识库反映的业务/技术演进脉络与关键执行底线。
输出结构化全局综述，提纲挈领，面向全局宏观提问。`,
                },
                { role: 'user', content: aggregatedText },
              ],
              temperature: 0.1,
              max_tokens: Number(process.env.RAPTOR_GLOBAL_MAX_TOKENS || 2500),
            }),
            signal: AbortSignal.timeout(20000),
          });
          if (response.ok) {
            const payload: any = await response.json();
            summary = this.assistantText(payload);
          }
        } catch (err) {
          this.logger.warn(`RAPTOR global tree LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!summary) {
        summary = this.extractiveSummary(aggregatedText);
      }

      const title = '全库业务架构与制度演进全景';
      await (this.prisma as any).$transaction([
        (this.prisma as any).raptorNode.deleteMany({ where: { kbId, level: 2 } }),
        (this.prisma as any).raptorNode.create({
          data: {
            kbId,
            documentId: null,
            level: 2,
            title,
            content: summary,
            sourceChunkIds: docNodes.map((n: any) => n.id),
            metadata: {
              clusterKey: 'kb-global-evolution',
              docCount: docNodes.length,
              modelVersion,
              tokenCount: estimateTokens(summary),
            },
          },
        }),
      ]);

      this.logger.log(`RAPTOR built Level 2 KB global tree for KB ${kbId} (covered ${docNodes.length} docs).`);
      return { nodes: 1 };
    } catch (err) {
      this.logger.warn(`RAPTOR buildKbGlobalTree failed: ${err instanceof Error ? err.message : String(err)}`);
      return { nodes: 0 };
    }
  }

  /**
   * RAPTOR Hierarchical Clustering: uses K-Means++ and Soft Assignment
   * over chunk embeddings to discover semantic topic clusters.
   * Falls back to deterministic chapter/section grouping when embeddings are unavailable.
   */
  async clusterChunks(
    chunks: Array<{ id: string; ord: number; content: string; metadata?: any }>,
  ): Promise<Array<{ clusterKey: string; title: string; chunkIds: string[]; text: string }>> {
    if (!chunks.length) return [];
    if (chunks.length <= 2 || !this.embeddingService?.isEnabled()) {
      return this.groupChunks(chunks);
    }

    try {
      // 1. Generate chunk embeddings
      const textsToEmbed = chunks.map((c) => (c.content || '').slice(0, 400));
      const embeddings = await this.embeddingService.embed(textsToEmbed);
      const validPairs: Array<{ chunk: (typeof chunks)[0]; vector: number[] }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const vec = embeddings[i];
        if (vec && Array.isArray(vec) && vec.length > 0) {
          validPairs.push({ chunk: chunks[i], vector: vec });
        }
      }

      if (validPairs.length < 3) {
        return this.groupChunks(chunks);
      }

      // 2. Determine k dynamically: k = min(8, max(2, ceil(sqrt(N))))
      const k = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(validPairs.length))));
      const vectors = validPairs.map((p) => p.vector);
      const { assignments } = this.runKMeansPlusPlus(vectors, k);

      // 3. Build clusters from assignments (supporting soft clustering)
      const clusterMap = new Map<number, Array<(typeof chunks)[0]>>();
      for (let clusterIdx = 0; clusterIdx < k; clusterIdx++) {
        clusterMap.set(clusterIdx, []);
      }
      for (let i = 0; i < assignments.length; i++) {
        const assignedClusters = assignments[i];
        for (const cIdx of assignedClusters) {
          clusterMap.get(cIdx)?.push(validPairs[i].chunk);
        }
      }

      const results: Array<{ clusterKey: string; title: string; chunkIds: string[]; text: string }> = [];
      let clusterSeq = 1;
      for (const [cIdx, clusterChunks] of clusterMap.entries()) {
        if (!clusterChunks.length) continue;
        // Keep chunks ordered by ord for reading fluency
        clusterChunks.sort((a, b) => a.ord - b.ord);
        const uniqueChunks: Array<(typeof chunks)[0]> = [];
        const seenIds = new Set<string>();
        for (const ch of clusterChunks) {
          if (!seenIds.has(ch.id)) {
            seenIds.add(ch.id);
            uniqueChunks.push(ch);
          }
        }

        const title = this.deriveClusterTitle(uniqueChunks, clusterSeq);
        results.push({
          clusterKey: `cluster-${clusterSeq}`,
          title,
          chunkIds: uniqueChunks.map((c) => c.id),
          text: uniqueChunks.map((c) => c.content).join('\n\n').slice(0, this.maxSourceChars),
        });
        clusterSeq++;
      }

      return results.length > 0 ? results : this.groupChunks(chunks);
    } catch (err) {
      this.logger.warn(`RAPTOR vector clustering failed, falling back to heuristic groups: ${err instanceof Error ? err.message : String(err)}`);
      return this.groupChunks(chunks);
    }
  }

  /**
   * K-Means++ with Cosine Distance and Soft Clustering (RAPTOR Gaussian/distance proximity).
   */
  private runKMeansPlusPlus(
    vectors: number[][],
    k: number,
    maxIters = 20,
  ): { assignments: number[][]; centers: number[][] } {
    const dim = vectors[0].length;
    const n = vectors.length;

    // Cosine distance helper
    const dist = (a: number[], b: number[]): number => {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < dim; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom > 1e-9 ? Math.max(0, 1 - dot / denom) : 1;
    };

    // Vector normalization
    const normalize = (v: number[]): number[] => {
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += v[i] * v[i];
      const s = Math.sqrt(norm);
      return s > 1e-9 ? v.map((x) => x / s) : v;
    };

    // 1. K-Means++ Initialization
    const centers: number[][] = [];
    const meanVec = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let d = 0; d < dim; d++) meanVec[d] += v[d] / n;
    }
    let bestDist = Infinity;
    let firstIdx = 0;
    for (let i = 0; i < n; i++) {
      const d = dist(vectors[i], meanVec);
      if (d < bestDist) {
        bestDist = d;
        firstIdx = i;
      }
    }
    centers.push([...vectors[firstIdx]]);

    // Subsequent centers: D(x)^2 weighted selection
    while (centers.length < k) {
      const d2List: number[] = [];
      let sumD2 = 0;
      for (let i = 0; i < n; i++) {
        let minD = Infinity;
        for (const c of centers) {
          const d = dist(vectors[i], c);
          if (d < minD) minD = d;
        }
        const d2 = minD * minD;
        d2List.push(d2);
        sumD2 += d2;
      }
      let r = sumD2 * 0.73;
      let nextCenterIdx = 0;
      for (let i = 0; i < n; i++) {
        r -= d2List[i];
        if (r <= 0) {
          nextCenterIdx = i;
          break;
        }
      }
      centers.push([...vectors[nextCenterIdx]]);
    }

    // 2. Lloyd iterations
    const primaryAssignments: number[] = new Array(n).fill(0);
    for (let iter = 0; iter < maxIters; iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let minD = Infinity;
        let bestC = 0;
        for (let j = 0; j < centers.length; j++) {
          const d = dist(vectors[i], centers[j]);
          if (d < minD) {
            minD = d;
            bestC = j;
          }
        }
        if (primaryAssignments[i] !== bestC) {
          primaryAssignments[i] = bestC;
          changed = true;
        }
      }

      const newCenters: number[][] = Array.from({ length: k }, () => new Array(dim).fill(0));
      const counts: number[] = new Array(k).fill(0);
      for (let i = 0; i < n; i++) {
        const c = primaryAssignments[i];
        counts[c]++;
        for (let d = 0; d < dim; d++) newCenters[c][d] += vectors[i][d];
      }

      let maxShift = 0;
      for (let j = 0; j < k; j++) {
        if (counts[j] > 0) {
          const updated = normalize(newCenters[j].map((x) => x / counts[j]));
          const shift = dist(centers[j], updated);
          if (shift > maxShift) maxShift = shift;
          centers[j] = updated;
        }
      }

      if (!changed || maxShift < 1e-4) break;
    }

    // 3. Soft Clustering (assign point to secondary clusters if close enough)
    const assignments: number[][] = [];
    for (let i = 0; i < n; i++) {
      const distances: Array<{ cluster: number; d: number }> = [];
      for (let j = 0; j < centers.length; j++) {
        distances.push({ cluster: j, d: dist(vectors[i], centers[j]) });
      }
      distances.sort((a, b) => a.d - b.d);
      const minD = distances[0].d;
      const pointClusters = [distances[0].cluster];

      // Soft threshold: within 1.25x of min distance and distance < 0.65
      for (let idx = 1; idx < distances.length; idx++) {
        if (distances[idx].d <= minD * 1.25 && distances[idx].d < 0.65) {
          pointClusters.push(distances[idx].cluster);
        }
      }
      assignments.push(pointClusters);
    }

    return { assignments, centers };
  }

  private deriveClusterTitle(chunks: Array<{ metadata?: any; content: string }>, seq: number): string {
    for (const ch of chunks) {
      const meta = ch.metadata || {};
      if (typeof meta.chapter_no === 'number') return `第${meta.chapter_no}章 聚类主题`;
      if (meta.section && String(meta.section).trim()) {
        const s = String(meta.section).trim().replace(/^#+\s*/, '').slice(0, 40);
        if (s.length >= 2) return `主题：${s}`;
      }
    }
    for (const ch of chunks) {
      const firstLine = (ch.content || '').split('\n')[0].trim().replace(/^#+\s*/, '');
      if (firstLine.length >= 2 && firstLine.length <= 30 && !/^\d+$/.test(firstLine)) {
        return `主题：${firstLine}`;
      }
    }
    return `主题聚类 ${seq}`;
  }

  private groupChunks(chunks: Array<{ id: string; ord: number; content: string; metadata?: any }>) {
    const groups = new Map<string, { title: string; chunkIds: string[]; parts: string[] }>();
    for (const chunk of chunks) {
      const meta = chunk.metadata || {};
      let clusterKey: string;
      let title: string;
      if (typeof meta.chapter_no === 'number') {
        clusterKey = `chapter-${meta.chapter_no}`;
        title = `第${meta.chapter_no}章`;
      } else if (meta.section && String(meta.section).trim()) {
        const section = String(meta.section).trim().replace(/^#+\s*/, '').slice(0, 80);
        clusterKey = `section-${Buffer.from(section).toString('base64url').slice(0, 32)}`;
        title = section;
      } else {
        clusterKey = 'body';
        title = '正文';
      }
      const group = groups.get(clusterKey) || { title, chunkIds: [], parts: [] };
      group.chunkIds.push(chunk.id);
      group.parts.push(chunk.content);
      groups.set(clusterKey, group);
    }
    return Array.from(groups.entries()).map(([clusterKey, group]) => ({
      clusterKey,
      title: group.title,
      chunkIds: group.chunkIds,
      text: group.parts.join('\n\n').slice(0, this.maxSourceChars),
    }));
  }

  private async summarize(label: string, text: string, llm: { baseUrl: string; modelName: string; headers: Record<string, string> } | null): Promise<string> {
    const bounded = (text || '').trim().slice(0, this.maxSourceChars);
    if (!bounded) return '';
    if (llm) {
      try {
        const response = await fetch(`${llm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: llm.headers,
          body: JSON.stringify({
            model: llm.modelName,
            messages: [
              {
                role: 'system',
                content: '你是企业知识库摘要专家。请对给定资料生成忠实、无幻觉的中文摘要，覆盖主题、关键制度/流程、重要数值与适用范围，并保留可追溯的条款线索。只输出摘要正文。',
              },
              { role: 'user', content: `${label}\n\n${bounded}` },
            ],
            temperature: 0.1,
            max_tokens: Number(process.env.RAPTOR_SUMMARY_MAX_TOKENS || 2000),
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
          const payload: any = await response.json();
          const content = this.assistantText(payload);
          if (content) return content;
        }
      } catch (err) {
        this.logger.warn(`RAPTOR summary LLM call failed, using extractive fallback: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.extractiveSummary(bounded);
  }

  /**
   * Model-independent structured fallback: a real outline (section headings +
   * leading sentences), never a raw concatenation of the source. Used when the
   * configured LLM returns empty/echoed content (e.g. reasoning models on long
   * inputs), so macro retrieval still gets usable summaries.
   */
  private extractiveSummary(text: string): string {
    const clean = text.replace(/\[上下文:[^\]]*\]/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const lines = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const headings = lines
      .filter((l) => /^(?:#{1,6}\s|（[一二三四五六七八九十]+）|[一二三四五六七八九十]+、|第[一二三四五六七八九十百0-9]+[章节]|\d{1,3}[.．])/.test(l))
      .map((l) => l.replace(/^#{1,6}\s*/, '').slice(0, 40))
      .filter((v, i, arr) => v && arr.indexOf(v) === i)
      .slice(0, 12);
    const sentences = clean
      .replace(/\s+/g, ' ')
      .split(/(?<=[。！？!?；;])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 10 && !/^[\d\s.、）)]+$/.test(s));
    const picked: string[] = [];
    if (headings.length) picked.push(`要点章节：${headings.join('；')}`);
    picked.push(...sentences.slice(0, 4));
    const out = picked.join(' ').trim().slice(0, 900);
    return out || clean.slice(0, 300);
  }

  /**
   * Reasoning models (e.g. deepseek-v4-flash) may return an empty `content`
   * and place the text in `reasoning_content`; recover the drafted summary
   * from the reasoning tail instead of silently degrading to extractive output.
   */
  private assistantText(payload: any): string {
    const message = payload?.choices?.[0]?.message || {};
    const content = String(message.content || '').trim();
    if (content) return content;
    const reasoning = String(message.reasoning_content || message.reasoning || '').trim();
    if (!reasoning) return '';
    const cues = ['摘要：', '正文：', '概述：', '总结：'];
    let body = reasoning;
    for (const cue of cues) {
      const idx = body.lastIndexOf(cue);
      if (idx >= 0) { body = body.slice(idx + cue.length); break; }
    }
    if (body === reasoning) {
      const parts = reasoning.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) body = parts[parts.length - 1];
    }
    body = body.replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
    // Reject meta-reasoning ("I need to ...", planning) that is not the summary
    // itself; falling back to extractive output is better than storing thoughts.
    if (/^(?:我需要|我们要|需要把|我们需|We need|I need|Let me|let me)/i.test(body)) return '';
    return body.length >= 20 ? body.slice(0, 1200) : '';
  }

  private async llmConfig(): Promise<{ baseUrl: string; modelName: string; headers: Record<string, string> } | null> {
    if (process.env.RAPTOR_USE_LLM === 'false') return null;
    const resolved = await this.modelConfigService?.getLlmChatConfig('llmwiki-raptor');
    if (!resolved) return null;
    return { baseUrl: resolved.baseUrl, modelName: resolved.modelName, headers: resolved.headers };
  }

  private keywords(query: string): string[] {
    const cleaned = query.replace(/[，。！？；：、“”（）《》【】\s]+/g, ' ').trim();
    const parts = cleaned.split(/\s+/).filter((p) => p.length >= 2);
    const grams: string[] = [];
    for (const part of parts) {
      if (part.length <= 8) grams.push(part);
      for (let i = 0; i + 2 <= part.length && grams.length < 20; i += 2) {
        grams.push(part.slice(i, i + 2));
      }
    }
    return Array.from(new Set(grams)).slice(0, 20);
  }
}
