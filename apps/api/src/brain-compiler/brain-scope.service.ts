import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PermissionService } from '../permission/permission.service';
import { createHash } from 'node:crypto';
import { BrainRepoAdapter, BrainEvidence } from '@llmwiki/gbrain-adapter';
import { readCanonicalDocument } from './canonical-document';

export interface ScopeResolutionResult {
  scopeId: string;
  fingerprint: string;
  sourceKeys: string[];
  strategy: 'eager' | 'lazy';
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

  constructor(private readonly permissionService: PermissionService) {}

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

    const activeUsers = await this.prisma.user.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    const allAudienceKey = activeUsers.map((item) => item.id).sort().join(',');

    const sourceKeysSet = new Set<string>();
    for (const kb of kbs) {
      const audience = (await this.permissionService.getUsersVisibleToKnowledgeBase(kb.id)).sort();
      const scopeKey = audience.join(',') || `kb:${kb.id}`;
      const isShared = Boolean(allAudienceKey) && scopeKey === allAudienceKey;
      const sourceKey = isShared
        ? 'llmwiki-shared'
        : `llmwiki-scope-${createHash('sha256').update(scopeKey).digest('hex').slice(0, 16)}`;
      sourceKeysSet.add(sourceKey);
    }

    const sortedSourceKeys = Array.from(sourceKeysSet).sort();
    if (sortedSourceKeys.length === 0) {
      sortedSourceKeys.push('llmwiki-shared');
    }

    // 计算确定性指纹：SHA256(sortedSources)
    const fingerprint = createHash('sha256')
      .update(sortedSourceKeys.join(','))
      .digest('hex')
      .slice(0, 16);

    // 判断策略：若包含共享源或权限范围包含多个用户，采用 eager，否则 lazy
    const strategy = sortedSourceKeys.includes('llmwiki-shared') || sortedSourceKeys.length > 2 ? 'eager' : 'lazy';

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
        status: 'active',
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
  async compileScopeDerived(scopeId: string): Promise<{ derivedPagesCount: number; status: string }> {
    const db: any = this.prisma;
    const scope = await db.brainScope.findUnique({
      where: { id: scopeId },
    });
    if (!scope) throw new Error(`Scope ${scopeId} not found`);

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
      return { derivedPagesCount: 0, status: 'empty' };
    }

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

    // 1. 生成范围宏观知识全景总结 (Summary)
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
        inputFingerprint,
        modelVersion: 'gbrain-derived-v1',
      },
      update: {
        title: summaryTitle,
        content: summaryContent,
        derivedFrom: derivedEvidence,
        inputFingerprint,
        updatedAt: new Date(),
      },
    });

    // 2. 写入 Scope 专属派生源仓库并同步 (GBrain source ID 限制 <= 32 字符)
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
    return { derivedPagesCount: 1, status: 'completed' };
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
