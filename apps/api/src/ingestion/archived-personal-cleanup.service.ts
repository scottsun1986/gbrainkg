import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { rm, realpath, access, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { getRequestContext } from '../observability/request-context';
import { PermissionService } from '../permission/permission.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { GraphRagService } from '../graph-rag/graph-rag.service';
import { RaptorService } from '../raptor/raptor.service';
import { LexicalIndexService } from '../retrieval/lexical-index.service';
import { ObjectStorageService } from '../storage/object-storage.service';

export interface ArchivedCleanupPlan {
  operationId: string;
  kbId: string;
  kbName: string;
  ownerUserId: string;
  uploadRoot: string;
  brainRepoBasePath: string;
  documents: Array<{ id: string; status: string; indexReadiness: string; version: number; updatedAt: string; objectKey: string | null; storageProvider: string; rawFileOid: string | null; pendingRawFileOid: string | null }>;
  retainedReady: number;
  retainedReadyIds: string[];
}
const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function storageRoots() {
  const uploadRoot = process.env.UPLOAD_ROOT;
  const brainRepoBasePath = process.env.BRAIN_REPO_BASE_PATH;
  if (!uploadRoot || !brainRepoBasePath || !isAbsolute(uploadRoot) || !isAbsolute(brainRepoBasePath))
    throw new Error('Explicit absolute runtime UPLOAD_ROOT and BRAIN_REPO_BASE_PATH required');
  return { uploadRoot: resolve(uploadRoot), brainRepoBasePath: resolve(brainRepoBasePath) };
}

/** Internal maintenance service. No HTTP route; never changes archived -> active. */
@Injectable()
export class ArchivedPersonalCleanupService {
  private readonly db = getPrismaClient() as any;
  constructor(
    private readonly permissions: PermissionService,
    private readonly compiler: BrainCompilerService,
    private readonly graph: GraphRagService,
    private readonly raptor: RaptorService,
    private readonly lexical: LexicalIndexService,
    private readonly storage: ObjectStorageService,
    @InjectQueue('ingestion-queue') private readonly ingestionQueue: Queue,
    @InjectQueue('enrichment-queue') private readonly enrichmentQueue: Queue,
    @InjectQueue('aux-enrichment-queue') private readonly auxiliaryQueue: Queue,
    @InjectQueue('dirty-compiler-queue') private readonly compilerQueue: Queue,
  ) {}

  private reviewedRoots(plan: ArchivedCleanupPlan) {
    const roots = storageRoots();
    if (plan.uploadRoot !== roots.uploadRoot || plan.brainRepoBasePath !== roots.brainRepoBasePath)
      throw new Error('Storage namespace differs from reviewed plan');
    return roots;
  }

  // Missing files are normal on retry. Resolve their nearest existing ancestor
  // rather than skipping symlink checks whenever the final file is absent.
  private async canonicalPath(path: string): Promise<string> {
    try { return await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Raw storage has a dangling symlink');
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
      }
      const parent = dirname(path);
      if (parent === path) throw error;
      return resolve(await this.canonicalPath(parent), basename(path));
    }
  }

  private async validateRawStorage(uploadRoot: string, doc: ArchivedCleanupPlan['documents'][number]) {
    const root = await realpath(uploadRoot);
    const docRoot = resolve(uploadRoot, doc.id);
    const canonicalDocRoot = resolve(root, doc.id);
    if (await this.canonicalPath(docRoot) !== canonicalDocRoot)
      throw new Error('Raw storage symlink escapes document namespace');
    const rawPaths = [...new Set([doc.rawFileOid, doc.pendingRawFileOid].filter(Boolean) as string[])];
    for (const raw of rawPaths) {
      if (!isAbsolute(raw) || !resolve(raw).startsWith(docRoot + sep))
        throw new Error('Raw storage path is outside document namespace');
      if (!(await this.canonicalPath(resolve(raw))).startsWith(canonicalDocRoot + sep))
        throw new Error('Raw storage symlink escapes document namespace');
    }
    return { docRoot, rawPaths };
  }

  private async authorize(actor: string, kbId: string, kbName: string, db = this.db) {
    if (!getRequestContext()?.servicePrincipal || !uuid(actor) || !uuid(kbId) || !kbName)
      throw new Error('Cleanup requires a local service principal and explicit identity/scope');
    if (!(await this.permissions.isSystemAdmin(actor))) throw new Error('System administrator required');
    const kb = await db.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb || kb.name !== kbName || kb.type !== 'personal' || kb.status !== 'archived' || kb.ownerUserId !== actor)
      throw new Error('Exact archived personal KB owned by invoking administrator required');
    return kb;
  }

  async plan(actor: string, kbId: string, kbName: string): Promise<ArchivedCleanupPlan> {
    const roots = storageRoots();
    await this.authorize(actor, kbId, kbName);
    const documents: Array<Omit<ArchivedCleanupPlan['documents'][number], 'updatedAt'> & { updatedAt: Date }> = await this.db.document.findMany({ where: { kbId }, orderBy: { id: 'asc' },
      select: { id: true, status: true, indexReadiness: true, version: true, updatedAt: true, objectKey: true, storageProvider: true, rawFileOid: true, pendingRawFileOid: true } });
    return { operationId: randomUUID(), kbId, kbName, ownerUserId: actor,
      ...roots,
      retainedReady: documents.filter(d => d.status === 'published' && d.indexReadiness === 'ready').length,
      retainedReadyIds: documents.filter(d => d.status === 'published' && d.indexReadiness === 'ready').map(d => d.id),
      documents: documents.filter(d => !(d.status === 'published' && d.indexReadiness === 'ready'))
        .map(d => ({ ...d, updatedAt: d.updatedAt.toISOString() })) };
  }

  async verifyBatch(actor: string, plan: ArchivedCleanupPlan, offset: number, batchSize: number) {
    // The plan arrives from a JSON file on disk, so verify its shape exactly as
    // strictly as executeBatch does. An absent retainedReadyIds used to reach
    // `count({ id: { in: undefined } })`, which either throws or silently widens
    // to every row — the retained-identity check then reported success without
    // having checked anything.
    if (!plan || !uuid(plan.operationId) || plan.ownerUserId !== actor ||
        !Array.isArray(plan.documents) || !Array.isArray(plan.retainedReadyIds) ||
        !Number.isInteger(offset) || offset < 0 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
        new Set(plan.documents.map(d => d.id)).size !== plan.documents.length ||
        new Set(plan.retainedReadyIds).size !== plan.retainedReadyIds.length ||
        plan.retainedReadyIds.some(id => !uuid(id)) || plan.documents.some(d => !uuid(d.id)))
      throw new Error('Invalid exact cleanup plan or batch (maximum 100)');
    const { uploadRoot } = this.reviewedRoots(plan);
    await this.authorize(actor, plan.kbId, plan.kbName);
    const checked = plan.documents.slice(offset, offset + batchSize);
    for (const doc of checked) await this.validateRawStorage(uploadRoot, doc);
    const ids = checked.map(d => d.id);
    const counts = await Promise.all([
      this.db.document.count({ where: { id: { in: ids } } }),
      this.db.chunk.count({ where: { documentId: { in: ids } } }),
      this.db.documentVersion.count({ where: { documentId: { in: ids } } }),
      this.db.documentAcl.count({ where: { documentId: { in: ids } } }),
      this.db.brainSourceDocument.count({ where: { documentId: { in: ids } } }),
      this.db.raptorNode.count({ where: { documentId: { in: ids } } }),
      this.db.brainChangeEvent.count({ where: { resourceType: 'document', resourceId: { in: ids } } }),
    ]);
    if (counts.some(Boolean)) throw new Error('Deletion verification found remaining document dependencies');
    for (const doc of checked) {
      if (doc.objectKey) {
        // Same provider allowlist executeBatch enforces, so verification cannot
        // silently probe local disk for an object written to another provider.
        if (!['local', 'minio'].includes(doc.storageProvider)) throw new Error('Unknown object storage provider');
        if (await this.storage.exists(doc.objectKey, doc.storageProvider as 'local' | 'minio'))
          throw new Error('Deletion verification found remaining object');
      }
      for (const path of [doc.rawFileOid, doc.pendingRawFileOid, resolve(uploadRoot, doc.id)].filter(Boolean)) {
        try { await access(path!); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new Error('Deletion verification found remaining raw storage');
      }
      const remaining: Array<{ count: number }> = await this.db.$queryRaw`
        SELECT (
          (SELECT count(*) FROM "ChunkLexicalDoc" WHERE "documentId"=${doc.id}::uuid) +
          (SELECT count(*) FROM "GraphRelation" WHERE "kbId"=${plan.kbId}::uuid AND "provenance" @> ${JSON.stringify([{ documentId: doc.id }])}::jsonb) +
          (SELECT count(*) FROM "GraphEntity" WHERE "kbId"=${plan.kbId}::uuid AND COALESCE("properties"->'docIds','[]'::jsonb) @> ${JSON.stringify([doc.id])}::jsonb)
        )::int AS count`;
      if (remaining[0]?.count !== 0) throw new Error('Deletion verification found remaining lexical/graph dependencies');
    }
    const retained = await this.db.document.count({ where: { id: { in: plan.retainedReadyIds }, kbId: plan.kbId,
      status: 'published', indexReadiness: 'ready' } });
    if (retained !== plan.retainedReadyIds.length) throw new Error('Retained published+ready identity changed');
    return { verifiedDeleted: checked.length, retainedReady: retained, kbStatus: 'archived' };
  }

  async executeBatch(actor: string, plan: ArchivedCleanupPlan, offset: number, batchSize: number, signal?: AbortSignal) {
    if (process.env.ARCHIVED_CLEANUP_ENABLE !== '1') throw new Error('Cleanup kill-switch is closed');
    if (!plan || !uuid(plan.operationId) || plan.ownerUserId !== actor || !Array.isArray(plan.documents) ||
        !Number.isInteger(offset) || offset < 0 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
        new Set(plan.documents.map(d => d.id)).size !== plan.documents.length ||
        plan.documents.some(d => !uuid(d.id) || (d.status === 'published' && d.indexReadiness === 'ready')))
      throw new Error('Invalid exact cleanup plan or batch (maximum 100)');
    const { uploadRoot } = this.reviewedRoots(plan);
    await this.authorize(actor, plan.kbId, plan.kbName);
    // Validate the entire requested batch before even the first external index,
    // object, filesystem or queue mutation. Recheck under each document lock.
    for (const doc of plan.documents.slice(offset, offset + batchSize)) await this.validateRawStorage(uploadRoot, doc);
    const result: Array<{ id: string; outcome: string }> = [];
    const scopes = new Set<string>();
    for (const expected of plan.documents.slice(offset, offset + batchSize)) {
      if (signal?.aborted || process.env.ARCHIVED_CLEANUP_ENABLE !== '1') throw new Error('Cleanup stopped before next document');
      // One locked document per transaction: state checks survive races, failures retain
      // its metadata for idempotent dependency cleanup on a later invocation.
      const outcome = await this.db.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT set_config('app.service', 'on', true), set_config('app.user_id', '', true)`;
        await tx.$queryRaw`SELECT id FROM "KnowledgeBase" WHERE id=${plan.kbId}::uuid FOR SHARE`;
        await this.authorize(actor, plan.kbId, plan.kbName, tx);
        await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${expected.id}::uuid FOR UPDATE`;
        const doc = await tx.document.findUnique({ where: { id: expected.id } });
        if (!doc) {
          const prior = await tx.auditLog.findFirst({ where: { action: 'kb.archived_document_cleanup', resourceId: expected.id,
            details: { path: ['operationId'], equals: plan.operationId } } });
          if (!prior) throw new Error('Missing document without successful cleanup audit');
          return 'already-deleted';
        }
        if (doc.kbId !== plan.kbId || (doc.status === 'published' && doc.indexReadiness === 'ready') ||
            doc.status !== expected.status || doc.indexReadiness !== expected.indexReadiness || doc.version !== expected.version ||
            doc.updatedAt.toISOString() !== expected.updatedAt || doc.objectKey !== expected.objectKey ||
            doc.storageProvider !== expected.storageProvider || doc.rawFileOid !== expected.rawFileOid || doc.pendingRawFileOid !== expected.pendingRawFileOid) throw new Error('Document scope/state changed; regenerate dry-run');
        const events: Array<{ id: string; status: string }> = await tx.$queryRaw`SELECT id, status FROM "BrainChangeEvent" WHERE "resourceType"='document' AND "resourceId"=${doc.id} FOR UPDATE`;
        if (events.some(e => !['dead', 'completed', 'failed'].includes(e.status))) throw new Error('Live outbox work; cleanup refused');
        const versions: Array<{ number: number }> = await tx.documentVersion.findMany({ where: { documentId: doc.id }, select: { number: true } });
        const versionNumbers = new Set([doc.version, doc.ingestVersion ?? doc.version, ...versions.map(v => v.number)]);
        if (versionNumbers.size > 10000) throw new Error('Document version cleanup budget exceeded');
        const jobs: Array<[Queue, string]> = [
          ...[...versionNumbers].flatMap(v => [[this.ingestionQueue, `ingest-${doc.id}-v${v}`],
            [this.enrichmentQueue, `enrich-${doc.id}-v${v}`]] as Array<[Queue, string]>),
          ...events.flatMap(e => [[this.enrichmentQueue, `enrichment-outbox-${e.id}`],
            [this.auxiliaryQueue, `aux-outbox-${e.id}`], [this.compilerQueue, `outbox-event-${e.id}`]] as Array<[Queue, string]>),
        ];
        for (const [queue, id] of jobs) {
          const job = await queue.getJob(id);
          if (job && !['completed', 'failed'].includes(await job.getState())) throw new Error('Live queue work; cleanup refused');
        }
        const { docRoot, rawPaths } = await this.validateRawStorage(uploadRoot, doc);
        const references = [
          ...(doc.objectKey ? [{ objectKey: doc.objectKey, storageProvider: doc.storageProvider }] : []),
          ...[...rawPaths].flatMap(raw => [{ rawFileOid: raw }, { pendingRawFileOid: raw }]),
        ];
        if (references.length && await tx.document.count({ where: { id: { not: doc.id }, OR: references } }))
          throw new Error('Storage reference shared with another document; cleanup refused');
        // Same lifecycle services as normal document deletion, with errors propagated.
        await this.lexical.removeDocument(plan.kbId, doc.id, { strict: true });
        const invalidated = await this.compiler.onKnowledgeDeleted(plan.kbId, doc.id, { requireMapping: true, deferSynthesis: true });
        for (const scopeId of invalidated) scopes.add(scopeId);
        await this.graph.removeDocumentFromGraph(plan.kbId, doc.id, { strict: true });
        await this.raptor.removeDocument(plan.kbId, doc.id, { rebuild: false });
        if (doc.objectKey) {
          if (!['local', 'minio'].includes(doc.storageProvider)) throw new Error('Unknown object storage provider');
          await this.storage.delete(doc.objectKey, doc.storageProvider, { strictProvider: true });
          if (await this.storage.exists(doc.objectKey, doc.storageProvider)) throw new Error('Object remained after deletion');
        }
        for (const raw of rawPaths) await rm(resolve(raw), { force: true });
        await rm(docRoot, { recursive: true, force: true });
        for (const [queue, id] of jobs) { const job = await queue.getJob(id); if (job) await job.remove(); }
        await tx.brainChangeEvent.deleteMany({ where: { resourceType: 'document', resourceId: doc.id } });
        await tx.document.delete({ where: { id: doc.id } });
        // Audit is part of the committed deletion, not AuditService's best-effort log.
        await tx.auditLog.create({ data: { userId: actor, action: 'kb.archived_document_cleanup', resource: 'document', resourceId: doc.id,
          details: { operationId: plan.operationId, kbId: plan.kbId, kbName: plan.kbName, previousStatus: doc.status,
            previousReadiness: doc.indexReadiness, objectKey: doc.objectKey, storageProvider: doc.storageProvider,
            rawFileOid: doc.rawFileOid, pendingRawFileOid: doc.pendingRawFileOid, outboxRemoved: events.length } } });
        // The locked KB remains archived throughout; no reactivation or status transition occurs.
        return 'deleted';
      }, { timeout: 120000, maxWait: 10000 });
      result.push({ id: expected.id, outcome });
    }
    if (scopes.size) await this.compiler.queueScopeSynthesis([...scopes]);
    return result;
  }
}
