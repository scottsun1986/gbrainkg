import { compiledTruthDiff, compiledTimeline, truthContentHash, withSynthesisTimeout } from './compiled-truth';
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { PermissionService } from '../permission/permission.service';
import { ModelConfigService } from '../model-config.service';
import { createHash } from 'node:crypto';
import { BrainRepoAdapter, BrainEvidence } from '@llmwiki/gbrain-adapter';
import { readCanonicalDocument } from './canonical-document';
import { sourceKeyForKnowledgeBase } from './brain-source';
import { getSharedBrainRepoAdapter } from "./brain-adapter.provider";
import { uploadRoot as resolveUploadRoot } from "../storage/upload-paths";

export interface ScopeResolutionResult {
  scopeId: string;
  fingerprint: string;
  sourceKeys: string[];
  strategy: 'eager' | 'lazy';
  status: 'active' | 'dirty' | 'compiling' | 'archived';
  aclEpoch: number;
  knowledgeEpoch: number;
}

/**
 * Compile depth for scope-derived intelligence. The first release summarised a
 * scope from each document's first 10 chunks and at most 3 sources, which is a
 * shallow slice for a "compiled brain" and left most of a large manual out of
 * the macro layer. Both dimensions are now configurable with sane, bounded
 * defaults.
 */
export function resolveScopeCompileDepth(
  env: NodeJS.ProcessEnv = process.env,
): { docChunkDepth: number; synthesizeSourceLimit: number } {
  const depth = Number(env.BRAIN_SCOPE_DOC_CHUNKS ?? 40);
  const sources = Number(env.BRAIN_SCOPE_SYNTHESIZE_SOURCES ?? 5);
  return {
    docChunkDepth:
      Number.isFinite(depth) && depth >= 1 ? Math.min(Math.floor(depth), 200) : 40,
    synthesizeSourceLimit:
      Number.isFinite(sources) && sources >= 1 ? Math.min(Math.floor(sources), 50) : 5,
  };
}

@Injectable()
export class BrainScopeService {
  private readonly logger = new Logger(BrainScopeService.name);
  private prisma = getPrismaClient();
  private gbrain: BrainRepoAdapter;
  private readonly uploadRoot = resolveUploadRoot();

  constructor(
    private readonly permissionService: PermissionService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() @Inject('BRAIN_REPO_ADAPTER') gbrainAdapter?: BrainRepoAdapter,
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
  }

