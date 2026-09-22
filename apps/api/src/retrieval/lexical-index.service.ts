import { Injectable, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import {
  LexicalHit,
  LexicalPrismaLike,
  buildChunkTerms,
  indexDocumentChunks,
  lexicalCoverage,
  refreshKbStat,
  searchLexicalBm25,
  unindexDocument,
} from './lexical-index-store';

export type { LexicalHit };

/**
 * Nest-facing wrapper around the PostgreSQL full-corpus BM25 channel.
 *
 * The heavy lifting (tokenizer + SQL) lives in lexical-index-store so the
 * backfill CLI and the ingestion pipeline run identical statements. This class
 * only adds enablement switches, coverage probes and error tolerance: on any
 * failure it degrades to "no hits" and the request path falls back to the
 * legacy candidate pool instead of failing the answer.
 */
@Injectable()
export class LexicalIndexService {
  private readonly logger = new Logger(LexicalIndexService.name);
  private readonly prisma = getPrismaClient() as unknown as LexicalPrismaLike;

  isEnabled(): boolean {
    return process.env.LEXICAL_INDEX_ENABLED !== 'false';
  }

  /** Exposed for ingestion: tokenize + length in one place. */
  buildChunkTerms(content: string): { len: number; terms: string } {
    return buildChunkTerms(content);
  }

  async indexDocument(
    kbId: string,
    documentId: string,
    chunks?: Array<{ id: string; content: string }>,
  ): Promise<{ indexed: number }> {
    if (!this.isEnabled()) return { indexed: 0 };
    try {
      const rows = chunks?.length
        ? chunks
        : await (this.prisma as any).chunk.findMany({
            where: { documentId },
            select: { id: true, content: true },
            orderBy: { ord: 'asc' },
          });
      if (!rows?.length) return { indexed: 0 };
      return await indexDocumentChunks(this.prisma, kbId, documentId, rows);
    } catch (err) {
      // Never fail ingestion over a derived index; enrichment retry or the
      // backfill CLI will pick it up, and the request path has a fallback.
      this.logger.warn(
        `Lexical indexing failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { indexed: 0 };
    }
  }

  async refreshKbStat(kbId: string): Promise<void> {
    await refreshKbStat(this.prisma, kbId).catch(() => undefined);
  }

  /**
   * Remove a document's postings and repair df/N. Called on the delete path
   * immediately before the Document row (and therefore its chunks) disappear.
   */
  async removeDocument(kbId: string, documentId: string): Promise<{ removed: number; terms: number }> {
    if (!this.isEnabled()) return { removed: 0, terms: 0 };
    try {
      return await unindexDocument(this.prisma, kbId, documentId);
    } catch (err) {
      this.logger.warn(
        `Lexical unindex failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { removed: 0, terms: 0 };
    }
  }

  async coverage(scope: string[]): Promise<{ indexed: number; chunks: number }> {
    return lexicalCoverage(this.prisma, scope).catch(() => ({ indexed: 0, chunks: 0 }));
  }

  /** True when the index can serve this scope; otherwise callers fall back. */
  async canServe(scope: string[]): Promise<boolean> {
    if (!this.isEnabled() || !scope.length) return false;
    try {
      return (await this.coverage(scope)).indexed > 0;
    } catch {
      return false;
    }
  }

  async search(
    scope: string[],
    terms: string[],
    limit: number,
    options: { k1?: number; b?: number; timeoutMs?: number } = {},
  ): Promise<LexicalHit[]> {
    if (!this.isEnabled() || !scope.length) return [];
    try {
      return await searchLexicalBm25(this.prisma, scope, terms, limit, options);
    } catch (err) {
      this.logger.warn(
        `Full-corpus BM25 unavailable (falling back to candidate pool): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
