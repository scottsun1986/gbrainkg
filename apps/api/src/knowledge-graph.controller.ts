import { Body, Controller, ForbiddenException, Get, Optional, Post, Query, Req, UseGuards, Inject } from '@nestjs/common';
import { getPrismaClient } from './prisma';
import { AuthService } from './auth/auth.service';
import { PermissionService } from './permission/permission.service';
import { AuthGuard } from './auth/auth.guard';
import { BrainRepoAdapter } from '@llmwiki/gbrain-adapter';
import { sourceKeyForKnowledgeBase } from './brain-compiler/brain-source';
import { GraphRagService } from './graph-rag/graph-rag.service';
import { ModelConfigService } from './model-config.service';
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
    for (const match of content.matchAll(/([\p{L}\p{N}]{2,32}(?:公司|中心|部门|医院|集团|平台|系统|项目|规范|制度|管理|评估|安全|组织|小组))/gu)) addTerm(terms, match[1]);
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/gu)) addTerm(terms, match[1]);
  }
  return [...terms].slice(0, 40);
}

@UseGuards(AuthGuard)
@Controller('api/v1/knowledge-graph')
export class KnowledgeGraphController {
  private readonly prisma = getPrismaClient();
  private readonly gbrain: BrainRepoAdapter;

  constructor(
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
    @Optional() private readonly graphRagService?: GraphRagService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() @Inject('BRAIN_REPO_ADAPTER') gbrainAdapter?: BrainRepoAdapter,
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
  }

  @Get()
  async getGraph(@Req() req: any, @Query('limit') rawLimit?: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const visibleKbIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const limit = Math.min(Math.max(Number(rawLimit || 1000) || 1000, 1), 1000);

    // Persistent heuristic rows do not carry a validated source-version
    // contract. Build discovery from currently published documents instead.

    const documents = await this.prisma.document.findMany({
      where: { kbId: { in: visibleKbIds }, status: 'published' },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        kbId: true,
        updatedAt: true,
        kb: { select: { id: true, name: true, type: true } },
        chunks: { orderBy: { ord: 'asc' }, take: 500, select: { id: true, content: true, metadata: true } },
      },
    });

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

    // Prefer actual GBrain page links when they exist.
    const docNodeBySlug = new Map<string, string>(documents.map((document) => [`docs/${document.id}`, `doc:${document.id}`]));
    let gbrainLinks = 0;
    let gbrainLinkErrors = 0;
    let gbrainLinksFiltered = 0;
    for (const document of documents.slice(0, 120)) {
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

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      stats: {
        knowledgeBases: new Set(documents.map((item) => item.kbId)).size,
        documents: documents.length,
        concepts: [...nodes.values()].filter((node) => node.type === 'concept').length,
        relations: edges.size,
        gbrainLinks,
        gbrainLinkErrors,
        gbrainLinksFiltered,
        graphMode: 'gbrain-links-plus-discovery',
      },
      scope: { userId, visibleKnowledgeBases: visibleKbIds.length, onlyPublished: true },
    };
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

    const documents = await this.prisma.document.findMany({
      where: { kbId: { in: kbsToIndex }, status: 'published' },
      select: {
        id: true,
        title: true,
        kbId: true,
        chunks: { orderBy: { ord: 'asc' }, take: 200, select: { id: true, content: true } },
      },
    });

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
              modelName: cfg.modelName || process.env.LLM_MODEL || 'deepseek-chat',
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