  /**
   * 计算并解析当前用户的权限 Scope，支持同权限用户集合自动复用
   */
  async resolveUserScope(userId: string): Promise<ScopeResolutionResult> {
    const db: any = this.prisma;
    const visibleKbIds = await this.permissionService.getVisibleKnowledgeBases(userId);

    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: visibleKbIds }, status: 'active' },
      select: { id: true, type: true, updatedAt: true },
    });

    const sourceKeysSet = new Set<string>();
    for (const kb of kbs) {
      sourceKeysSet.add(sourceKeyForKnowledgeBase(kb.id));
    }

    const sortedSourceKeys = Array.from(sourceKeysSet).sort();

    // 计算确定性指纹：SHA256(sortedSources)
    const fingerprint = createHash('sha256')
      .update(sortedSourceKeys.join(','))
      .digest('hex')
      .slice(0, 16);

    // 判断策略：若权限范围包含多个稳定知识库，采用 eager，否则 lazy
    const strategy = sortedSourceKeys.length >= 2 ? 'eager' : 'lazy';

    // 查找或创建 BrainScope
    const scope = await db.brainScope.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        name: `Scope ${fingerprint}`,
        sourceKeys: sortedSourceKeys,
        strategy,
        status: 'active',
        lastAccessAt: new Date(),
      },
      update: {
        sourceKeys: sortedSourceKeys,
        lastAccessAt: new Date(),
      },
    });

    // 绑定用户与 Scope
    // Empty-update ORM upserts can race on the composite key during first access.
    await db.brainScopeMember.createMany({
      data: [{ scopeId: scope.id, userId }],
      skipDuplicates: true,
    });

    // 清理该用户在其他旧 Scope 中的成员关系
    await db.brainScopeMember.deleteMany({
      where: {
        userId,
        scopeId: { not: scope.id },
      },
    });

    return {
      scopeId: scope.id,
      fingerprint: scope.fingerprint,
      sourceKeys: sortedSourceKeys,
      strategy: scope.strategy as 'eager' | 'lazy',
      status: scope.status as 'active' | 'dirty' | 'compiling' | 'archived',
      aclEpoch: scope.aclEpoch,
      knowledgeEpoch: scope.knowledgeEpoch,
    };
  }

  /**
   * 立即失效用户绑定的 Scope 缓存（用于权限撤销时 0 延迟生效）
   */
  async invalidateUserScope(userId: string): Promise<void> {
    const db: any = this.prisma;
    // 先取用户所在 Scope 再删除成员关系：语义缓存键嵌入了 aclEpoch，
    // 权限变更后必须 bump 这些 Scope 的 epoch，旧 ACL 下缓存的答案才会失效。
    const memberships = await db.brainScopeMember.findMany({
      where: { userId },
      select: { scopeId: true },
    });
    await db.brainScopeMember.deleteMany({
      where: { userId },
    });
    for (const { scopeId } of memberships) {
      await db.brainScope.updateMany({
        where: { id: scopeId },
        data: { aclEpoch: { increment: 1 }, status: 'dirty' },
      }).catch(() => undefined);
    }
    this.logger.log(
      `Invalidated BrainScope membership for user ${userId} (${memberships.length} scope epoch(s) bumped).`,
    );
  }

  /**
   * 提升 Scope 的 ACL Epoch 或 Knowledge Epoch，使派生缓存失效
   */
  async bumpScopeEpoch(scopeId: string, type: 'acl' | 'knowledge'): Promise<void> {
    const db: any = this.prisma;
    const updateData = type === 'acl' ? { aclEpoch: { increment: 1 } } : { knowledgeEpoch: { increment: 1 } };
    await db.brainScope.update({
      where: { id: scopeId },
      data: {
        ...updateData,
        status: 'dirty',
      },
    });
  }

  /**
   * 当知识库发生权限或文档变更时，失效所有包含该知识库的 Scope
   */
  async invalidateKbScope(kbId: string, type: 'acl' | 'knowledge' = 'acl'): Promise<void> {
    const db: any = this.prisma;
    const sourceKey = sourceKeyForKnowledgeBase(kbId);
    try {
      const scopes = await db.brainScope.findMany({
        where: { status: { not: 'archived' } },
        select: { id: true, sourceKeys: true },
      });
      const targetScopes = scopes.filter((s: any) => {
        const keys = Array.isArray(s.sourceKeys) ? s.sourceKeys : [];
        return keys.includes(sourceKey);
      });
      for (const s of targetScopes) {
        await this.bumpScopeEpoch(s.id, type);
      }
      this.logger.log(`Invalidated ${targetScopes.length} BrainScope(s) for KB ${kbId} (bumped ${type}Epoch).`);
    } catch (err) {
      this.logger.warn(`Failed to invalidate BrainScopes for KB ${kbId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 编译并派生当前 Scope 内的宏观总结、概念与事实卡片（带严密来源追踪）
   */
  async compileScopeDerived(scopeId: string): Promise<{
    derivedPagesCount: number;
    status: string;
    synthesizedSources: number;
    synthesisFallbacks: number;
  }> {
    const db: any = this.prisma;
    const scope = await db.brainScope.findUnique({
      where: { id: scopeId },
    });
    if (!scope) throw new Error(`Scope ${scopeId} not found`);

    // Reset stale 'compiling' scopes left behind by crashed workers or exhausted retries.
    await this.sweepStaleCompilingScopes();

    // Debounce / throttle: if compiled within the last 5 minutes and not dirty, skip to prevent synthesis storms
    if (scope.lastCompileAt && Date.now() - new Date(scope.lastCompileAt).getTime() < 5 * 60 * 1000 && scope.status === 'active') {
      this.logger.log(`Scope ${scope.fingerprint} was compiled recently (${scope.lastCompileAt.toISOString()}); skipping throttled synthesis.`);
      return { derivedPagesCount: 0, status: 'skipped_throttled', synthesizedSources: 0, synthesisFallbacks: 0 };
    }

    if (this.modelConfigService) {
      await this.modelConfigService.applyRuntimeConfig();
    }

    const sourceKeys: string[] = Array.isArray(scope.sourceKeys) ? scope.sourceKeys : [];
    this.logger.log(`Compiling derived intelligence for Scope ${scope.fingerprint} (sources: ${sourceKeys.join(',')})...`);
    const { docChunkDepth, synthesizeSourceLimit } = resolveScopeCompileDepth();
    const fullCoverage = process.env.BRAIN_SCOPE_FULL_COVERAGE !== '0';

    const previous = await db.brainDerivedPage.findUnique({ where: { scopeId_slug: { scopeId: scope.id, slug: 'derived/scope-summary' } } });

    // 查找当前 Scope 涉及的所有文档
    const sourceRecords = await db.brainSource.findMany({
      where: { sourceKey: { in: sourceKeys } }, select: { id: true, sourceKey: true, lastSyncAt: true },
    });
    for (const source of sourceRecords) {
      source.documents = [];
      let after: string | undefined;
      for (;;) {
        const rows = await db.brainSourceDocument.findMany({
          where: { sourceId: source.id, ...(after ? { documentId: { gt: after } } : {}) },
          orderBy: { documentId: 'asc' }, take: 200,
          include: { document: { include: {
            kb: { select: { id: true, name: true, type: true } },
            chunks: { orderBy: [{ ord: 'asc' }, { id: 'asc' }], take: fullCoverage ? 4 : docChunkDepth, select: { id: true, content: true, ord: true } },
          } } },
        });
        if (!rows.length) break;
        source.documents.push(...rows);
        after = rows[rows.length - 1].documentId;
        if (rows.length < 200) break;
      }
    }

    const allDocsMap = new Map<string, any>();
    for (const s of sourceRecords) {
      for (const sd of s.documents) {
        if (sd.document && sd.document.status === 'published') {
          allDocsMap.set(sd.document.id, sd.document);
        }
      }
    }

    const docs = Array.from(allDocsMap.values());
    if (docs.length === 0) {
      return { derivedPagesCount: 0, status: 'empty', synthesizedSources: 0, synthesisFallbacks: 0 };
    }

    await db.brainScope.update({ where: { id: scope.id }, data: { status: 'compiling', compileStartedAt: new Date() } });

    const inputFingerprint = createHash('sha256')
      .update(docs.map((d) => `${d.id}:${d.version}:${d.activeVersionId}:${d.contentHash}`).sort().join(';'))
      .digest('hex')
      .slice(0, 16);

    const previousEvidence = new Map<string, any>((Array.isArray(previous?.derivedFrom) ? previous.derivedFrom : []).map((item: any) => [item.docId, item]));
    const derivedEvidence: any[] = [];
    for (const doc of docs) {
      const old = previousEvidence.get(doc.id);
      let chunkCount = (doc.chunks || []).length;
      let chunkContentHash = truthContentHash((doc.chunks || []).map((c: any) => `${c.id}:${c.ord}:${c.content}`).join('\n'));
      if (fullCoverage) {
        if (old?.coverage === 'complete' && old.version === doc.version && old.documentVersionId === (doc.activeVersionId || null) && old.sourceHash === (doc.contentHash || null)) {
          chunkCount = old.chunkCount;
          chunkContentHash = old.chunkContentHash;
        } else {
          const hash = createHash('sha256');
          chunkCount = 0;
          let after: { ord: number; id: string } | undefined;
          for (;;) {
            const chunks = await db.chunk.findMany({
              where: { documentId: doc.id, ...(after ? { OR: [{ ord: { gt: after.ord } }, { ord: after.ord, id: { gt: after.id } }] } : {}) },
              orderBy: [{ ord: 'asc' }, { id: 'asc' }], take: 200, select: { id: true, content: true, ord: true },
            });
            if (!chunks.length) break;
            for (const chunk of chunks) {
              if (chunkCount++) hash.update('\n');
              hash.update(`${chunk.id}:${chunk.ord}:${chunk.content}`);
            }
            after = chunks[chunks.length - 1];
            if (chunks.length < 200) break;
          }
          chunkContentHash = hash.digest('hex');
        }
      }
      derivedEvidence.push({
        docId: doc.id, title: doc.title, kbName: doc.kb?.name,
        snippet: (doc.chunks || []).slice(0, 4).map((c: any) => String(c?.content || '').slice(0, 200).trim()).filter(Boolean).join('\n').slice(0, 1000),
        chunkOrd: doc.chunks[0]?.ord || 0, chunkCount, version: doc.version,
        documentVersionId: doc.activeVersionId || null, sourceHash: doc.contentHash || null,
        chunkContentHash, coverage: fullCoverage ? 'complete' : 'bounded',
      });
    }

    // 1. Run GBrain's official cross-page synthesis separately inside every
    // stable Source. We never issue an unscoped global call: combining source
    // outputs happens only for this already-authorized scope and preserves the
    // source-level provenance needed by the final DB permission guard.
    const synthesisQuestion = [
      '请基于当前知识源的全部已发布内容生成一份可检索的知识概览。',
      '覆盖制度、流程、职责、时间要求、例外和相互引用；不得编造。',
      '请明确证据不足或相互冲突之处，并保留可追溯来源。',
    ].join('');
    const synthesisBySource: Array<{ sourceKey: string; answer: string; status?: string; gaps?: unknown; warnings?: unknown; cost?: unknown }> = [];
    let synthesisFallbacks = 0;
    if (process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED !== '0') {
      const targetSources = fullCoverage ? sourceKeys : sourceKeys.slice(0, synthesizeSourceLimit);
      const model = await this.modelConfigService?.getDefault('llm');
      const modelFingerprint = model ? truthContentHash(JSON.stringify([model.id, model.modelName, model.contextLen, model.provider.id, model.provider.baseUrl, model.provider.defaultParams, process.env.GBRAIN_CHAT_MODEL])) : null;
      const cached = new Map<string, any>((Array.isArray(previous?.derivedFrom) ? previous.derivedFrom : [])
        .filter((item: any) => item.sourceSynthesis).map((item: any) => [item.sourceSynthesis.sourceKey, item.sourceSynthesis]));
      for (let start = 0; start < targetSources.length; start += 3) {
        const batch = await Promise.all(targetSources.slice(start, start + 3).map(async (sourceKey) => {
          const record = sourceRecords.find((source: any) => source.sourceKey === sourceKey);
          const sourceDocIds = new Set((record?.documents || []).map((item: any) => item.document?.id));
          const evidence = derivedEvidence.filter(item => sourceDocIds.has(item.docId));
          const fingerprint = truthContentHash(JSON.stringify([synthesisQuestion, modelFingerprint, fullCoverage, record?.lastSyncAt,
            evidence.map(item => [item.docId, item.version, item.documentVersionId, item.sourceHash, item.chunkContentHash]).sort()]));
          const old = cached.get(sourceKey);
          let output: any;
          if (modelFingerprint && old?.fingerprint === fingerprint && previous?.aclEpoch === scope.aclEpoch && old.answer) {
            output = old;
          } else {
            try {
              const result = await withSynthesisTimeout(this.gbrain.synthesize(`gbrain://source/${sourceKey}`, synthesisQuestion));
              const answer = String(result.answer || '').trim();
              if (!answer) synthesisFallbacks += 1;
              output = { sourceKey, answer, fingerprint,
                status: typeof result.synthesis_status === 'string' ? result.synthesis_status : undefined,
                gaps: result.gaps, warnings: result.warnings, cost: result.cost };
            } catch (error: any) {
              synthesisFallbacks += 1;
              output = { sourceKey, answer: '', fingerprint, status: 'unavailable', warnings: [String(error?.message || error)] };
            }
          }
          if (evidence[0]) evidence[0].sourceSynthesis = JSON.parse(JSON.stringify(output));
          return output;
        }));
        synthesisBySource.push(...batch);
      }
    }


    // 2. Publish a provenance-first Scope summary. This is not treated as a
    // source of truth unless its exact source set and epochs still match.
    const summaryTitle = `Scope 知识资产综合全景 (${scope.fingerprint})`;
    const summaryLines = [
      `# ${summaryTitle}`,
      '',
      `> 本文档由 GBrain 派生智能层根据当前权限 Scope [${scope.fingerprint}] 自动综合生成，包含 ${docs.length} 篇可见文档与制度资产。`,
      '',
      '## 一、 知识库与资产分布',
      ...Array.from(new Set(docs.map((d) => d.kb?.name))).map((name) => `- **${name}**`),
      '',
      '## 二、 核心制度与规范清单',
      ...docs.map((d) => `- [${d.title}](llmwiki://documents/${d.id}) (${d.kb?.name || '默认库'})`),
      '',
      '## 三、 溯源依据 (Derived From)',
      ...derivedEvidence.map((e) => `- 依据：\`${e.title}\` (ID: ${e.docId})`),
      '',
      '## 四、GBrain 跨页综合',
      ...(synthesisBySource.length
        ? synthesisBySource.flatMap((item) => [
          `### Source ${item.sourceKey}`,
          item.answer || '_本次无法生成综合结论，保留上方可追溯文档清单。_',
          item.status ? `- synthesis_status: ${item.status}` : '',
          item.gaps ? `- gaps: ${JSON.stringify(item.gaps)}` : '',
          item.warnings ? `- warnings: ${JSON.stringify(item.warnings)}` : '',
        ].filter(Boolean))
        : ['_Scope synthesis 已由配置关闭。_']),
    ];

    summaryLines.push('', '## 五、来源生命周期', compiledTimeline(docs));
    summaryLines.push('', `Coverage: ${fullCoverage ? 'complete source/document inventory' : 'bounded chunk/source budget'}`);

    const summaryContent = summaryLines.join('\n');
    const truthDiff = compiledTruthDiff(previous?.content ?? null, summaryContent,
      Array.isArray(previous?.derivedFrom) ? previous.derivedFrom : [], derivedEvidence);
    // Any source replacement or scope invalidation during synthesis makes the
    // output obsolete. Do not overwrite a current page with a stale snapshot.
    const currentDocs = await db.document.findMany({
      where: { id: { in: docs.map(doc => doc.id) }, status: 'published' },
      select: { id: true, version: true, activeVersionId: true, contentHash: true },
    });
    const currentFingerprint = createHash('sha256').update(currentDocs.map((d: any) => `${d.id}:${d.version}:${d.activeVersionId}:${d.contentHash}`).sort().join(';')).digest('hex').slice(0, 16);
    const currentScope = await db.brainScope.findUnique({ where: { id: scope.id } });
    if (currentFingerprint !== inputFingerprint || currentScope?.aclEpoch !== scope.aclEpoch || currentScope?.knowledgeEpoch !== scope.knowledgeEpoch) {
      await db.brainScope.update({ where: { id: scope.id }, data: { status: 'dirty' } });
      throw new Error('Scope compile inputs changed during synthesis');
    }


    await db.brainDerivedPage.upsert({
      where: { scopeId_slug: { scopeId: scope.id, slug: 'derived/scope-summary' } },
      create: {
        scopeId: scope.id,
        slug: 'derived/scope-summary',
        title: summaryTitle,
        kind: 'summary',
        content: summaryContent,
        derivedFrom: derivedEvidence,
        sourceKeys,
        inputFingerprint,
        aclEpoch: scope.aclEpoch,
        knowledgeEpoch: scope.knowledgeEpoch,
        modelVersion: 'gbrain-synthesize-v1',
      },
      update: {
        title: summaryTitle,
        content: summaryContent,
        derivedFrom: derivedEvidence,
        sourceKeys,
        inputFingerprint,
        aclEpoch: scope.aclEpoch,
        knowledgeEpoch: scope.knowledgeEpoch,
        updatedAt: new Date(),
      },
    });

    // Reuse the persisted BGE-M3 chunk vectors. Similarity only creates
    // navigation associations, never assertions of equivalence or truth.
    let semanticRelations: any[] = [];
    if (typeof db.$queryRaw === 'function') {
      const docIds = docs.map(doc => doc.id);
      semanticRelations = await db.$queryRaw`
        WITH centroids AS (
          SELECT c."documentId", avg(c.embedding) AS embedding, count(*)::int AS "embeddedChunks"
          FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId"
          WHERE c."documentId" = ANY(${docIds}::uuid[]) AND d.status='published' AND c.embedding IS NOT NULL
          GROUP BY c."documentId"
        )
        SELECT a."documentId"::text AS "sourceDocumentId", b."documentId"::text AS "targetDocumentId",
          1-(a.embedding <=> b.embedding) AS similarity,
          a."embeddedChunks" AS "sourceEmbeddedChunks", b."embeddedChunks" AS "targetEmbeddedChunks"
        FROM centroids a CROSS JOIN LATERAL (
          SELECT * FROM centroids other WHERE other."documentId"<>a."documentId"
            AND 1-(a.embedding <=> other.embedding)>=0.65
          ORDER BY a.embedding <=> other.embedding, other."documentId" LIMIT 5
        ) b ORDER BY a."documentId", similarity DESC, b."documentId"
      `;
    }

    const extraPages = [
      { slug: 'derived/truth-diff', title: 'Compiled output and source delta', kind: 'gap', content: JSON.stringify(truthDiff, null, 2) },
      { slug: 'derived/timeline', title: 'Source lifecycle timeline', kind: 'fact', content: compiledTimeline(docs) },
      { slug: 'derived/topic-relations', title: 'Semantic source associations', kind: 'graph', content: JSON.stringify({ contract: 'source-topic-relations-v1', meaning: 'vector similarity is navigation, not proof of a factual relation', documents: docs.length, relations: semanticRelations }, null, 2) },
    ];
    for (const page of extraPages) {
      const pageEvidence = page.slug === 'derived/truth-diff' ? [...(Array.isArray(previous?.derivedFrom) ? previous.derivedFrom : []), ...derivedEvidence] : derivedEvidence;
      const data = { ...page, derivedFrom: pageEvidence, sourceKeys, inputFingerprint, aclEpoch: scope.aclEpoch, knowledgeEpoch: scope.knowledgeEpoch, modelVersion: 'compiled-source-v2' };
      await db.brainDerivedPage.upsert({ where: { scopeId_slug: { scopeId: scope.id, slug: page.slug } }, create: { scopeId: scope.id, ...data }, update: data });
    }

    // 3. 写入 Scope 专属派生源仓库并同步 (GBrain source ID 限制 <= 32 字符)
    const scopeSourceId = `llmwiki-d-${scope.fingerprint}`;
    await this.gbrain.initializeSource(scopeSourceId);
    const scopeEvidences: BrainEvidence[] = [
      {
        text: summaryContent,
        sourceFile: 'scope-summary.md',
        topic: summaryTitle,
        slug: 'derived/scope-summary',
        kbId: 'derived',
        kbName: 'Scope Derived Intelligence',
        kbType: 'derived',
      },
    ];
    scopeEvidences.push(...extraPages.filter(page => page.slug !== 'derived/truth-diff').map(page => ({ text: page.content, sourceFile: `${page.slug.split('/').pop()}.md`, topic: page.title, slug: page.slug, kbId: 'derived', kbName: 'Scope Derived Intelligence', kbType: 'derived' })));

    await this.gbrain.ingest(`gbrain://source/${scopeSourceId}`, scopeEvidences);

    const published = await db.brainScope.updateMany({
      where: { id: scope.id, aclEpoch: scope.aclEpoch, knowledgeEpoch: scope.knowledgeEpoch },
      data: { lastCompileAt: new Date(), status: 'active', compileStartedAt: null },
    });
    if (published.count !== 1) throw new Error('Scope epochs changed before publication');

    this.logger.log(`Successfully compiled and published derived pages for Scope ${scope.fingerprint}.`);
    return {
      derivedPagesCount: 1 + extraPages.length,
      status: synthesisFallbacks ? 'partial' : 'completed',
      synthesizedSources: synthesisBySource.filter((item) => Boolean(item.answer)).length,
      synthesisFallbacks,
    };
  }

  /**
   * Reset 'compiling' scopes that have been stuck for more than 10 minutes
   * (e.g., due to a worker crash or exhausted retries) back to 'dirty' so they
   * can be re-queued for compilation.
   */
  async sweepStaleCompilingScopes(): Promise<void> {
    const db: any = this.prisma;
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
    try {
      const result = await db.brainScope.updateMany({
        where: {
          status: 'compiling',
          compileStartedAt: { lt: staleThreshold },
        },
        data: { status: 'dirty' },
      });
      if (result.count > 0) {
        this.logger.warn(`Reset ${result.count} stale 'compiling' scope(s) to 'dirty'.`);
      }
    } catch (err) {
      this.logger.warn(`Failed to sweep stale compiling scopes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 获取 Scope 的所有派生页面
   */
  async getScopeDerivedPages(scopeId: string) {
    const db: any = this.prisma;
    return db.brainDerivedPage.findMany({
      where: { scopeId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
