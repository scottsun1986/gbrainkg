import { getRequestContext } from './observability/request-context';
import { readableDocumentWhere } from './retrieval/readable-document-scope';
import { Body, Controller, ForbiddenException, Get, Optional, Post, Query, Req, UseGuards, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getPrismaClient } from './prisma';
import { AuthService } from './auth/auth.service';
import { PermissionService } from './permission/permission.service';
import { AuthGuard } from './auth/auth.guard';
import { BrainRepoAdapter } from '@llmwiki/gbrain-adapter';
import { sourceKeyForKnowledgeBase } from './brain-compiler/brain-source';
import { GraphRagService } from './graph-rag/graph-rag.service';
import { ModelConfigService } from './model-config.service';
import { DocumentAclService } from './permission/document-acl.service';
import { readAuthorizationSnapshot, assertAuthorizationSnapshot } from './permission/authorization-revision';
import { getSharedBrainRepoAdapter } from './brain-compiler/brain-adapter.provider';

type GraphNode = {
  id: string;
  label: string;
  type: 'knowledge_base' | 'document' | 'concept';
  kbId?: string;
  documentId?: string;
  metadata?: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: 'contains' | 'mentions' | 'related_to' | 'references';
  weight: number;
  evidence: Array<{ documentId?: string; chunkId?: string; snippet?: string; provenance?: string }>;
};

function cleanLabel(value: string): string {
  return value.replace(/^#+\s*/, '').replace(/\.(pdf|docx?|pptx?|xlsx?|md|txt|csv)$/i, '').trim();
}

function addTerm(target: Set<string>, value: unknown) {
  const label = cleanLabel(String(value || '').replace(/[「」《》“”"']/g, '').trim());
  if (label.length >= 2 && label.length <= 80 && !/^(文档正文|目录|正文|内容|附件)$/u.test(label)) target.add(label);
}

function extractTerms(title: string, chunks: Array<{ content: string; metadata: unknown }>): string[] {
  const terms = new Set<string>();
  for (const part of cleanLabel(title).split(/[\\/_｜|,:：;；()（）\[\]【】\s]+/u)) addTerm(terms, part);
  for (const chunk of chunks) {
    const metadata = chunk.metadata && typeof chunk.metadata === 'object' ? chunk.metadata as Record<string, unknown> : {};
    addTerm(terms, metadata.section);
    const content = chunk.content || '';
    for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gmu)) addTerm(terms, match[1]);
    for (const match of content.matchAll(/[《「“]([^》」”]{2,60})[》」”]/gu)) addTerm(terms, match[1]);
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/gu)) addTerm(terms, match[1]);
  }
  return [...terms].slice(0, 40);
}

@UseGuards(AuthGuard)
@Controller('api/v1/knowledge-graph')
export class KnowledgeGraphController {
  private readonly prisma = getPrismaClient();
  private readonly gbrain: BrainRepoAdapter;
  /** Content-aware response cache: rebuilding the graph is far too expensive
   * to run on every page view (it scans the corpus and calls GBrain per doc).
   * Keyed by scope+config; on TTL expiry the last snapshot is served stale
   * (stale-while-revalidate) while a single-flight background rebuild runs. */
  private readonly graphCache = new Map<string, { expiresAt: number; storedAt: number; fingerprint: string; payload: any }>();
  /** Single-flight guards so concurrent stale hits share one background rebuild. */
  private readonly rebuilding = new Map<string, Promise<void>>();

  constructor(
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
    @Optional() private readonly graphRagService?: GraphRagService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() @Inject('BRAIN_REPO_ADAPTER') gbrainAdapter?: BrainRepoAdapter,
    private readonly documentAclService: DocumentAclService = new DocumentAclService(permissionService),
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
  }

