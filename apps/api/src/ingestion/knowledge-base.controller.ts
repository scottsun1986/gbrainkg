import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  Body,
} from "@nestjs/common";
import { getPrismaClient } from "../prisma";
import type { Response } from "express";
import { readFile, stat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
import { PermissionService } from "../permission/permission.service";
import { AuthService } from "../auth/auth.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthGuard } from "../auth/auth.guard";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function contentTypeFor(filename: string): string {
  const types: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[extname(filename).toLowerCase()] || "application/octet-stream";
}

function previewSecret(): string {
  return (
    process.env.PREVIEW_TOKEN_SECRET ||
    process.env.AUTH_SECRET ||
    "llmwiki-local-development-secret"
  );
}

function signPreviewPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", previewSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function verifyPreviewPayload(token: string): Record<string, any> | null {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", previewSecret())
    .update(body)
    .digest("base64url");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload?.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function onlyOfficeDocumentType(
  filename: string,
): "word" | "cell" | "slide" | "pdf" {
  const extension = extname(filename).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if ([".xls", ".xlsx", ".csv"].includes(extension)) return "cell";
  if ([".ppt", ".pptx"].includes(extension)) return "slide";
  return "word";
}

function brainTopicSlug(title: string): string {
  return (
    title
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
      .trim() || title
  );
}

@UseGuards(AuthGuard)
@Controller("api/v1/kbs")
export class KnowledgeBaseController {
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";
  /**
   * 文档列表每次渲染要对多达 50 个文档做文件系统 stat（最多 2 次/文档），
   * 解析期间前端还会 2 秒轮询一次。文件大小只随文档行变更（updatedAt/
   * version 变化会换 key），用短 TTL 缓存把重复 stat 收敛掉。
   */
  private static readonly SIZE_CACHE_TTL_MS = Math.max(
    0,
    Number(process.env.DOC_SIZE_CACHE_TTL_MS ?? 60_000),
  );
  private static readonly SIZE_CACHE_MAX = 5000;
  private readonly docSizeCache = new Map<
    string,
    { expiresAt: number; size: number | null }
  >();

  private async resolveDocumentSize(item: {
    id: string;
    version: number;
    updatedAt: Date;
    rawFileOid?: string | null;
  }): Promise<number | null> {
    const cacheKey = `${item.id}:${item.version}:${item.updatedAt.getTime()}`;
    const cached = KnowledgeBaseController.SIZE_CACHE_TTL_MS
      ? this.docSizeCache.get(cacheKey)
      : undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.size;
    let sizeBytes: number | null = null;
    if (item.rawFileOid) {
      try {
        sizeBytes = (await stat(item.rawFileOid)).size;
      } catch {}
    }
    if (!sizeBytes) {
      try {
        sizeBytes = (
          await stat(join(this.uploadRoot, item.id, "content.md"))
        ).size;
      } catch {}
    }
    if (
      KnowledgeBaseController.SIZE_CACHE_TTL_MS &&
      this.docSizeCache.size >= KnowledgeBaseController.SIZE_CACHE_MAX &&
      !this.docSizeCache.has(cacheKey)
    ) {
      // 简单过期清理，避免长期运行下缓存无限膨胀。
      const now = Date.now();
      for (const [key, entry] of this.docSizeCache) {
        if (entry.expiresAt <= now) this.docSizeCache.delete(key);
        if (this.docSizeCache.size < KnowledgeBaseController.SIZE_CACHE_MAX)
          break;
      }
    }
    if (KnowledgeBaseController.SIZE_CACHE_TTL_MS) {
      this.docSizeCache.set(cacheKey, {
        expiresAt: Date.now() + KnowledgeBaseController.SIZE_CACHE_TTL_MS,
        size: sizeBytes,
      });
    }
    return sizeBytes;
  }

  constructor(
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
    private readonly compilerService: BrainCompilerService,
  ) {}

  private async currentUser(req: any): Promise<string> {
    return this.authService.userIdFromRequest(req);
  }

