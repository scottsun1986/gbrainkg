import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PermissionService } from "./permission/permission.service";
import { AuthService } from "./auth/auth.service";
import { BrainCompilerService } from "./brain-compiler/brain-compiler.service";
import { ModelConfigService } from "./model-config.service";
import { AdminGuard } from "./auth/auth.guard";
import {
  decryptModelCredential,
  encryptModelCredential,
  maskModelCredential,
} from "./model-credential";

import { BrainOutboxService } from "./brain-compiler/brain-outbox.service";
import { execSync } from "node:child_process";

@UseGuards(AdminGuard)
@Controller("api/v1/admin")
export class AdminController {
  private readonly prisma = new PrismaClient();
  constructor(
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
    private readonly brainCompilerService: BrainCompilerService,
    private readonly modelConfigService: ModelConfigService,
    private readonly brainOutboxService?: BrainOutboxService,
  ) {}

  private async scheduleAccessReconciliation() {
    await this.brainCompilerService
      .queueAccessReconciliation()
      .catch((error) => {
        // Database ACL remains authoritative even when Redis is temporarily
        // unavailable; the next query also performs lazy source reconciliation.
        console.error(
          `Failed to queue GBrain access reconciliation: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  @Get("data")
  async getAllData(@Req() req: any) {
    const adminId = await this.authService.userIdFromRequest(req);
    const capabilities = await this.permissionService.getCapabilities(adminId);
    const isSystemAdmin = capabilities.includes("*");
    const managedOrgIds =
      await this.permissionService.getManagedOrgIds(adminId);
    const directIndustryScopeCount = await this.prisma.knowledgeBase.count({
      where: {
        type: "industry",
        status: "active",
        OR: [
          { ownerUserId: adminId },
          { admins: { some: { userId: adminId } } },
        ],
      },
    });
    const canReadOrg =
      isSystemAdmin ||
      capabilities.includes("org.read") ||
      capabilities.includes("org.user.read");
    // 行业库管理菜单是角色能力，不是某个具体行业库的管理员关系。
    // 具体行业库的列表仍在 industryScopeKbs 中按资源范围收敛。
    const canReadIndustry =
      isSystemAdmin || capabilities.includes("kb.industry.read");
    const canReadRoles = isSystemAdmin || capabilities.includes("role.read");
    const canReadAudit = isSystemAdmin || capabilities.includes("audit.read");
    // 某个行业库管理员即使没有“行业库管理员”角色，也需要能通过知识库
    // 页面维护自己负责的库；但这不应让他看到行业库管理菜单。
    if (
      !canReadOrg &&
      !canReadIndustry &&
      !canReadRoles &&
      !canReadAudit &&
      directIndustryScopeCount === 0
    )
      throw new ForbiddenException("No administration permission.");

    const users = await this.prisma.user.findMany({
      include: {
        roles: { include: { role: true } },
        orgs: { include: { orgNode: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const allOrgs = await this.prisma.orgNode.findMany({
      where: { status: "active" },
      include: {
        admins: {
          include: {
            user: { select: { id: true, displayName: true, username: true } },
          },
        },
        kbs: {
          where: { status: "active" },
          select: {
            id: true,
            name: true,
            status: true,
            description: true,
            orgNodeId: true,
            admins: {
              include: {
                user: { select: { displayName: true, username: true } },
              },
            },
          },
        },
      },
      orderBy: [{ path: "asc" }, { sort: "asc" }],
    });
    const orgs =
      canReadOrg || canReadIndustry
        ? allOrgs.map((org) => ({
            ...org,
            canManage: isSystemAdmin || managedOrgIds.has(org.id),
            canCreateChild: isSystemAdmin || managedOrgIds.has(org.id),
            // Organization administrators may delegate administration within their
            // own subtree. They never receive access to a parent or sibling node
            // because managedOrgIds is rooted at their assigned organization(s).
            canSetAdmin: isSystemAdmin || managedOrgIds.has(org.id),
          }))
        : [];
    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { status: "active" },
      include: {
        admins: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                email: true,
                status: true,
              },
            },
          },
        },
        _count: { select: { documents: true } },
      },
    });
    const [roles, grants, providers, configs, compileJobs, documents] =
      await Promise.all([
        this.prisma.role.findMany({
          include: { _count: { select: { users: true } } },
          orderBy: { name: "asc" },
        }),
        this.prisma.industryGrant.findMany({
          include: { kb: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.modelProvider.findMany({ orderBy: { name: "asc" } }),
        this.prisma.modelConfig.findMany({
          include: { provider: true },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.compileJob.findMany({
          include: {
            user: { select: { displayName: true, username: true } },
            brainTopic: { select: { topicSlug: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        this.prisma.document.findMany({
          include: { kb: { select: { name: true } } },
          orderBy: { updatedAt: "desc" },
          take: 100,
        }),
      ]);
    const safeProviders = (isSystemAdmin ? providers : []).map(
      ({ apiKeyEncrypted, ...provider }) => ({
        ...provider,
        keyMask: maskModelCredential(apiKeyEncrypted),
        hasApiKey: Boolean(apiKeyEncrypted),
      }),
    );
    const industryScopeKbs = kbs.filter(
      (kb) =>
        kb.type === "industry" &&
        (isSystemAdmin ||
          kb.ownerUserId === adminId ||
          kb.admins.some((admin) => admin.userId === adminId)),
    );
    // 管理后台的管理范围和用户实际阅读范围不同：普通成员不能管理组织库，
    // 但仍应在对话/知识库页面看到自己按组织继承规则可读的组织库。
    const readableKbIds = new Set(
      await this.permissionService.getVisibleKnowledgeBases(adminId),
    );
    const readableKbs = kbs.filter((kb) => readableKbIds.has(kb.id));
    const visibleKbs = isSystemAdmin
      ? kbs
      : [
          ...new Map(
            [...readableKbs, ...industryScopeKbs].map((kb) => [kb.id, kb]),
          ).values(),
        ];
    const directoryUsers =
      isSystemAdmin || canReadIndustry || directIndustryScopeCount > 0
        ? users
        : users.filter(
            (user) =>
              user.id === adminId ||
              user.orgs.some((org) => managedOrgIds.has(org.orgNodeId)),
          );
    const safeUsers = directoryUsers.map(({ passwordHash, ...user }) => {
      const isTargetSystemAdmin = user.roles.some(
        (r) =>
          r.role?.builtin ||
          r.role?.name === "超级管理员" ||
          r.role?.name === "系统管理员",
      );
      const canManage =
        isSystemAdmin ||
        (!isTargetSystemAdmin &&
          user.orgs.length > 0 &&
          user.orgs.some((org) => managedOrgIds.has(org.orgNodeId)));
      return { ...user, canManage };
    });
    const safeGrants = grants.filter(
      (grant) =>
        isSystemAdmin || industryScopeKbs.some((kb) => kb.id === grant.kbId),
    );
    const safeDocuments = documents.filter(
      (doc) => isSystemAdmin || visibleKbs.some((kb) => kb.id === doc.kbId),
    );
    const userById = new Map(users.map((user) => [user.id, user]));
    const safeCompileJobs = isSystemAdmin
      ? compileJobs
      : compileJobs.filter((job) => job.userId === adminId);
    const audit = [
      ...(canReadAudit
        ? safeDocuments.map((doc) => ({
            id: `doc-${doc.id}`,
            when: doc.updatedAt,
            action: `文档「${doc.title}」状态变更为 ${doc.status}`,
            actor: doc.uploadedById
              ? userById.get(doc.uploadedById)?.displayName ||
                userById.get(doc.uploadedById)?.username ||
                doc.uploadedById
              : "系统",
            source: doc.kb.name,
          }))
        : []),
      ...(canReadAudit
        ? safeCompileJobs.map((job) => ({
            id: `job-${job.id}`,
            when: job.createdAt,
            action: `主题「${job.brainTopic.topicSlug}」编译任务 ${job.status}`,
            actor: job.user.displayName || job.user.username,
            source: job.trigger,
          }))
        : []),
      ...(canReadAudit
        ? safeGrants.map((grant) => ({
            id: `grant-${grant.id}`,
            when: grant.createdAt,
            action: `为「${grant.kb.name}」新增 ${grant.subjectType} 授权`,
            actor: grant.grantedById,
            source: grant.kb.name,
          }))
        : []),
    ]
      .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
      .slice(0, 100);
    const writePermissions = await Promise.all(
      visibleKbs.map((kb) =>
        this.permissionService.canManageKnowledgeBase(adminId, kb.id),
      ),
    );
    const managedIndustryWritePermissions = await Promise.all(
      industryScopeKbs.map((kb) =>
        this.permissionService.canManageKnowledgeBase(adminId, kb.id),
      ),
    );
    return {
      user: (() => {
        const current = safeUsers.find((item) => item.id === adminId);
        if (!current) return null;
        return current;
      })(),
      users: safeUsers,
      orgs,
      roles: roles.map(({ _count, ...role }) => ({
        ...role,
        users: _count.users,
        perms: Array.isArray(role.permissions) ? role.permissions : [],
      })),
      kbs: visibleKbs.map(({ _count, ...kb }, index) => ({
        ...kb,
        documentCount: _count.documents,
        canWrite: writePermissions[index],
        canManage:
          isSystemAdmin ||
          (kb.type === "industry" &&
            (kb.ownerUserId === adminId ||
              kb.admins.some((admin) => admin.userId === adminId))),
        canGrant:
          isSystemAdmin ||
          (kb.type === "industry" &&
            kb.admins.some((admin) => admin.userId === adminId)),
        canDelete:
          isSystemAdmin ||
          (kb.type === "personal" && kb.ownerUserId === adminId) ||
          (kb.type === "industry" &&
            (kb.ownerUserId === adminId ||
              kb.admins.some((admin) => admin.userId === adminId))),
      })),
      // 管理后台的行业库页只消费这一组，避免“可阅读但不可管理”的行业库
      // 因阅读权限混入行业库管理列表。
      managedIndustryKbs: industryScopeKbs.map(({ _count, ...kb }, index) => ({
        ...kb,
        documentCount: _count.documents,
        canWrite: managedIndustryWritePermissions[index],
        canManage:
          isSystemAdmin ||
          kb.ownerUserId === adminId ||
          kb.admins.some((admin) => admin.userId === adminId),
        canGrant:
          isSystemAdmin || kb.admins.some((admin) => admin.userId === adminId),
        canDelete:
          isSystemAdmin ||
          kb.ownerUserId === adminId ||
          kb.admins.some((admin) => admin.userId === adminId),
      })),
      grants: safeGrants,
      providers: safeProviders,
      models: isSystemAdmin
        ? configs.map(({ provider, ...config }) => {
            const { apiKeyEncrypted, ...safeProvider } = provider;
            return {
              ...config,
              provider: {
                ...safeProvider,
                keyMask: maskModelCredential(apiKeyEncrypted),
                hasApiKey: Boolean(apiKeyEncrypted),
              },
            };
          })
        : [],
      audit,
      dream: isSystemAdmin || canReadAudit
        ? await this.brainCompilerService.getDreamTelemetry()
        : null,
      systemStatus: isSystemAdmin || canReadAudit
        ? await this.getSystemStatusTelemetryData()
        : null,
      capabilities,
      managedOrgIds: [...managedOrgIds],
    };
  }

  @Get("system/status-telemetry")
  async getSystemStatusTelemetry(@Req() req: any) {
    const adminId = await this.authService.userIdFromRequest(req);
    const capabilities = await this.permissionService.getCapabilities(adminId);
    const isSystemAdmin = capabilities.includes("*");
    if (!isSystemAdmin && !capabilities.includes("audit.read") && !capabilities.includes("system.settings.read")) {
      throw new ForbiddenException("No administration permission to view system telemetry.");
    }
    return this.getSystemStatusTelemetryData();
  }

  private async getSystemStatusTelemetryData() {
    const db: any = this.prisma as any;

    // 1. Ingestion & Document Quality
    const [totalDocs, publishedDocs, failedDocs, parsingDocs, totalChunks, sampleChunks, failedDocList, kbs] = await Promise.all([
      this.prisma.document.count(),
      this.prisma.document.count({ where: { status: "published" } }),
      this.prisma.document.count({ where: { status: "failed" } }),
      this.prisma.document.count({ where: { status: { in: ["parsing", "uploading", "pending"] } } }),
      this.prisma.chunk.count(),
      this.prisma.chunk.findMany({ select: { content: true }, take: 100 }),
      this.prisma.document.findMany({
        where: { status: "failed" },
        include: { kb: true },
        take: 20,
        orderBy: { createdAt: "desc" }
      }),
      this.prisma.knowledgeBase.findMany({
        where: { status: "active" },
        include: {
          _count: { select: { documents: true } },
          documents: {
            select: { id: true, status: true, _count: { select: { chunks: true } } }
          }
        },
        orderBy: { createdAt: "asc" }
      })
    ]);

    const avgChunkLength = sampleChunks.length
      ? Math.round(sampleChunks.reduce((acc, c) => acc + c.content.length, 0) / sampleChunks.length)
      : 0;
    const parseSuccessRate = totalDocs ? Math.round((publishedDocs / totalDocs) * 1000) / 10 : 100;

    // Docling Worker probe
    let doclingOnline = false;
    let doclingLatencyMs = 0;
    const doclingUrl = process.env.PARSER_WORKER_URL || "http://127.0.0.1:8100";
    try {
      const t0 = Date.now();
      const doclingRes = await fetch(`${doclingUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2000) });
      doclingLatencyMs = Date.now() - t0;
      doclingOnline = doclingRes.ok;
    } catch {
      doclingOnline = false;
    }

    // 2. GBrain Sources & Disk Materialization
    const repoBasePath = process.env.BRAIN_REPO_BASE_PATH || "/home/scottsun/.local/share/llmwiki/brain_repos";
    const uploadRoot = process.env.UPLOAD_ROOT || "/home/scottsun/.local/share/llmwiki/uploads";
    let repoBytes = 0;
    let uploadBytes = 0;
    try {
      const duOut = execSync(`du -sb "${repoBasePath}" 2>/dev/null || du -sk "${repoBasePath}" 2>/dev/null`, { encoding: "utf8" });
      repoBytes = parseInt(duOut.trim().split(/\s+/)[0], 10) * (duOut.includes("-sb") ? 1 : 1024);
    } catch {}
    try {
      const duOut2 = execSync(`du -sb "${uploadRoot}" 2>/dev/null || du -sk "${uploadRoot}" 2>/dev/null`, { encoding: "utf8" });
      uploadBytes = parseInt(duOut2.trim().split(/\s+/)[0], 10) * (duOut2.includes("-sb") ? 1 : 1024);
    } catch {}

    const sources = await db.brainSource.findMany({
      where: { status: "active" },
      include: {
        _count: { select: { members: true, documents: true } }
      },
      orderBy: { sourceKey: "asc" }
    });

    // 3. Scope Brain Quality & Derived Intelligence
    const [totalUsers, scopes, derivedPages] = await Promise.all([
      this.prisma.user.count({ where: { status: "active" } }),
      db.brainScope.findMany({
        where: { status: "active" },
        include: {
          _count: { select: { members: true, derivedPages: true } },
          members: { include: { user: { select: { username: true, displayName: true } } } },
          derivedPages: { select: { id: true, slug: true, title: true, kind: true, derivedFrom: true, updatedAt: true } }
        },
        orderBy: { createdAt: "desc" }
      }),
      db.brainDerivedPage.findMany({
        select: { id: true, slug: true, title: true, kind: true, scopeId: true, derivedFrom: true, updatedAt: true }
      })
    ]);

    const eagerScopesCount = scopes.filter((s: any) => s.strategy === "eager").length;
    const lazyScopesCount = scopes.filter((s: any) => s.strategy === "lazy").length;
    const scopeCompressionRatio = totalUsers ? Math.max(0, Math.round((1 - scopes.length / totalUsers) * 100)) : 0;

    // 4. Two-tier Dream Maintenance
    const dreamTelemetry = await this.brainCompilerService.getDreamTelemetry();

    // 5. Outbox & Queues
    const [outboxTotal, outboxPending, outboxCompleted, outboxFailed, recentOutboxEvents] = await Promise.all([
      db.brainChangeEvent.count(),
      db.brainChangeEvent.count({ where: { status: "pending" } }),
      db.brainChangeEvent.count({ where: { status: "completed" } }),
      db.brainChangeEvent.count({ where: { status: "failed" } }),
      db.brainChangeEvent.findMany({ orderBy: { createdAt: "desc" }, take: 15 })
    ]);

    // 6. RAG & QA Stats
    const [totalConversations, totalMessages, totalCitations] = await Promise.all([
      this.prisma.conversation.count(),
      this.prisma.message.count(),
      this.prisma.citation.count()
    ]);

    const activeModelConfigs = await this.prisma.modelConfig.findMany({
      include: { provider: true },
      where: { provider: { enabled: true } }
    });

    const formatBytes = (bytes: number) => {
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    const isSystemHealthy = doclingOnline && failedDocs === 0 && outboxFailed === 0 && dreamTelemetry.health !== "failed";

    return {
      summary: {
        healthStatus: isSystemHealthy ? "healthy" : (dreamTelemetry.health === "failed" || !doclingOnline ? "warning" : "degraded"),
        doclingStatus: { online: doclingOnline, latencyMs: doclingLatencyMs, url: doclingUrl },
        maintenanceStatus: { health: dreamTelemetry.health, cron: dreamTelemetry.cron, lastRunAt: dreamTelemetry.lastRun?.startedAt || null },
        storageUsage: {
          repoBytes,
          repoFormatted: formatBytes(repoBytes),
          uploadBytes,
          uploadFormatted: formatBytes(uploadBytes)
        },
        outboxStatus: { pending: outboxPending, completed: outboxCompleted, failed: outboxFailed, total: outboxTotal },
        activeUsersCount: totalUsers,
        activeScopesCount: scopes.length,
        scopeCompressionRatio,
        derivedPagesCount: derivedPages.length
      },
      ingestionQuality: {
        totalDocuments: totalDocs,
        publishedDocuments: publishedDocs,
        failedDocuments: failedDocs,
        parsingDocuments: parsingDocs,
        parseSuccessRate,
        totalChunks,
        avgChunkLength,
        embeddingModel: process.env.GBRAIN_EMBEDDING_MODEL || "openai:BAAI/bge-m3",
        embeddingDimensions: 1024,
        kbBreakdown: kbs.map((kb: any) => ({
          id: kb.id,
          name: kb.name,
          type: kb.type,
          docsCount: kb._count.documents,
          chunksCount: kb.documents.reduce((sum: number, d: any) => sum + (d._count?.chunks || 0), 0),
          failedDocsCount: kb.documents.filter((d: any) => d.status === "failed").length
        })),
        failedDocsList: failedDocList.map((d: any) => ({
          id: d.id,
          title: d.title,
          kbName: d.kb?.name || "未知知识库",
          error: (d as any).parseError || "解析异常",
          createdAt: d.createdAt
        }))
      },
      gbrainSources: {
        sourcesCount: sources.length,
        sharedSourcesCount: sources.filter((s: any) => s.kind === "shared").length,
        privateSourcesCount: sources.filter((s: any) => s.kind === "private").length,
        sourcesList: sources.map((s: any) => ({
          sourceKey: s.sourceKey,
          kind: s.kind,
          status: s.status,
          scopeKey: s.scopeKey,
          lastSyncAt: s.lastSyncAt,
          documentsCount: s._count.documents,
          membersCount: s._count.members,
        }))
      },
      scopeBrainQuality: {
        scopesCount: scopes.length,
        eagerScopesCount,
        lazyScopesCount,
        derivedPagesCount: derivedPages.length,
        scopeList: scopes.map((s: any) => ({
          id: s.id,
          fingerprint: s.fingerprint,
          strategy: s.strategy,
          status: s.status,
          aclEpoch: s.aclEpoch,
          knowledgeEpoch: s.knowledgeEpoch,
          lastCompileAt: s.lastCompileAt,
          membersCount: s._count.members,
          members: s.members.map((m: any) => ({ username: m.user.username, displayName: m.user.displayName })),
          derivedPages: s.derivedPages.map((p: any) => ({
            id: p.id,
            slug: p.slug,
            title: p.title,
            kind: p.kind,
            derivedCount: Array.isArray(p.derivedFrom) ? p.derivedFrom.length : 0,
            updatedAt: p.updatedAt
          }))
        }))
      },
      dreamMaintenance: {
        cron: dreamTelemetry.cron,
        timezone: dreamTelemetry.timezone,
        health: dreamTelemetry.health,
        lastRun: dreamTelemetry.lastRun,
        runs: dreamTelemetry.runs,
        durationsAvgSec: dreamTelemetry.runs?.length
          ? Math.round(
              dreamTelemetry.runs.reduce(
                (sum: number, r: any) =>
                  sum + (r.completedAt && r.startedAt ? (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000 : 0),
                0
              ) / dreamTelemetry.runs.length
            )
          : 0
      },
      outboxAndQueues: {
        outboxCounts: { pending: outboxPending, completed: outboxCompleted, failed: outboxFailed, total: outboxTotal },
        recentEvents: recentOutboxEvents.map((e: any) => ({
          id: e.id,
          eventType: e.eventType,
          status: e.status,
          createdAt: e.createdAt,
          processedAt: e.processedAt,
          payload: e.payload
        })),
        queueJobCounts: dreamTelemetry.queueCounts || { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        maintenanceFailures: dreamTelemetry.maintenanceFailures || []
      },
      ragAndModels: {
        totalConversations,
        totalMessages,
        totalCitations,
        activeModels: activeModelConfigs.map((m: any) => ({
          kind: m.kind,
          modelName: m.modelName,
          providerName: m.provider.name,
          baseUrl: m.provider.baseUrl,
          isDefault: m.isDefault,
          testStatus: m.testStatus
        }))
      }
    };
  }

  @Post("brain/maintenance")
  async triggerBrainMaintenance(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.isSystemAdmin(userId)))
      throw new ForbiddenException("Only a system administrator can trigger Dream maintenance.");
    const job = await this.brainCompilerService.queueDreamCycle("manual");
    return { queued: true, jobId: job?.id || null };
  }

  @Post("orgs")
  async createOrg(@Req() req: any, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const name = String(body?.name || "").trim();
    const parentId = body?.parentId ? String(body.parentId) : null;
    if (!name) throw new BadRequestException("Organization name is required.");
    if (name.length > 120)
      throw new BadRequestException("Organization name is too long.");
    if (/[\\/]/.test(name))
      throw new BadRequestException(
        "Organization name cannot contain slash characters.",
      );
    if (parentId && !/^[0-9a-f-]{36}$/i.test(parentId))
      throw new BadRequestException("Invalid parent organization.");

    const parent = parentId
      ? await this.prisma.orgNode.findFirst({
          where: { id: parentId, status: "active" },
        })
      : null;
    if (parentId && !parent)
      throw new NotFoundException("Parent organization not found.");
    if (!parentId && !(await this.permissionService.isSystemAdmin(userId)))
      throw new ForbiddenException(
        "Only a system administrator can create a root organization.",
      );
    if (
      parentId &&
      !(await this.permissionService.canManageOrganization(userId, parentId))
    )
      throw new ForbiddenException(
        "You can only create child organizations within your managed scope.",
      );

    const siblingCount = await this.prisma.orgNode.count({
      where: { parentId, status: "active" },
    });
    const basePath = parent ? `${parent.path}/${name}` : `/${name}`;
    const duplicate = await this.prisma.orgNode.findFirst({
      where: { path: basePath, status: "active" },
    });
    if (duplicate)
      throw new BadRequestException(
        "An organization with the same path already exists.",
      );

    const adminUserIds: string[] = Array.isArray(body?.adminUserIds)
      ? Array.from(
          new Set<string>(
            body.adminUserIds
              .map((value: unknown): string => String(value))
              .filter((value: string) => Boolean(value)),
          ),
        )
      : [];
    if (adminUserIds.length) {
      const activeUsers = await this.prisma.user.findMany({
        where: { id: { in: adminUserIds }, status: "active" },
        select: { id: true },
      });
      if (activeUsers.length !== adminUserIds.length)
        throw new BadRequestException(
          "Organization administrators must be active users.",
        );
    }

    const org = await this.prisma.orgNode.create({
      data: {
        name,
        parentId,
        path: basePath,
        sort: siblingCount,
        admins: adminUserIds.length
          ? { create: adminUserIds.map((userId: string) => ({ userId })) }
          : undefined,
      },
      include: { admins: { select: { userId: true } } },
    });
    return { organization: org };
  }

  @Post("orgs/:id/admins")
  async updateOrgAdmins(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const operatorId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.canManageOrganization(operatorId, id)))
      throw new ForbiddenException(
        "You can only manage administrators within your organization scope.",
      );
    const org = await this.prisma.orgNode.findFirst({
      where: { id, status: "active" },
      include: { kbs: { select: { id: true } } },
    });
    if (!org) throw new NotFoundException("Organization not found.");
    const userIds = Array.isArray(body?.userIds) ? body.userIds : [];
    const activeUsers = await this.prisma.user.findMany({
      where: { id: { in: userIds }, status: "active" },
      select: { id: true },
    });
    if (activeUsers.length !== new Set(userIds).size)
      throw new BadRequestException(
        "Organization administrators must be active users.",
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.orgAdmin.deleteMany({ where: { orgNodeId: id } });
      if (userIds.length) {
        await tx.orgAdmin.createMany({
          data: userIds.map((userId: string) => ({ orgNodeId: id, userId })),
        });
        // 确保被指定的管理员自动获得“组织管理员”角色（如果尚未拥有），赋予其进入后台管理对应节点的权限
        const orgAdminRole = await tx.role.findFirst({
          where: { name: "组织管理员" },
        });
        if (orgAdminRole) {
          for (const uid of userIds) {
            const hasRole = await tx.userRole.findFirst({
              where: { userId: uid, roleId: orgAdminRole.id },
            });
            if (!hasRole) {
              await tx.userRole.create({
                data: { userId: uid, roleId: orgAdminRole.id },
              });
            }
          }
        }
      }
      for (const kb of org.kbs) {
        await tx.kbAdmin.deleteMany({ where: { kbId: kb.id } });
        if (userIds.length)
          await tx.kbAdmin.createMany({
            data: userIds.map((userId: string) => ({ kbId: kb.id, userId })),
          });
      }
    });
    await this.scheduleAccessReconciliation();
    return { ok: true };
  }

  @Delete("orgs/:id")
  async archiveOrg(@Req() req: any, @Param("id") id: string) {
    const operatorId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.canManageOrganization(operatorId, id)))
      throw new ForbiddenException(
        "You can only archive organizations within your organization scope.",
      );
    const childCount = await this.prisma.orgNode.count({
      where: { parentId: id, status: "active" },
    });
    if (childCount)
      throw new BadRequestException(
        "Move or archive child organizations first.",
      );
    const org = await this.prisma.orgNode.update({
      where: { id },
      data: { status: "archived" },
    });
    await this.scheduleAccessReconciliation();
    return { organization: org };
  }

  private async canManageOrganization(
    userId: string,
    orgId: string,
  ): Promise<boolean> {
    return this.permissionService.canManageOrganization(userId, orgId);
  }

  @Post("orgs/:id/knowledge-base/activate")
  async activateOrganizationKnowledgeBase(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!(await this.canManageOrganization(userId, id)))
      throw new BadRequestException(
        "Only a system administrator or an administrator of this organization or its parent can activate the organization knowledge base.",
      );
    const org = await this.prisma.orgNode.findFirst({
      where: { id, status: "active" },
      include: { admins: { select: { userId: true } } },
    });
    if (!org) throw new NotFoundException("Organization not found.");
    const name = String(body?.name || `${org.name}知识库`).trim();
    const existing = await this.prisma.knowledgeBase.findFirst({
      where: { type: "org", orgNodeId: id },
      include: { admins: true, _count: { select: { documents: true } } },
    });
    const adminIds = [
      ...new Set([
        userId,
        ...org.admins.map((item) => item.userId),
        ...(existing?.admins || []).map((item) => item.userId),
      ]),
    ];
    const kb = existing
      ? await this.prisma.knowledgeBase.update({
          where: { id: existing.id },
          data: {
            status: "active",
            name,
            description:
              body?.description !== undefined
                ? String(body.description)
                : existing.description,
          },
        })
      : await this.prisma.knowledgeBase.create({
          data: {
            type: "org",
            orgNodeId: id,
            name,
            description: String(
              body?.description || `${org.name}组织成员共享的知识库`,
            ),
            gitRepoUrl: `db://org/${id}`,
          },
        });
    await this.prisma.kbAdmin.createMany({
      data: adminIds.map((adminId) => ({ kbId: kb.id, userId: adminId })),
      skipDuplicates: true,
    });
    await this.scheduleAccessReconciliation();
    return { knowledgeBase: { ...kb, status: "active" } };
  }

  @Post("orgs/:id/knowledge-base/deactivate")
  async deactivateOrganizationKnowledgeBase(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!(await this.canManageOrganization(userId, id)))
      throw new BadRequestException(
        "Only a system administrator or an administrator of this organization or its parent can deactivate the organization knowledge base.",
      );
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { type: "org", orgNodeId: id, status: "active" },
    });
    if (!kb)
      throw new NotFoundException("Organization knowledge base is not active.");
    const knowledgeBase = await this.prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: { status: "archived" },
    });
    await this.scheduleAccessReconciliation();
    return { knowledgeBase };
  }

  @Post("users")
  async createUser(@Req() req: any, @Body() body: any) {
    const operatorId = await this.authService.userIdFromRequest(req);
    const username = String(body?.username || "").trim();
    const displayName = String(body?.displayName || "").trim();
    const email = String(body?.email || `${username}@local.invalid`).trim();
    if (!username || !displayName)
      throw new BadRequestException("Username and display name are required.");
    const orgIds: string[] = Array.isArray(body?.orgIds)
      ? Array.from(new Set<string>(body.orgIds.map((id: string) => String(id))))
      : [];
    if (!orgIds.length)
      throw new BadRequestException("At least one organization is required.");
    const orgs = await this.prisma.orgNode.findMany({
      where: { id: { in: orgIds }, status: "active" },
      select: { id: true },
    });
    if (orgs.length !== orgIds.length)
      throw new BadRequestException("One or more organizations are invalid.");
    if (!(await this.permissionService.isSystemAdmin(operatorId))) {
      const managedOrgIds =
        await this.permissionService.getManagedOrgIds(operatorId);
      if (orgIds.some((orgId) => !managedOrgIds.has(orgId)))
        throw new ForbiddenException(
          "You can only assign users to your organization or its descendants.",
        );
    }
    const roleIds: string[] = Array.isArray(body?.roleIds)
      ? Array.from(
          new Set<string>(body.roleIds.map((id: string) => String(id))),
        )
      : [];
    await this.validateAssignableRoles(operatorId, roleIds);
    const basicRole = await this.prisma.role.findUnique({
      where: { name: "普通用户" },
      select: { id: true },
    });
    const finalRoleIds = roleIds.length
      ? roleIds
      : basicRole
        ? [basicRole.id]
        : [];
    if (
      process.env.NODE_ENV === "production" &&
      !String(body?.password || "").trim()
    )
      throw new BadRequestException(
        "A temporary password is required in production.",
      );
    const password = String(body?.password || "LLMwiki@2026");
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing)
      throw new BadRequestException(
        `User with username "${username}" or email "${email}" already exists.`,
      );
    const user = await this.prisma.user.create({
      data: {
        username,
        displayName,
        email,
        passwordHash: this.authService.hashPassword(password),
        status: body?.status === "disabled" ? "disabled" : "active",
        orgs: { create: orgIds.map((orgNodeId: string) => ({ orgNodeId })) },
        roles: { create: finalRoleIds.map((roleId: string) => ({ roleId })) },
      },
      include: {
        roles: { include: { role: true } },
        orgs: { include: { orgNode: true } },
      },
    });
    await this.brainCompilerService.ensureUserBrainRepo(user.id);
    await this.brainOutboxService?.emitEvent("role_change", "user", user.id, {
      action: "create",
      orgIds,
      roleIds: finalRoleIds,
    });
    await this.scheduleAccessReconciliation();
    return { user };
  }

  @Patch("users/:id")
  async updateUser(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const operatorId = await this.authService.userIdFromRequest(req);
    const exists = await this.prisma.user.findUnique({
      where: { id },
      include: { orgs: true },
    });
    if (!exists) throw new NotFoundException("User not found.");
    if (!(await this.permissionService.canManageUser(operatorId, id)))
      throw new ForbiddenException(
        "You can only manage users in your organization or its descendants.",
      );
    if (body?.username || body?.email) {
      const duplicate = await this.prisma.user.findFirst({
        where: {
          id: { not: id },
          OR: [
            ...(body.username
              ? [{ username: String(body.username).trim() }]
              : []),
            ...(body.email ? [{ email: String(body.email).trim() }] : []),
          ],
        },
      });
      if (duplicate)
        throw new BadRequestException(
          "User with that username or email already exists.",
        );
    }
    const data: Record<string, unknown> = {};
    if (body?.displayName) data.displayName = String(body.displayName).trim();
    if (body?.username) data.username = String(body.username).trim();
    if (body?.email) data.email = String(body.email).trim();
    if (body?.status && ["active", "disabled"].includes(body.status))
      data.status = body.status;
    if (body?.password)
      data.passwordHash = this.authService.hashPassword(String(body.password));
    const roleIds: string[] | undefined = Array.isArray(body?.roleIds)
      ? Array.from(
          new Set<string>(body.roleIds.map((item: string) => String(item))),
        )
      : undefined;
    if (roleIds) await this.validateAssignableRoles(operatorId, roleIds);
    const orgIds: string[] | undefined = Array.isArray(body?.orgIds)
      ? Array.from(
          new Set<string>(body.orgIds.map((item: string) => String(item))),
        )
      : undefined;
    if (orgIds) {
      if (!orgIds.length)
        throw new BadRequestException("At least one organization is required.");
      const orgs = await this.prisma.orgNode.findMany({
        where: { id: { in: orgIds }, status: "active" },
        select: { id: true },
      });
      if (orgs.length !== orgIds.length)
        throw new BadRequestException("One or more organizations are invalid.");
      if (!(await this.permissionService.isSystemAdmin(operatorId))) {
        const managedOrgIds =
          await this.permissionService.getManagedOrgIds(operatorId);
        if (orgIds.some((orgId) => !managedOrgIds.has(orgId)))
          throw new ForbiddenException(
            "You can only assign users to your organization or its descendants.",
          );
      }
    }
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data });
      if (orgIds) {
        await tx.userOrg.deleteMany({ where: { userId: id } });
        await tx.userOrg.createMany({
          data: orgIds.map((orgNodeId: string) => ({ userId: id, orgNodeId })),
        });
      }
      if (roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (roleIds.length)
          await tx.userRole.createMany({
            data: roleIds.map((roleId: string) => ({ userId: id, roleId })),
          });
      }
      return tx.user.findUnique({
        where: { id },
        include: {
          roles: { include: { role: true } },
          orgs: { include: { orgNode: true } },
        },
      });
    });
    await this.brainOutboxService?.emitEvent("role_change", "user", id, {
      action: "update",
      orgIds,
      roleIds,
    });
    await this.scheduleAccessReconciliation();
    return { user };
  }

  @Delete("users/:id")
  async disableUser(@Req() req: any, @Param("id") id: string) {
    const operatorId = await this.authService.userIdFromRequest(req);
    if (!(await this.permissionService.canManageUser(operatorId, id)))
      throw new ForbiddenException(
        "You can only manage users in your organization or its descendants.",
      );
    const user = await this.prisma.user.update({
      where: { id },
      data: { status: "disabled" },
    });
    await this.brainOutboxService?.emitEvent("perm_revoke", "user", id, {
      action: "disable",
    });
    await this.scheduleAccessReconciliation();
    return { user };
  }

  private async validateAssignableRoles(operatorId: string, roleIds: string[]) {
    if (await this.permissionService.isSystemAdmin(operatorId)) return;
    if (!roleIds || !roleIds.length) return;
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, name: true, builtin: true, permissions: true },
    });
    if (
      roles.some(
        (role) =>
          role.builtin ||
          role.name === "超级管理员" ||
          role.name === "系统管理员" ||
          (Array.isArray(role.permissions) && role.permissions.includes("*")),
      )
    ) {
      throw new ForbiddenException(
        "只有系统管理员才可以赋予或操作超级管理员/系统管理员角色。",
      );
    }
  }

  @Post("roles")
  async createRole(@Req() req: any, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const name = String(body?.name || "").trim();
    if (!name) throw new BadRequestException("Role name is required.");
    const existing = await this.prisma.role.findFirst({ where: { name } });
    if (existing)
      throw new BadRequestException(`Role with name "${name}" already exists.`);
    const role = await this.prisma.role.create({
      data: {
        name,
        description: String(body?.description || ""),
        builtin: false,
        permissions: Array.isArray(body?.permissions) ? body.permissions : [],
      },
    });
    await this.scheduleAccessReconciliation();
    return { role };
  }

  @Patch("roles/:id")
  async updateRole(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    await this.authService.adminUserIdFromRequest(req);
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException("Role not found.");
    if (body?.name && String(body.name).trim() !== role.name) {
      const duplicate = await this.prisma.role.findFirst({
        where: { name: String(body.name).trim(), id: { not: id } },
      });
      if (duplicate)
        throw new BadRequestException(
          `Role with name "${body.name}" already exists.`,
        );
    }
    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        name: role.builtin ? role.name : String(body?.name ?? role.name),
        description: String(body?.description ?? (role.description || "")),
        permissions: Array.isArray(body?.permissions)
          ? body.permissions
          : role.permissions,
      },
    });
    await this.scheduleAccessReconciliation();
    return { role: updated };
  }

  @Delete("roles/:id")
  async deleteRole(@Req() req: any, @Param("id") id: string) {
    await this.authService.adminUserIdFromRequest(req);
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException("Role not found.");
    if (role.builtin)
      throw new BadRequestException("Built-in roles cannot be deleted.");
    await this.prisma.$transaction([
      this.prisma.industryGrant.deleteMany({
        where: { subjectType: "role", subjectId: id },
      }),
      this.prisma.role.delete({ where: { id } }),
    ]);
    await this.scheduleAccessReconciliation();
    return { ok: true };
  }

  @Post("kbs")
  async createKnowledgeBase(@Req() req: any, @Body() body: any) {
    const adminId = await this.authService.userIdFromRequest(req);
    const name = String(body?.name || "").trim();
    const type = ["industry", "org", "personal"].includes(body?.type)
      ? body.type
      : "industry";
    if (!name)
      throw new BadRequestException("Knowledge base name is required.");
    const isSystemAdmin = await this.permissionService.isSystemAdmin(adminId);
    if (type === "personal") {
      if (body?.ownerUserId && body.ownerUserId !== adminId && !isSystemAdmin)
        throw new ForbiddenException(
          "A personal knowledge base can only belong to its owner.",
        );
    } else if (type === "industry") {
      if (
        !isSystemAdmin &&
        !(await this.permissionService.hasPermission(
          adminId,
          "kb.industry.create",
        ))
      )
        throw new ForbiddenException(
          "Industry knowledge base creation permission required.",
        );
    } else {
      if (
        !body?.orgNodeId ||
        !(await this.permissionService.canManageOrganization(
          adminId,
          String(body.orgNodeId),
        ))
      )
        throw new ForbiddenException(
          "You can only create organization knowledge bases within your managed scope.",
        );
    }
    const kb = await this.prisma.knowledgeBase.create({
      data: {
        name,
        type,
        description: String(body?.description || ""),
        gitRepoUrl: String(body?.gitRepoUrl || `db://${name}`),
        orgNodeId: type === "org" ? String(body.orgNodeId) : undefined,
        ownerUserId:
          type === "personal" || type === "industry" ? adminId : undefined,
        admins:
          type === "personal" ? undefined : { create: [{ userId: adminId }] },
      },
      include: {
        admins: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                email: true,
                status: true,
              },
            },
          },
        },
        _count: { select: { documents: true } },
      },
    });
    await this.scheduleAccessReconciliation();
    return { knowledgeBase: { ...kb, documentCount: kb._count.documents } };
  }

  @Delete("kbs/:id")
  async archiveKnowledgeBase(@Req() req: any, @Param("id") id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id },
      select: { id: true, type: true, ownerUserId: true },
    });
    if (!kb) throw new NotFoundException("Knowledge base not found.");
    const allowed =
      kb.type === "personal"
        ? kb.ownerUserId === userId
        : kb.type === "industry"
          ? await this.permissionService.canManageIndustryKb(userId, id)
          : false;
    if (!(await this.permissionService.isSystemAdmin(userId)) && !allowed)
      throw new ForbiddenException(
        "Knowledge base management permission required.",
      );
    const knowledgeBase = await this.prisma.knowledgeBase.update({
      where: { id },
      data: { status: "archived" },
    });
    await this.scheduleAccessReconciliation();
    return { knowledgeBase };
  }

  @Post("kbs/:id/admins")
  async updateKbAdmins(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id },
      select: { id: true, type: true, ownerUserId: true, status: true },
    });
    if (!kb) throw new NotFoundException("Knowledge base not found.");
    if (kb.type === "personal")
      throw new ForbiddenException(
        "Personal knowledge bases cannot be shared or assigned administrators.",
      );
    if (
      !(await this.permissionService.canManageIndustryKb(userId, id)) &&
      !(await this.permissionService.isSystemAdmin(userId))
    )
      throw new ForbiddenException(
        "Knowledge base administrator permission required.",
      );
    const userIds = Array.isArray(body?.userIds) ? body.userIds : [];
    if (!userIds.length)
      throw new BadRequestException("At least one administrator is required.");
    const activeUsers = await this.prisma.user.findMany({
      where: { id: { in: userIds }, status: "active" },
      select: { id: true },
    });
    if (activeUsers.length !== new Set(userIds).size)
      throw new BadRequestException(
        "Knowledge base administrators must be active users.",
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.kbAdmin.deleteMany({ where: { kbId: id } });
      await tx.kbAdmin.createMany({
        data: userIds.map((userId: string) => ({ kbId: id, userId })),
      });
    });
    await this.scheduleAccessReconciliation();
    return { ok: true };
  }

  @Post("grants")
  async createGrant(@Req() req: any, @Body() body: any) {
    const grantedById = await this.authService.userIdFromRequest(req);
    const subjectType = String(body?.subjectType || "user");
    const subjectId = String(body?.subjectId || "");
    const kbId = String(body?.kbId || "");
    if (!["user", "role", "org"].includes(subjectType) || !subjectId || !kbId)
      throw new BadRequestException("Invalid grant.");
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, type: true, status: true },
    });
    if (!kb || kb.type !== "industry" || kb.status !== "active")
      throw new NotFoundException("Industry knowledge base not found.");
    if (!(await this.permissionService.canGrantIndustryKb(grantedById, kbId)))
      throw new ForbiddenException(
        "Industry knowledge base authorization permission required.",
      );
    if (
      subjectType === "user" &&
      !(await this.prisma.user.findFirst({
        where: { id: subjectId, status: "active" },
        select: { id: true },
      }))
    )
      throw new BadRequestException("Authorized user is invalid.");
    if (
      subjectType === "role" &&
      !(await this.prisma.role.findUnique({
        where: { id: subjectId },
        select: { id: true },
      }))
    )
      throw new BadRequestException("Authorized role is invalid.");
    if (
      subjectType === "org" &&
      !(await this.prisma.orgNode.findFirst({
        where: { id: subjectId, status: "active" },
        select: { id: true },
      }))
    )
      throw new BadRequestException("Authorized organization is invalid.");
    const duplicate = await this.prisma.industryGrant.findFirst({
      where: { kbId, subjectType, subjectId },
    });
    if (duplicate)
      throw new BadRequestException("This authorization already exists.");
    const grant = await this.prisma.industryGrant.create({
      data: {
        kbId,
        subjectType,
        subjectId,
        grantedById,
        expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null,
      },
    });
    await this.brainOutboxService?.emitEvent(
      "perm_grant",
      "knowledge_base",
      kbId,
      { subjectType, subjectId, grantedById, grantId: grant.id },
    );
    await this.scheduleAccessReconciliation();
    return { grant };
  }

  @Delete("grants/:id")
  async deleteGrant(@Req() req: any, @Param("id") id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const grant = await this.prisma.industryGrant.findUnique({
      where: { id },
      select: { id: true, kbId: true },
    });
    if (!grant) throw new NotFoundException("Authorization not found.");
    if (!(await this.permissionService.canGrantIndustryKb(userId, grant.kbId)))
      throw new ForbiddenException(
        "Industry knowledge base authorization permission required.",
      );
    await this.prisma.industryGrant.delete({ where: { id } });
    await this.brainOutboxService?.emitEvent(
      "perm_revoke",
      "knowledge_base",
      grant.kbId,
      { grantId: id },
    );
    await this.scheduleAccessReconciliation();
    return { ok: true };
  }

  @Post("providers")
  async createProvider(@Req() req: any, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const name = String(body?.name || "").trim();
    const baseUrl = String(body?.baseUrl || "").trim();
    if (!name || !baseUrl)
      throw new BadRequestException("Provider name and base URL are required.");
    const provider = await this.prisma.modelProvider.create({
      data: {
        name,
        kind: String(body?.kind || "external"),
        baseUrl,
        apiKeyEncrypted: body?.apiKey
          ? encryptModelCredential(String(body.apiKey))
          : undefined,
        defaultParams: body?.defaultParams || undefined,
      },
    });
    await this.modelConfigService.applyRuntimeConfig();
    return { provider };
  }

  @Delete("providers/:id")
  async deleteProvider(@Req() req: any, @Param("id") id: string) {
    await this.authService.adminUserIdFromRequest(req);
    const count = await this.prisma.modelConfig.count({
      where: { providerId: id },
    });
    if (count > 0) {
      throw new BadRequestException(
        "Cannot delete provider because models are currently associated with it. Please reassign or delete the models first.",
      );
    }
    await this.prisma.modelProvider.delete({ where: { id } });
    return { ok: true };
  }

  @Patch("providers/:id")
  async updateProvider(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    await this.authService.adminUserIdFromRequest(req);
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id },
    });
    if (!provider) throw new NotFoundException("Provider not found.");
    const updated = await this.prisma.modelProvider.update({
      where: { id },
      data: {
        name:
          body?.name !== undefined ? String(body.name).trim() : provider.name,
        kind: body?.kind !== undefined ? String(body.kind) : provider.kind,
        baseUrl:
          body?.baseUrl !== undefined
            ? String(body.baseUrl).trim()
            : provider.baseUrl,
        apiKeyEncrypted: body?.apiKey
          ? encryptModelCredential(String(body.apiKey))
          : undefined,
        defaultParams:
          body?.defaultParams !== undefined
            ? body.defaultParams
            : provider.defaultParams,
      },
    });
    await this.modelConfigService.applyRuntimeConfig();
    return { provider: updated };
  }

  @Post("models")
  async createModel(@Req() req: any, @Body() body: any) {
    await this.authService.adminUserIdFromRequest(req);
    const providerId = String(body?.providerId || "");
    const modelName = String(body?.modelName || "").trim();
    if (!providerId || !modelName)
      throw new BadRequestException("Provider and model name are required.");
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id: providerId },
    });
    if (!provider) throw new NotFoundException("Provider not found.");
    const kind = ["llm", "embedding", "rerank"].includes(body?.kind)
      ? body.kind
      : "llm";
    if (body?.isDefault)
      await this.prisma.modelConfig.updateMany({
        where: { kind },
        data: { isDefault: false },
      });
    const model = await this.prisma.modelConfig.create({
      data: {
        providerId,
        kind,
        modelName,
        contextLen: Number(body?.contextLen || 8192),
        dimensions: body?.dimensions ? Number(body.dimensions) : undefined,
        isDefault: Boolean(body?.isDefault),
      },
    });
    await this.modelConfigService.applyRuntimeConfig();
    return { model };
  }

  @Patch("models/:id")
  async updateModel(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    await this.authService.adminUserIdFromRequest(req);
    const existing = await this.prisma.modelConfig.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException("Model not found.");
    const kind = body?.kind !== undefined ? String(body.kind) : existing.kind;
    if (!["llm", "embedding", "rerank"].includes(kind))
      throw new BadRequestException("Invalid model kind.");
    if (body?.isDefault)
      await this.prisma.modelConfig.updateMany({
        where: { kind },
        data: { isDefault: false },
      });
    const model = await this.prisma.modelConfig.update({
      where: { id },
      data: {
        providerId: body?.providerId
          ? String(body.providerId)
          : existing.providerId,
        kind,
        modelName:
          body?.modelName !== undefined
            ? String(body.modelName).trim()
            : existing.modelName,
        contextLen:
          body?.contextLen !== undefined
            ? Number(body.contextLen)
            : existing.contextLen,
        dimensions:
          body?.dimensions !== undefined && body.dimensions !== ""
            ? Number(body.dimensions)
            : existing.dimensions,
        isDefault:
          body?.isDefault !== undefined
            ? Boolean(body.isDefault)
            : existing.isDefault,
      },
    });
    await this.modelConfigService.applyRuntimeConfig();
    return { model };
  }

  @Delete("models/:id")
  async deleteModel(@Req() req: any, @Param("id") id: string) {
    await this.authService.adminUserIdFromRequest(req);
    const model = await this.prisma.modelConfig.findUnique({ where: { id } });
    if (!model) throw new NotFoundException("Model not found.");
    if (model.isDefault) {
      throw new BadRequestException(
        "Cannot delete the default active model for this kind.",
      );
    }
    await this.prisma.modelConfig.delete({ where: { id } });
    await this.modelConfigService.applyRuntimeConfig();
    return { ok: true };
  }

  @Post("models/:id/test")
  async testModel(@Req() req: any, @Param("id") id: string) {
    await this.authService.adminUserIdFromRequest(req);
    const config = await this.prisma.modelConfig.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!config) throw new NotFoundException("Model not found.");
    let status = "failed";
    try {
      const key = decryptModelCredential(config.provider.apiKeyEncrypted);
      const response = await fetch(
        `${config.provider.baseUrl.replace(/\/$/, "")}/models`,
        { headers: key ? { Authorization: `Bearer ${key}` } : {} },
      );
      status = response.ok ? "passed" : "failed";
    } catch {
      status = "failed";
    }
    const model = await this.prisma.modelConfig.update({
      where: { id },
      data: { testStatus: status },
    });
    return { ok: status === "passed", status, model };
  }
}