  @Get()
  async getGraph(
    @Req() req: any,
    @Query('limit') rawLimit?: string,
    @Query('fresh') freshParam?: string,
    @Query('page') rawPage?: string,
    @Query('root') root?: string,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const context = getRequestContext();
    if (context && context.asOf === undefined) context.asOf = Date.now();
    const visibleKbIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const limit = Math.min(Math.max(Number(rawLimit || 1000) || 1000, 1), 1000);
    const maxChunksPerDoc = Math.max(5, Number(process.env.KG_MAX_CHUNKS_PER_DOC || 40));
    const requestedPage = Number(rawPage);
    const page = Number.isFinite(requestedPage) ? Math.min(1000000, Math.max(0, Math.floor(requestedPage))) : 0;
    const readableWhere = await readableDocumentWhere(this.prisma, userId, visibleKbIds);
    let neighborhood: any = {};
    if (root) {
      if (root.startsWith('kb:')) neighborhood = { kbId: root.slice(3) };
      else if (root.startsWith('concept:')) neighborhood = { chunks: { some: { content: { contains: root.slice(8), mode: 'insensitive' } } } };
      else if (root.startsWith('doc:')) {
        const origin = await this.prisma.document.findMany({
          where: { id: root.slice(4), kbId: { in: visibleKbIds }, status: 'published', ...readableWhere },
          take: 1, select: { id: true, title: true, chunks: { take: maxChunksPerDoc, orderBy: { ord: 'asc' }, select: { content: true, metadata: true } } },
        });
        if (!origin.length) throw new ForbiddenException('Document is unavailable');
        const terms = extractTerms(origin[0].title, origin[0].chunks).slice(0, 10);
        neighborhood = { OR: [{ id: origin[0].id }, { chunks: { some: { OR: terms.map(term => ({ content: { contains: term, mode: 'insensitive' } })) } } }] };
      } else throw new ForbiddenException('Unknown graph node');
    }
    const where = { AND: [{ kbId: { in: visibleKbIds }, status: 'published', ...readableWhere }, neighborhood] };
    const inventory = await this.prisma.document.aggregate({ where, _count: true, _max: { updatedAt: true } });
    const knowledgeRevision = JSON.stringify(inventory);
    const projection = { where, page, root, total: inventory._count };
    const forceFresh = ["true", "1"].includes(String(freshParam || ""));

    // Cache is scoped to the caller's visible-KB set so one user's stale
    // snapshot can never leak another scope's nodes.
    const authority = await readAuthorizationSnapshot(userId);
    const cacheKey = `${userId}|${authority.revision}|${authority.expiresAt}|${knowledgeRevision}|${page}|${root || ''}|${limit}|${maxChunksPerDoc}|${[...visibleKbIds].sort().join(',')}`;
    const cacheTtlMs = Math.max(0, Number(process.env.KG_CACHE_TTL_MS || 300_000));
    // LRU eviction, not a wholesale clear. The cache key includes the caller's
    // visible-KB set, so a fleet of users with different scopes fills it fast;
    // clearing every snapshot when it crossed the cap threw away scopes that
    // were still fresh, and the caller's own next request rebuilt from scratch
    // (SOTA E2E P7-02: a fresh snapshot was reported `cached: false` 0.02s
    // after it was built).
    this.evictOldestGraphSnapshot();
    let cached = this.touchGraphSnapshot(cacheKey);
    if (cached) {
      const ids = cached.payload.nodes.filter((node: GraphNode) => node.type === 'document').map((node: GraphNode) => node.documentId!);
      const readable = await this.documentAclService.filterReadableDocuments(userId, ids, { visibleKbIds });
      const versions = await this.prisma.document.findMany({ where: { id: { in: ids }, ...where }, select: { id: true, version: true, activeVersionId: true, contentHash: true, updatedAt: true } });
      const fingerprint = this.documentProjectionVersion(versions);
      if (readable.size !== ids.length || fingerprint !== cached.fingerprint) {
        this.graphCache.delete(cacheKey);
        cached = undefined;
      }
    }

    if (cached) await assertAuthorizationSnapshot(userId, authority);

    if (cached && cached.expiresAt > Date.now() && !forceFresh) {
      return { ...cached.payload, cached: true };
    }

    if (cached && !forceFresh) {
      // Stale-while-revalidate: serve the last snapshot of this exact scope
      // instantly and refresh in the background (single-flight per scope).
      this.scheduleRebuild(cacheKey, userId, visibleKbIds, limit, maxChunksPerDoc, projection);
      // Served from the snapshot, so `cached` is true — freshness is carried by
      // `stale`, not by denying the hit. Reporting `cached: false` here made a
      // 0.01 s snapshot response look like a full rebuild, which is what failed
      // SOTA E2E P7-02 whenever the suite outlived the cache TTL.
      return {
        ...cached.payload,
        cached: true,
        stale: true,
        snapshotAgeSeconds: Math.max(0, Math.round((Date.now() - cached.storedAt) / 1000)),
      };
    }

    // Manual refresh: if a background rebuild for this scope is already
    // running, await it instead of duplicating the expensive work.
    if (forceFresh) {
      const inflight = this.rebuilding.get(cacheKey);
      if (inflight) {
        await inflight;
        const updated = this.graphCache.get(cacheKey);
        if (updated) return { ...updated.payload, cached: false, refreshed: true };
      }
    }

    return this.buildGraph(cacheKey, cacheTtlMs, userId, visibleKbIds, limit, maxChunksPerDoc, projection);
  }