  /**
   * Self-service personal knowledge-base creation. Personal KBs are a
   * first-class product capability for every user (project plan P0-8) and must
   * not require admin capabilities: the admin KB endpoint is guarded by
   * AdminGuard, which ordinary users cannot pass.
   */
  @Post("personal")
  async createPersonalKnowledgeBase(
    @Req() req: any,
    @Body() body: { name?: string; description?: string },
  ) {
    const userId = await this.currentUser(req);
    const name = String(body?.name || "").trim();
    if (!name) throw new BadRequestException("Knowledge base name is required.");
    const normalizedName = name.slice(0, 120);
    const existing = await this.prisma.knowledgeBase.count({
      where: { type: "personal", ownerUserId: userId, status: "active" },
    });
    if (existing >= 20) {
      throw new BadRequestException("Personal knowledge base limit (20) reached.");
    }
    // Names must be unique within one user's personal scope; different users
    // may reuse the same name freely.
    const duplicate = await this.prisma.knowledgeBase.findFirst({
      where: { type: "personal", ownerUserId: userId, status: "active", name: normalizedName },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(`已存在同名个人知识库「${normalizedName}」，请换一个名称。`);
    }
    const knowledgeBase = await this.prisma.knowledgeBase.create({
      data: {
        name: normalizedName,
        type: "personal",
        description: String(body?.description || "").slice(0, 500),
        gitRepoUrl: `db://${normalizedName}`,
        ownerUserId: userId,
      },
      include: { _count: { select: { documents: true } } },
    });
    // Keep the compile layer's membership in sync without waiting for the
    // next 15-minute reconciliation sweep.
    await this.compilerService
      .queueAccessReconciliation()
      .catch(() => undefined);
    return {
      knowledgeBase: {
        ...(knowledgeBase as any),
        documentCount: (knowledgeBase as any)._count?.documents ?? 0,
      },
    };
  }

  /**
   * Update KB-level retrieval vocabulary. Accepts either a flat hint-term list
   * (`["报销","发票"]`) or a colloquial -> formal term mapping object
   * (object map of colloquial→formal term lists). Sending `[]` clears it.
   * No vocabulary is hardcoded server-side; this is the only source of terms.
   */
  @Post(":kbId/domain-terms")
  async updateDomainTerms(
    @Req() req: any,
    @Param("kbId") kbId: string,
    @Body() body: { domainTerms?: unknown },
  ) {
    const userId = await this.currentUser(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, status: true },
    });
    if (!kb || kb.status !== "active")
      throw new NotFoundException("Knowledge base not found.");
    if (!(await this.permissionService.canManageKnowledgeBase(userId, kbId))) {
      throw new ForbiddenException(
        "Only the knowledge base owner or administrator can update domain terms.",
      );
    }
    const raw = body?.domainTerms;
    const sanitizeTerm = (value: unknown) =>
      String(value ?? "").trim().slice(0, 100);
    let stored: unknown;
    if (Array.isArray(raw)) {
      stored = Array.from(new Set(raw.map(sanitizeTerm).filter(Boolean))).slice(0, 500);
    } else if (raw && typeof raw === "object") {
      const mapped: Record<string, string[]> = {};
      for (const [from, to] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
        const key = sanitizeTerm(from);
        if (!key) continue;
        const targets = (Array.isArray(to) ? to : [to])
          .map(sanitizeTerm)
          .filter((target) => Boolean(target) && target !== key)
          .slice(0, 20);
        if (targets.length) mapped[key] = Array.from(new Set(targets));
      }
      stored = mapped;
    } else {
      throw new BadRequestException(
        "domainTerms must be an array of strings or an object mapping term -> targets.",
      );
    }
    await this.prisma.knowledgeBase.update({
      where: { id: kbId },
      data: { domainTerms: stored as any },
    });
    return { kbId, domainTerms: stored };
  }

  /**
   * Self-service deletion of one's own personal knowledge base (archive
   * semantics, matching the admin endpoint).
   */
  @Delete("personal/:kbId")
  async deletePersonalKnowledgeBase(@Req() req: any, @Param("kbId") kbId: string) {
    const userId = await this.currentUser(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, type: true, ownerUserId: true, status: true },
    });
    if (!kb) throw new NotFoundException("Knowledge base not found.");
    if (kb.type !== "personal" || kb.ownerUserId !== userId) {
      throw new ForbiddenException("You can only delete your own personal knowledge base.");
    }
    if (kb.status !== "active") throw new NotFoundException("Knowledge base not found.");
    const knowledgeBase = await this.prisma.knowledgeBase.update({
      where: { id: kbId },
      data: { status: "archived" },
    });
    await this.compilerService
      .queueAccessReconciliation()
      .catch(() => undefined);
    return { knowledgeBase };
  }

  @Get()
  async list(
    @Req() req: any,
    @Query("type") type?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "50",
  ) {
    const userId = await this.currentUser(req);
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const where = {
      id: { in: visibleIds },
      status: "active",
      ...(type ? { type } : {}),
    };
    const isSystemAdmin = await this.permissionService.isSystemAdmin(userId);
    const [items, total] = await Promise.all([
      this.prisma.knowledgeBase.findMany({
        where,
        include: { _count: { select: { documents: true } } },
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.knowledgeBase.count({ where }),
    ]);
    const writePermissions = await this.permissionService.canManageKnowledgeBases(
      userId,
      items.map((item) => item.id),
    );
    // canDelete 与 canManageIndustryKb 语义一致：系统管理员/行业库 owner/
    // 行业库管理员。批量收集 KbAdmin 关系，避免逐库查询。
    const industryIds = items
      .filter((item) => item.type === "industry")
      .map((item) => item.id);
    const industryAdminRows = industryIds.length
      ? await this.prisma.kbAdmin.findMany({
          where: { userId, kbId: { in: industryIds } },
          select: { kbId: true },
        })
      : [];
    const industryAdminKbIds = new Set(industryAdminRows.map((row) => row.kbId));
    return {
      items: items.map(({ _count, ...item }) => ({
        ...item,
        documentCount: _count.documents,
        canWrite: writePermissions.get(item.id) || false,
        canDelete:
          item.type === "industry"
            ? isSystemAdmin ||
              item.ownerUserId === userId ||
              industryAdminKbIds.has(item.id)
            : item.ownerUserId === userId,
      })),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  @Get(":kbId/documents")
  async listDocuments(
    @Param("kbId") kbId: string,
    @Req() req: any,
    @Query("status") status?: string,
    @Query("indexReadiness") indexReadiness?: string,
    @Query("search") search?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "50",
  ) {
    const userId = await this.currentUser(req);
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId))
      throw new NotFoundException("Knowledge base not found.");
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const where: any = {
      kbId,
      ...(status && status !== "all" ? { status } : {}),
      ...(indexReadiness && indexReadiness !== "all" ? { indexReadiness } : {}),
      ...(search && search.trim()
        ? {
            OR: [
              { title: { contains: search.trim(), mode: "insensitive" } },
              { mdPath: { contains: search.trim(), mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total, statusGroups] = await Promise.all([
      this.prisma.document.findMany({
        where,
        select: {
          id: true,
          kbId: true,
          title: true,
          mdPath: true,
          status: true,
          sourceType: true,
          rawFileOid: true,
          version: true,
          uploadedById: true,
          parserEngine: true,
          qualityStatus: true,
          qualityScore: true,
          qualityIssues: true,
          lifecycleStatus: true,
          createdAt: true,
          updatedAt: true,
        },
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.document.count({ where }),
      // Whole-KB status breakdown. The management page used to derive these
      // counters from the fetched page, so with server-side pagination they
      // would only ever reflect the current page (e.g. 10).
      this.prisma.document.groupBy({
        by: ["status"],
        where: { kbId },
        _count: { _all: true },
      }),
    ]);
    const statusCounts: Record<string, number> = { total: 0 };
    for (const group of statusGroups) {
      statusCounts[group.status] = group._count?._all ?? 0;
    }
    statusCounts.total = Object.entries(statusCounts)
      .filter(([key]) => key !== "total" && key !== "processing")
      .reduce((sum, [, value]) => sum + Number(value || 0), 0);
    statusCounts.processing =
      (statusCounts.parsing || 0) + (statusCounts.indexing || 0);
    const uploaderIds = [
      ...new Set(
        items
          .map((item) => item.uploadedById)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const uploaders = await this.prisma.user.findMany({
      where: { id: { in: uploaderIds } },
      select: { id: true, displayName: true, username: true },
    });
    const uploaderById = new Map(uploaders.map((user) => [user.id, user]));
    const itemsWithStats = await Promise.all(
      items.map(async (item) => ({
        ...item,
        sizeBytes: await this.resolveDocumentSize(item),
        uploadedBy: item.uploadedById
          ? uploaderById.get(item.uploadedById) || null
          : null,
      })),
    );
    return {
      items: itemsWithStats,
      total,
      page: pageNumber,
      limit: pageSize,
      statusCounts,
    };
  }

  @Get(":kbId/documents/:docId")
  async getDocument(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId))
      throw new NotFoundException("Document not found.");
    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      include: {
        chunks: {
          orderBy: { ord: "asc" },
          select: { id: true, ord: true, content: true, tokenCount: true },
        },
      },
    });
    if (!document) throw new NotFoundException("Document not found.");
    const uploadRoot =
      process.env.UPLOAD_DIR || join(homedir(), ".local/share/llmwiki/uploads");
    const mdFile = join(
      uploadRoot,
      document.mdPath || `${document.id}/content.md`,
    );
    let rawMd = "";
    try {
      rawMd = await readFile(mdFile, "utf-8");
    } catch {
      rawMd = document.chunks.map((chunk) => chunk.content).join("\n\n");
    }

    return {
      document: {
        id: document.id,
        kbId: document.kbId,
        title: document.title,
        status: document.status,
        mdPath: document.mdPath || `${document.id}/content.md`,
        gitCommit: document.gitCommit,
        version: document.version,
        sourceType: document.sourceType,
        chunkCount: document.chunks.length,
        hasRawFile: Boolean(document.rawFileOid),
        parserEngine: document.parserEngine,
        parserClassification: document.parserClassification,
        parserMetadata: document.parserMetadata,
        qualityStatus: document.qualityStatus,
        qualityScore: document.qualityScore,
        qualityIssues: document.qualityIssues,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
      chunks: document.chunks,
      markdown_content: rawMd,
    };
  }

  @Get(":kbId/documents/:docId/preview-config")
  async getPreviewConfig(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId))
      throw new NotFoundException("Document not found.");
    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      select: {
        id: true,
        kbId: true,
        title: true,
        version: true,
        updatedAt: true,
        rawFileOid: true,
      },
    });
    if (!document?.rawFileOid)
      throw new NotFoundException("Original file not found.");
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const fileToken = signPreviewPayload({ userId, kbId, docId, exp });
    const storageBase =
      process.env.PREVIEW_STORAGE_BASE_URL ||
      `${req.protocol || "http"}://${req.get?.("host") || req.headers.host}`;
    const documentServerUrl =
      process.env.ONLYOFFICE_URL ||
      `${req.protocol || "http"}://${String(req.headers.host || "localhost").split(":")[0]}:8090`;
    const fileUrl = `${storageBase.replace(/\/$/, "")}/api/v1/kbs/${kbId}/documents/${docId}/preview-file?token=${encodeURIComponent(fileToken)}`;
    return {
      documentServerUrl,
      config: {
        document: {
          fileType:
            extname(document.title).replace(".", "").toLowerCase() || "docx",
          key: `${document.id}-${document.version}-${document.updatedAt.getTime()}`.slice(
            0,
            120,
          ),
          title: document.title,
          url: fileUrl,
          permissions: {
            edit: false,
            download: false,
            print: false,
            comment: false,
            fillForms: false,
            copy: false,
          },
        },
        documentType: onlyOfficeDocumentType(document.title),
        editorConfig: {
          mode: "view",
          lang: "zh-CN",
          customization: {
            autosave: false,
            forcesave: false,
            compactHeader: true,
          },
        },
        height: "100%",
        type: "desktop",
      },
    };
  }

  @Get(":kbId/documents/:docId/compile-truth")
  async getCompileTruth(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId))
      throw new NotFoundException("Document not found.");

    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      select: {
        id: true,
        title: true,
        status: true,
        version: true,
        updatedAt: true,
        chunks: { select: { id: true } },
      },
    });
    if (!document) throw new NotFoundException("Document not found.");

    const topicSlug = brainTopicSlug(document.title);
    const [brainRepo, sourceDocuments] = await Promise.all([
      this.prisma.brainRepo.findUnique({
        where: { userId },
        select: {
          id: true,
          lastCompileAt: true,
          topics: {
            where: { topicSlug },
            select: {
              id: true,
              topicSlug: true,
              mdPath: true,
              compileStatus: true,
              dirtySource: true,
              dirtyDocIds: true,
              dirtySince: true,
              lastCompiledAt: true,
              compileJobs: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  id: true,
                  trigger: true,
                  status: true,
                  attempt: true,
                  truthDiff: true,
                  gitCommit: true,
                  createdAt: true,
                  completedAt: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.brainSourceDocument.findMany({
        where: {
          documentId: docId,
          source: {
            status: "active",
            members: { some: { userId } },
          },
        },
        select: {
          syncedVersion: true,
          syncedAt: true,
          source: {
            select: {
              sourceKey: true,
              kind: true,
              scopeKey: true,
              lastSyncAt: true,
            },
          },
        },
        orderBy: { syncedAt: "desc" },
      }),
    ]);

    const topic = brainRepo?.topics[0] || null;
    const latestJob = topic?.compileJobs[0] || null;
    return {
      document: {
        id: document.id,
        title: document.title,
        status: document.status,
        version: document.version,
        chunkCount: document.chunks.length,
        updatedAt: document.updatedAt,
      },
      compileTruth: {
        state: topic?.compileStatus || "not_created",
        topicSlug,
        topicId: topic?.id || null,
        mdPath: topic?.mdPath || null,
        lastCompiledAt: topic?.lastCompiledAt || null,
        brainRepoLastCompileAt: brainRepo?.lastCompileAt || null,
        dirtySource: topic?.dirtySource || null,
        dirtyDocIds: Array.isArray(topic?.dirtyDocIds) ? topic?.dirtyDocIds : [],
        dirtySince: topic?.dirtySince || null,
        latestJob,
        sources: sourceDocuments.map((item) => ({
          sourceKey: item.source.sourceKey,
          kind: item.source.kind,
          syncedVersion: item.syncedVersion,
          syncedAt: item.syncedAt,
          lastSyncAt: item.source.lastSyncAt,
        })),
      },
    };
  }

  @Get(":kbId/documents/:docId/file")
  async getOriginalFile(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
    @Res() response: Response,
  ) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId))
      throw new NotFoundException("Document not found.");
    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      select: { title: true, rawFileOid: true },
    });
    if (!document?.rawFileOid)
      throw new NotFoundException("Original file not found.");
    const bytes = await readFile(document.rawFileOid).catch(() => null);
    if (!bytes) throw new NotFoundException("Original file not found.");
    const filename = encodeURIComponent(document.title).replace(/'/g, "%27");
    response.setHeader("Content-Type", contentTypeFor(document.title));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${filename}`,
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; object-src 'self' blob: data:; frame-src 'self' blob: data:; frame-ancestors 'self';",
    );
    if (
      [".html", ".htm", ".svg"].includes(extname(document.title).toLowerCase())
    ) {
      response.setHeader(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
    }
    response.send(bytes);
  }

  @Get(":kbId/documents/:docId/pdf-preview")
  async getPdfPreview(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
    @Res() response: Response,
  ) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const visibleIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId))
      throw new NotFoundException("Document not found.");
    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      select: { id: true, title: true, rawFileOid: true, version: true },
    });
    if (!document?.rawFileOid)
      throw new NotFoundException("Original file not found.");

    const ext = extname(document.title).toLowerCase();

    // 1. If it is already a PDF, return directly
    if (ext === ".pdf") {
      const bytes = await readFile(document.rawFileOid).catch(() => null);
      if (!bytes) throw new NotFoundException("Original file not found.");
      const filename = encodeURIComponent(document.title).replace(/'/g, "%27");
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${filename}`,
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      return response.send(bytes);
    }

    // 2. For Office formats (PPT, PPTX, etc.), check or generate cached PDF preview
    const cacheDir = dirname(document.rawFileOid);
    const cachedPdf = join(
      cacheDir,
      `converted_preview_v${document.version || 1}.pdf`,
    );

    let pdfBytes: Buffer | null = await readFile(cachedPdf).catch(() => null);

    if (!pdfBytes) {
      const tempOutDir = join(
        cacheDir,
        `.convert_temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      );
      await mkdir(tempOutDir, { recursive: true });
      try {
        await execFileAsync(
          "soffice",
          [
            "--headless",
            "--convert-to",
            "pdf",
            document.rawFileOid,
            "--outdir",
            tempOutDir,
          ],
          { timeout: 120000 },
        );
        const files = await readdir(tempOutDir);
        const generatedPdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
        if (!generatedPdf) {
          throw new Error("No PDF generated by soffice");
        }
        await rename(join(tempOutDir, generatedPdf), cachedPdf);
        pdfBytes = await readFile(cachedPdf);
      } catch (err: any) {
        await rm(tempOutDir, { recursive: true, force: true }).catch(() => null);
        throw new BadRequestException(
          `Document conversion to PDF failed: ${err.message || err}`,
        );
      } finally {
        await rm(tempOutDir, { recursive: true, force: true }).catch(() => null);
      }
    }

    if (!pdfBytes) {
      throw new NotFoundException("Failed to generate PDF preview.");
    }

    const pdfTitle = document.title.replace(/\.[^.]+$/, "") + ".pdf";
    const filename = encodeURIComponent(pdfTitle).replace(/'/g, "%27");
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${filename}`,
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; object-src 'self' blob: data:; frame-src 'self' blob: data:; frame-ancestors 'self';",
    );
    return response.send(pdfBytes);
  }

  @Get(":kbId/documents/:docId/preview-file")
  async getPreviewFile(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Query("token") token: string,
    @Res() response: Response,
  ) {
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const payload = verifyPreviewPayload(token);
    if (
      !payload ||
      payload.kbId !== kbId ||
      payload.docId !== docId ||
      !payload.userId
    )
      throw new UnauthorizedException("Preview token is invalid or expired.");
    // Re-check current authorization at the storage endpoint as well. The
    // short-lived token is only a transport credential for OnlyOffice.
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(
      payload.userId,
    );
    if (!visibleIds.includes(kbId))
      throw new UnauthorizedException(
        "Preview access is no longer authorized.",
      );
    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      select: { title: true, rawFileOid: true },
    });
    if (!document?.rawFileOid)
      throw new NotFoundException("Original file not found.");
    const bytes = await readFile(document.rawFileOid).catch(() => null);
    if (!bytes) throw new NotFoundException("Original file not found.");
    response.setHeader("Content-Type", contentTypeFor(document.title));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(document.title).replace(/'/g, "%27")}`,
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; object-src 'self' blob: data:; frame-src 'self' blob: data:; frame-ancestors 'self';",
    );
    if (
      [".html", ".htm", ".svg"].includes(extname(document.title).toLowerCase())
    ) {
      response.setHeader(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
    }
    response.send(bytes);
  }
}
