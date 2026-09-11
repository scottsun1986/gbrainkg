import { Injectable, Logger, Optional } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ModelConfigService } from '../model-config.service';
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
}

/**
 * RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval,
 * Sarthi et al., 2024) builds a hierarchy of summaries on top of the precise
 * clause-level chunks:
 *   level 0 -> per-section/chapter summary
 *   level 1 -> whole-document summary
 *   level 2 -> (optional) knowledge-base global summary
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

  constructor(@Optional() private readonly modelConfigService?: ModelConfigService) {}

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
    const maxGroups = Math.max(1, Number(process.env.RAPTOR_MAX_GROUPS || 40));
    const groups = this.groupChunks(document.chunks).slice(0, maxGroups);
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
      }));
    } catch (err) {
      this.logger.warn(`Document summary fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Keyword search over summary nodes, scoped to the caller's visible KBs. */
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
        evidence: `【宏观摘要 · ${item.node.level === 1 ? '全文' : '章节'}】${item.node.title}\n${item.node.content}`,
        score: Math.max(0.75, 0.9 - index * 0.02),
        previewUrl: item.node.documentId ? buildDocumentPreviewUrl(item.node.kbId, item.node.documentId) : null,
        level: item.node.level,
        raptor: true,
      }));
    } catch (err) {
      this.logger.warn(`RAPTOR search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
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

  private async summarize(label: string, text: string, llm: { baseUrl: string; apiKey: string; modelName: string } | null): Promise<string> {
    const bounded = (text || '').trim().slice(0, this.maxSourceChars);
    if (!bounded) return '';
    if (llm) {
      try {
        const response = await fetch(`${llm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${llm.apiKey}`,
          },
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
            max_tokens: 500,
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

  private extractiveSummary(text: string): string {
    const sentences = text
      .replace(/\s+/g, ' ')
      .split(/(?<=[。！？!?；;])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8);
    const picked = sentences.slice(0, 5).join('');
    return picked.slice(0, 800) || text.slice(0, 300);
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
    return body.length >= 20 ? body.slice(0, 1200) : '';
  }

  private async llmConfig(): Promise<{ baseUrl: string; apiKey: string; modelName: string } | null> {
    if (process.env.RAPTOR_USE_LLM === 'false') return null;
    try {
      const cfg = await this.modelConfigService?.getDefault('llm');
      const baseUrl = (cfg?.provider?.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, '');
      const apiKey = cfg?.provider?.apiKey || process.env.DEEPSEEK_API_KEY || '';
      if (!baseUrl || !apiKey) return null;
      return { baseUrl, apiKey, modelName: cfg?.modelName || process.env.LLM_MODEL || 'deepseek-chat' };
    } catch {
      return null;
    }
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
