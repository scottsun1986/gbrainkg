import { createHash, randomUUID } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { indexableChunkText } from './chunk-text';
import { indexDocumentChunks, unindexDocument } from '../retrieval/lexical-index-store';
import { withServiceContext } from '../db/tenant-context.service';
import { retireSupersededPredecessors } from './version-chain-retirement';

export function immutableVersionsEnabled(): boolean { return process.env.CORE_VERSIONING_ENABLED === '1'; }

/**
 * Version stage/publish transactions are proportional to the block count: the
 * 10k-block publish benchmark takes ~3.8s and a 50k-block build exceeds
 * Prisma's 5s interactive-transaction default (F09, measured 2026-10-09). The
 * budget is therefore explicit and bounded instead of relying on the default;
 * exceeding it still rolls the whole transaction back, so a half-published
 * document remains impossible. The full generational-pointer redesign stays a
 * measured follow-up, not a prerequisite for large documents to publish.
 */
export function versionTransactionBudget(): { timeoutMs: number; maxWaitMs: number } {
  return {
    timeoutMs: Math.max(5_000, Number(process.env.CORE_VERSION_TX_TIMEOUT_MS || 120_000)),
    maxWaitMs: Math.max(2_000, Number(process.env.CORE_VERSION_TX_MAX_WAIT_MS || 10_000)),
  };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
export function artifactManifest(blocks: Array<{ ord: number; rawHash?: string; indexTextHash?: string; rawContent?: string | null; content?: string; charStart: number; charEnd: number; metadata?: any }>): string {
  return hash(JSON.stringify(canonical(blocks.map(b => [b.ord, b.rawHash || hash(b.rawContent ?? b.content ?? ''), b.indexTextHash || hash(indexableChunkText(b.content || '')), b.charStart, b.charEnd,
    Object.fromEntries(Object.entries(b.metadata || {}).filter(([key]) => key !== 'documentVersionId'))]))));
}

export interface StagedBlock {
  ord: number; content: string; rawContent?: string; tokenCount: number; charStart: number; charEnd: number; metadata?: any;
}

/** Immutable artifacts build independently; Chunk is a transactional read projection. */
export class DocumentVersionStore {
  constructor(private readonly prisma: any = getPrismaClient()) {}

  async stage(input: { documentId: string; kbId: string; number: number; sourceHash: string;
    title: string; mdPath: string; parser: string; publicationData: any; blocks: StagedBlock[]; passed: boolean }) {
    const manifestHash = artifactManifest(input.blocks);
    return withServiceContext(this.prisma, async tx => {
      const doc = await tx.document.findUnique({ where: { id: input.documentId } });
      if (!doc || (doc.ingestVersion ?? doc.version) !== input.number || doc.kbId !== input.kbId) throw new Error('Superseded document version');
      const existing = await tx.documentVersion.findUnique({ where: { documentId_number: { documentId: input.documentId, number: input.number } } });
      if (existing) {
        if (existing.manifestHash !== manifestHash || existing.sourceHash !== input.sourceHash) throw new Error('Immutable version input changed; allocate a new input version');
        return existing;
      }
      const versionId = randomUUID();
      const version = await tx.documentVersion.create({ data: {
        id: versionId, documentId: input.documentId, number: input.number, sourceHash: input.sourceHash,
        title: input.title, mdPath: input.mdPath, parserFingerprint: input.parser,
        chunkerFingerprint: 'canonical-block-v1', manifestHash,
        publicationData: input.publicationData, state: input.passed ? 'indexing' : 'needs_review',
      } });
      for (let i = 0; i < input.blocks.length; i += 500) {
        await tx.blockArtifact.createMany({ data: input.blocks.slice(i, i + 500).map(block => ({
          ...block, id: randomUUID(), versionId, rawContent: block.rawContent ?? block.content, rawHash: hash(block.rawContent ?? block.content),
          indexTextHash: hash(indexableChunkText(block.content)),
          metadata: { ...block.metadata, documentVersionId: versionId },
        })) });
      }
      await tx.document.update({ where: { id: input.documentId }, data: {
        buildingVersionId: versionId,
        ...(!doc.activeVersionId ? { status: input.passed ? 'indexing' : 'needs_review', indexReadiness: 'pending' } : {}),
      } });
      if (input.passed) await tx.brainChangeEvent.create({ data: {
        eventType: 'enrichment_request', resourceType: 'document', resourceId: input.documentId, status: 'pending',
        payload: { kbId: input.kbId, version: input.number, versionId },
      } });
      return version;
    }, versionTransactionBudget());
  }

  private async snapshotDense(tx: any, version: any, fingerprint: string, count: number): Promise<string> {
    const generation = await tx.indexGeneration.upsert({
      where: { versionId_channel_modelFingerprint_projectionFingerprint: { versionId: version.id, channel: 'dense', modelFingerprint: fingerprint, projectionFingerprint: 'indexable-chunk-v1' } },
      create: { versionId: version.id, channel: 'dense', modelFingerprint: fingerprint, projectionFingerprint: 'indexable-chunk-v1', manifestHash: version.manifestHash, expectedCount: count, readyCount: count, state: 'ready' },
      update: {},
    });
    await tx.$executeRaw`INSERT INTO "GenerationVector" ("generationId","blockId",embedding)
      SELECT ${generation.id}::uuid,b.id,b.embedding FROM "BlockArtifact" b
      WHERE b."versionId"=${version.id}::uuid AND b.embedding_fingerprint=${fingerprint} AND b.embedding IS NOT NULL ON CONFLICT DO NOTHING`;
    const coverage = await tx.$queryRaw`SELECT count(*)::int AS total FROM "GenerationVector" WHERE "generationId"=${generation.id}::uuid`;
    if (coverage[0]?.total !== count || generation.manifestHash !== version.manifestHash) throw new Error('Generation snapshot coverage incomplete');
    return generation.id;
  }

  /** Build a new model generation without replacing the live read projection. */
  async buildDenseGeneration(versionId: string, fingerprint: string): Promise<string> {
    return withServiceContext(this.prisma, async tx => {
      const version = await tx.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
      const blocks = await tx.blockArtifact.findMany({ where: { versionId }, orderBy: { ord: 'asc' } });
      if (!blocks.length || artifactManifest(blocks) !== version.manifestHash) throw new Error('Invalid immutable generation inputs');
      return this.snapshotDense(tx, version, fingerprint, blocks.length);
    }, versionTransactionBudget());
  }

  /** CAS the active version, then atomically switch to a retained immutable vector generation. */
  async activateDenseGeneration(versionId: string, generationId: string): Promise<boolean> {
    return withServiceContext(this.prisma, async tx => {
      const version = await tx.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${version.documentId}::uuid FOR UPDATE`;
      const doc = await tx.document.findUnique({ where: { id: version.documentId }, include: { kb: { select: { status: true } } } });
      if (doc?.activeVersionId !== versionId || doc.kb.status !== 'active') return false;
      const generation = await tx.indexGeneration.findUnique({ where: { id: generationId } });
      if (!generation || generation.versionId !== versionId || generation.channel !== 'dense' || generation.state !== 'ready' || generation.manifestHash !== version.manifestHash) throw new Error('Invalid generation identity');
      const coverage = await tx.$queryRaw`SELECT count(*)::int AS total FROM "GenerationVector" v JOIN "Chunk" c ON c.id=v."blockId" WHERE v."generationId"=${generationId}::uuid AND c."documentId"=${doc.id}::uuid`;
      if (coverage[0]?.total !== generation.expectedCount || generation.readyCount !== generation.expectedCount) throw new Error('Generation read projection coverage incomplete');
      await tx.$executeRaw`UPDATE "Chunk" c SET embedding=v.embedding, embedding_fingerprint=${generation.modelFingerprint} FROM "GenerationVector" v WHERE v."generationId"=${generationId}::uuid AND c.id=v."blockId" AND c."documentId"=${doc.id}::uuid`;
      await tx.$executeRaw`INSERT INTO "ActiveIndexGeneration" ("versionId","generationId") VALUES (${versionId}::uuid,${generationId}::uuid) ON CONFLICT ("versionId") DO UPDATE SET "generationId"=EXCLUDED."generationId"`;
      return true;
    }, versionTransactionBudget());
  }

  async publish(versionId: string, fingerprint: string): Promise<boolean> {
    return withServiceContext(this.prisma, async tx => {
      const version = await tx.documentVersion.findUnique({ where: { id: versionId }, include: { document: true } });
      if (!version || version.state === 'published') return Boolean(version);
      const doc = version.document;
      // This lock is acquired before all publication writes. No model call is inside it.
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${doc.id}::uuid FOR UPDATE`;
      const current = await tx.document.findUnique({ where: { id: doc.id }, include: { kb: { select: { status: true } } } });
      if (!current || current.buildingVersionId !== versionId || (current.ingestVersion ?? current.version) !== version.number || current.kb.status !== 'active') return false;
      if (version.state !== 'indexing') throw new Error('Version is not publishable');
      const coverage = await tx.$queryRaw`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE embedding IS NULL OR embedding_fingerprint <> ${fingerprint} OR embedding_fingerprint IS NULL)::int AS missing
        FROM "BlockArtifact" WHERE "versionId"=${versionId}::uuid
      `;
      if (!coverage[0]?.total || coverage[0].missing) throw new Error('Version dense coverage incomplete');
      const blocks = await tx.blockArtifact.findMany({ where: { versionId }, orderBy: { ord: 'asc' } });
      if (artifactManifest(blocks) !== version.manifestHash) {
        throw new Error('Version artifact manifest does not match');
      }
      // Remove old lexical contributions before FK cascades remove postings.
      await unindexDocument(tx, doc.kbId, doc.id);
      await tx.chunk.deleteMany({ where: { documentId: doc.id } });
      await tx.$executeRaw`
        INSERT INTO "Chunk" (id,"documentId","kbId",ord,content,"tokenCount","charStart","charEnd",metadata,"contentHash",embedding,embedding_fingerprint)
        SELECT b.id,${doc.id}::uuid,${doc.kbId}::uuid,b.ord,b.content,b."tokenCount",b."charStart",b."charEnd",b.metadata,b."rawHash",b.embedding,b.embedding_fingerprint
        FROM "BlockArtifact" b WHERE b."versionId"=${versionId}::uuid
      `;
      const lexical = await indexDocumentChunks(tx, doc.kbId, doc.id, blocks);
      if (lexical.indexed !== blocks.length) throw new Error('Version lexical coverage incomplete');
      for (const channel of ['dense', 'lexical']) await tx.indexGeneration.upsert({
        where: { versionId_channel_modelFingerprint_projectionFingerprint: { versionId, channel, modelFingerprint: channel === 'dense' ? fingerprint : 'bm25-v1', projectionFingerprint: 'indexable-chunk-v1' } },
        create: { versionId, channel, modelFingerprint: channel === 'dense' ? fingerprint : 'bm25-v1', projectionFingerprint: 'indexable-chunk-v1', manifestHash: version.manifestHash, expectedCount: blocks.length, readyCount: blocks.length, state: 'ready' },
        update: { readyCount: blocks.length, state: 'ready' },
      });
      const generationId = await this.snapshotDense(tx, version, fingerprint, blocks.length);
      await tx.$executeRaw`INSERT INTO "ActiveIndexGeneration" ("versionId","generationId") VALUES (${versionId}::uuid,${generationId}::uuid) ON CONFLICT ("versionId") DO UPDATE SET "generationId"=EXCLUDED."generationId"`;
      await tx.documentVersion.update({ where: { id: versionId }, data: { state: 'published', publishedAt: new Date() } });
      await tx.document.update({ where: { id: doc.id }, data: {
        ...version.publicationData, mdPath: version.mdPath, title: version.title,
        activeVersionId: versionId, buildingVersionId: null, version: version.number,
        pendingRawFileOid: null, pendingTitle: null, pendingContentHash: null,
        status: 'published', indexReadiness: 'ready',
      } });
      // Cross-document chain switch (B02): retiring the predecessor joins the
      // successor's publish transaction so the replacement goes live exactly
      // once and never leaves a window with no readable version.
      await retireSupersededPredecessors(tx, doc.id);
      for (const eventType of ['doc_change', 'aux_enrichment_request']) await tx.brainChangeEvent.create({ data: {
        eventType, resourceType: 'document', resourceId: doc.id, status: 'pending',
        payload: { kbId: doc.kbId, version: version.number, versionId },
      } });
      return true;
    }, versionTransactionBudget());
  }
}
