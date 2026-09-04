import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionService } from '../permission/permission.service';
import { ModelConfigService } from '../model-config.service';
import { createHash } from 'node:crypto';
import { BrainRepoAdapter, BrainEvidence } from '@llmwiki/gbrain-adapter';
import { readCanonicalDocument } from './canonical-document';
import { sourceKeyForKnowledgeBase } from './brain-source';

export interface ScopeResolutionResult {
  scopeId: string;
  fingerprint: string;
  sourceKeys: string[];
  strategy: 'eager' | 'lazy';
  status: 'active' | 'dirty' | 'compiling' | 'archived';
  aclEpoch: number;
  knowledgeEpoch: number;
}

@Injectable()
export class BrainScopeService {
  private readonly logger = new Logger(BrainScopeService.name);
  private prisma = new PrismaClient();
  private gbrain = new BrainRepoAdapter(
    process.env.BRAIN_REPO_BASE_PATH || '/tmp/llmwiki/brain_repos',
  );
  private readonly uploadRoot = process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads';

  constructor(
    private readonly permissionService: PermissionService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
  ) {}

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
    await db.brainScopeMember.upsert({
      where: { scopeId_userId: { scopeId: scope.id, userId } },
      create: { scopeId: scope.id, userId },
      update: {},
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
    await db.brainScopeMember.deleteMany({
      where: { userId },
    });
    this.logger.log(`Invalidated BrainScope membership for user ${userId}.`);
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

    // 查找当前 Scope 涉及的所有文档
    const sourceRecords = await db.brainSource.findMany({
      where: { sourceKey: { in: sourceKeys } },
      include: {
        documents: {
          include: {
            document: {
              include: {
                kb: { select: { id: true, name: true, type: true } },
                chunks: { orderBy: { ord: 'asc' }, take: 10, select: { id: true, content: true, ord: true } },
              },
            },
          },
        },
      },
    });

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

    await db.brainScope.update({ where: { id: scope.id }, data: { status: 'compiling' } });

    const inputFingerprint = createHash('sha256')
      .update(docs.map((d) => `${d.id}:${d.version}`).sort().join(';'))
      .digest('hex')
      .slice(0, 16);

    const derivedEvidence = docs.map((doc) => ({
      docId: doc.id,
      title: doc.title,
      kbName: doc.kb?.name,
      snippet: doc.chunks[0]?.content?.slice(0, 200) || '',
      chunkOrd: doc.chunks[0]?.ord || 0,
    }));

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
      for (const sourceKey of sourceKeys) {
        try {
          const result = await this.gbrain.synthesize(`gbrain://source/${sourceKey}`, synthesisQuestion);
          const answer = String(result.answer || '').trim();
          if (!answer) synthesisFallbacks += 1;
          synthesisBySource.push({
            sourceKey,
            answer,
            status: typeof result.synthesis_status === 'string' ? result.synthesis_status : undefined,
            gaps: result.gaps,
            warnings: result.warnings,
            cost: result.cost,
          });
        } catch (error: any) {
          // A deterministic inventory remains available when the model gateway
          // is unavailable. The status records that it is not a synthesis.
          synthesisFallbacks += 1;
          synthesisBySource.push({ sourceKey, answer: '', status: 'unavailable', warnings: [String(error?.message || error)] });
        }
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

    const summaryContent = summaryLines.join('\n');

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

    await this.gbrain.ingest(`gbrain://source/${scopeSourceId}`, scopeEvidences);

    await db.brainScope.update({
      where: { id: scope.id },
      data: {
        lastCompileAt: new Date(),
        status: 'active',
      },
    });

    this.logger.log(`Successfully compiled and published derived pages for Scope ${scope.fingerprint}.`);
    return {
      derivedPagesCount: 1,
      status: synthesisFallbacks ? 'partial' : 'completed',
      synthesizedSources: synthesisBySource.filter((item) => Boolean(item.answer)).length,
      synthesisFallbacks,
    };
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