  private documentProjectionVersion(documents: any[]): string {
    return createHash('sha256').update(JSON.stringify(documents.map(doc => [doc.id, doc.version, doc.activeVersionId, doc.contentHash, doc.updatedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex');
  }

  /** Drop the least recently used snapshot once the cache is over capacity. */
  /**
   * Read a snapshot and mark it most recently used. Insertion order is the LRU
   * order, so re-inserting the entry moves it to the end without touching
   * `expiresAt`: a read must not keep a stale snapshot alive forever.
   */
  private touchGraphSnapshot(cacheKey: string) {
    const cached = this.graphCache.get(cacheKey);
    if (cached) {
      this.graphCache.delete(cacheKey);
      this.graphCache.set(cacheKey, cached);
    }
    return cached;
  }

  private evictOldestGraphSnapshot(): void {
    const capacity = Math.max(1, Number(process.env.KG_CACHE_MAX_SNAPSHOTS || 64));
    while (this.graphCache.size > capacity) {
      const oldest = this.graphCache.keys().next();
      if (oldest.done) break;
      this.graphCache.delete(oldest.value);
    }
  }

  private scheduleRebuild(
    cacheKey: string,
    userId: string,
    visibleKbIds: string[],
    limit: number,
    maxChunksPerDoc: number,
    projection?: { where: any; page: number; root?: string; total: number },
  ) {
    if (this.rebuilding.has(cacheKey)) return;
    const task = this.buildGraph(cacheKey, Math.max(0, Number(process.env.KG_CACHE_TTL_MS || 300_000)), userId, visibleKbIds, limit, maxChunksPerDoc, projection)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => { this.rebuilding.delete(cacheKey); });
    this.rebuilding.set(cacheKey, task);
  }

  private async buildGraph(
    cacheKey: string,
    cacheTtlMs: number,
    userId: string,
    visibleKbIds: string[],
    limit: number,
    maxChunksPerDoc: number,
    projection?: { where: any; page: number; root?: string; total: number },
  ) {
    const authority = await readAuthorizationSnapshot(userId);
    const buildStartedAt = Date.now();
    const readableWhere = await readableDocumentWhere(this.prisma, userId, visibleKbIds);
    const candidates = await this.prisma.document.findMany({
      where: projection?.where || { kbId: { in: visibleKbIds }, status: 'published', ...readableWhere },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (projection?.page || 0) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        kbId: true,
        updatedAt: true,
        aclMode: true,
        version: true, activeVersionId: true, contentHash: true,
        kb: { select: { id: true, name: true, type: true } },
        chunks: { orderBy: { ord: 'asc' }, take: maxChunksPerDoc, select: { id: true, content: true, metadata: true } },
      },
    });

    if (projection?.root?.startsWith('doc:') && !candidates.some(doc => `doc:${doc.id}` === projection.root)) {
      const origin = await this.prisma.document.findMany({
        where: { AND: [projection.where, { id: projection.root.slice(4) }] }, take: 1,
        select: { id: true, title: true, kbId: true, updatedAt: true, aclMode: true, version: true, activeVersionId: true, contentHash: true,
          kb: { select: { id: true, name: true, type: true } }, chunks: { orderBy: { ord: 'asc' }, take: maxChunksPerDoc, select: { id: true, content: true, metadata: true } } },
      });
      candidates.push(...origin);
    }
    const readable = await this.documentAclService.filterReadableDocuments(userId, candidates.map(doc => doc.id), { docs: candidates, visibleKbIds });
    const documents = candidates.filter(doc => readable.has(doc.id));

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const conceptDocuments = new Map<string, Set<string>>();
    const documentTerms = new Map<string, string[]>();

    const addNode = (node: GraphNode) => { if (!nodes.has(node.id)) nodes.set(node.id, node); };
    const addEdge = (source: string, target: string, type: GraphEdge['type'], evidence?: GraphEdge['evidence']) => {
      const id = `${source}|${type}|${target}`;
      const current = edges.get(id);
      if (current) {
        current.weight += 1;
        if (evidence?.length && current.evidence.length < 5) current.evidence.push(...evidence.slice(0, 5 - current.evidence.length));
      } else {
        edges.set(id, { id, source, target, type, weight: 1, evidence: evidence || [] });
      }
    };

    for (const document of documents) {
      const kbNodeId = `kb:${document.kb.id}`;
      const documentNodeId = `doc:${document.id}`;
      addNode({ id: kbNodeId, label: document.kb.name, type: 'knowledge_base', kbId: document.kb.id, metadata: { kbType: document.kb.type } });
      addNode({ id: documentNodeId, label: cleanLabel(document.title), type: 'document', kbId: document.kbId, documentId: document.id, metadata: { updatedAt: document.updatedAt.toISOString() } });
      addEdge(kbNodeId, documentNodeId, 'contains', [{ documentId: document.id, snippet: document.title }]);

      const terms = extractTerms(document.title, document.chunks);
      documentTerms.set(document.id, terms);
      for (const term of terms) {
        const conceptNodeId = `concept:${term}`;
        addNode({ id: conceptNodeId, label: term, type: 'concept' });
        addEdge(documentNodeId, conceptNodeId, 'mentions', [{ documentId: document.id, chunkId: document.chunks[0]?.id, snippet: term }]);
        if (!conceptDocuments.has(term)) conceptDocuments.set(term, new Set());
        conceptDocuments.get(term)!.add(document.id);
      }
    }

    // Prefer actual GBrain page links when they exist. Discovery is a GBrain
    // subprocess call per document, so it runs with bounded concurrency under
    // a hard time budget instead of serially over 120 docs (which took minutes).
    const docNodeBySlug = new Map<string, string>(documents.map((document) => [`docs/${document.id}`, `doc:${document.id}`]));
    let gbrainLinks = 0;
    let gbrainLinkErrors = 0;
    let gbrainLinksFiltered = 0;
    let gbrainLinksSkipped = 0;
    const linkBudgetMs = Math.max(1000, Number(process.env.KG_LINK_BUDGET_MS || 8000));
    const linkConcurrency = Math.max(1, Number(process.env.KG_LINK_CONCURRENCY || 4));
    const linkMaxDocs = Math.max(1, Number(process.env.KG_LINK_MAX_DOCS || 40));
    const linkQueue = documents.slice(0, linkMaxDocs);
    const linkStartedAt = Date.now();
    const linkWorker = async () => {
      while (linkQueue.length) {
        if (Date.now() - linkStartedAt > linkBudgetMs) {
          gbrainLinksSkipped += linkQueue.length;
          linkQueue.length = 0;
          return;
        }
        const document = linkQueue.shift();
        if (!document) return;
        try {
          const sourceRef = `gbrain://source/${sourceKeyForKnowledgeBase(document.kbId)}`;
          const payload: any = await this.gbrain.getLinks(sourceRef, `docs/${document.id}`);
          const links = Array.isArray(payload?.links)
            ? payload.links
            : Array.isArray(payload?.results)
              ? payload.results
              : Array.isArray(payload)
                ? payload
                : [];
          for (const link of links) {
            const targetSlug = String(link?.to || link?.to_slug || link?.target || link?.target_slug || '').trim();
            if (!targetSlug) continue;
            const source = `doc:${document.id}`;
            const target = docNodeBySlug.get(targetSlug);
            // The upstream projection may outlive a removed/unpublished page.
            // Resolve both ends against this request's published ACL-filtered set;
            // do not expose unknown titles or unversioned link-context snippets.
            if (!target) { gbrainLinksFiltered++; continue; }
            addEdge(source, target, 'related_to', [{
              documentId: document.id,
              snippet: 'GBrain 文档关联（发现线索，不作为原文证据）',
              provenance: 'gbrain_discovery',
            }]);
            gbrainLinks += 1;
          }
        } catch {
          gbrainLinkErrors += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(linkConcurrency, linkQueue.length) }, () => linkWorker()));

    // Extract explicit cross-document policy citations
    const titleToDoc = new Map<string, any>(documents.map((d: any) => [cleanLabel(d.title), d]));
    for (const document of documents) {
      const chunksContent = document.chunks.map((c) => c.content).join(' ');
      for (const [targetTitle, targetDoc] of titleToDoc) {
        if (targetDoc.id === document.id || targetTitle.length < 4) continue;
        if (chunksContent.includes(`《${targetTitle}》`)) {
          addEdge(`doc:${document.id}`, `doc:${targetDoc.id}`, 'references', [{
            documentId: document.id,
            snippet: `引用制度文件：《${targetTitle}》`,
            provenance: 'policy_cross_reference',
          }]);
        }
      }
    }

    const related = new Map<string, Set<string>>();
    for (const [term, docIds] of conceptDocuments) {
      const ids = [...docIds];
      // The shared topic node already links common terms; avoid quadratic cliques.
      if (ids.length > 20) continue;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const key = [ids[i], ids[j]].sort().join('|');
        if (!related.has(key)) related.set(key, new Set());
        related.get(key)!.add(term);
      }
    }
    for (const [key, terms] of related) {
      if (terms.size < 2) continue;
      const [left, right] = key.split('|');
      addEdge(`doc:${left}`, `doc:${right}`, 'related_to', [...terms].slice(0, 5).map((term) => ({ snippet: `共同主题：${term}` })));
    }

    // Wire format: the UI only renders id/label/type/kbId/documentId and
    // source/target/type/weight. evidence/metadata/edge-id (derivable as
    // `source|type|target`) are build-internal and stripped to keep the
    // multi-MB corpus graph payload small.
    const payload = {
      nodes: [...nodes.values()].map((node) => ({
        id: node.id,
        label: node.label,
        type: node.type,
        kbId: node.kbId,
        documentId: node.documentId,
      })),
      edges: [...edges.values()].map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        weight: edge.weight,
        ...(projection?.root ? { evidence: edge.evidence } : {}),
      })),
      stats: {
        knowledgeBases: new Set(documents.map((item) => item.kbId)).size,
        documents: documents.length,
        concepts: [...nodes.values()].filter((node) => node.type === 'concept').length,
        relations: edges.size,
        gbrainLinks,
        gbrainLinkErrors,
        gbrainLinksFiltered,
        gbrainLinksSkipped,
        graphMode: 'gbrain-links-plus-discovery',
        buildMs: Date.now() - buildStartedAt,
      },
      projectionVersion: this.documentProjectionVersion(documents),
      pagination: { page: projection?.page || 0, limit, total: projection?.total ?? documents.length, hasMore: projection ? (projection.page + 1) * limit < projection.total : false },
      scope: { userId, visibleKnowledgeBases: visibleKbIds.length, onlyPublished: true },
    };
    await assertAuthorizationSnapshot(userId, authority);
    const stillReadable = await this.documentAclService.filterReadableDocuments(userId, documents.map(doc => doc.id), { visibleKbIds });
    if (stillReadable.size !== documents.length) throw new ForbiddenException('Document access changed; refresh the graph.');
    if (cacheTtlMs > 0) {
      // Insert last so the freshly built snapshot is the most recent, then evict.
      this.graphCache.set(cacheKey, {
        expiresAt: Date.now() + cacheTtlMs,
        storedAt: Date.now(),
        fingerprint: this.documentProjectionVersion(documents),
        payload,
      });
      this.evictOldestGraphSnapshot();
    }
    return payload;
  }

  @Post('reindex')
  async reindexGraph(@Req() req: any, @Body('kbId') targetKbId?: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const visibleKbIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    // Reading a library does not authorize rebuilding its persistent projection.
    const candidates = targetKbId ? [targetKbId].filter(id => visibleKbIds.includes(id)) : visibleKbIds;
    const kbsToIndex: string[] = [];
    for (const kbId of candidates) {
      if (await this.permissionService.canManageKnowledgeBase(userId, kbId)) kbsToIndex.push(kbId);
    }
    if (!kbsToIndex.length) {
      throw new ForbiddenException('No manageable knowledge bases to reindex');
    }

    const rows = await this.prisma.document.findMany({
      where: { kbId: { in: kbsToIndex }, status: 'published' },
      select: {
        id: true,
        aclMode: true,
        title: true,
        kbId: true,
        chunks: { orderBy: { ord: 'asc' }, take: 200, select: { id: true, content: true } },
      },
    });

    const readable = await this.documentAclService.filterReadableDocuments(userId, rows.map(doc => doc.id), { docs: rows, visibleKbIds });
    const documents = rows.filter(doc => readable.has(doc.id));
    let totalEntities = 0;
    let totalRelations = 0;
    if (this.graphRagService) {
      let llmConfig: { baseUrl: string; apiKey: string; modelName: string } | null = null;
      if (this.modelConfigService) {
        try {
          const cfg = await this.modelConfigService.getDefault('llm');
          if (cfg) {
            llmConfig = {
              baseUrl: (cfg.provider.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
              apiKey: cfg.provider.apiKey || process.env.DEEPSEEK_API_KEY || '',
              modelName: cfg.modelName || process.env.LLM_MODEL || "",
            };
          }
        } catch {}
      }

      for (const doc of documents) {
        const elements = await this.graphRagService.extractGraphElementsHybrid(
          doc.title,
          doc.id,
          doc.chunks,
          1,
          llmConfig,
          { kbId: doc.kbId },
        );
        const res = await this.graphRagService.persistGraphElements(doc.kbId, elements);
        totalEntities += res.entityCount;
        totalRelations += res.relationCount;
      }
      for (const kbId of kbsToIndex) {
        await this.graphRagService.buildCommunitiesForKb(kbId);
      }
    }

    return {
      status: 'completed',
      indexedDocuments: documents.length,
      totalEntities,
      totalRelations,
      kbs: kbsToIndex,
    };
  }
}
