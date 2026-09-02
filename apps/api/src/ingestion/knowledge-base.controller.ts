import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { Response } from "express";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { PermissionService } from "../permission/permission.service";
import { AuthService } from "../auth/auth.service";
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
  private readonly prisma = new PrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";

  constructor(
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
  ) {}

  private async currentUser(req: any): Promise<string> {
    return this.authService.userIdFromRequest(req);
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
    const writePermissions = await Promise.all(
      items.map((item) =>
        this.permissionService.canManageKnowledgeBase(userId, item.id),
      ),
    );
    const deletePermissions = await Promise.all(
      items.map((item) =>
        item.type === "industry"
          ? this.permissionService.canManageIndustryKb(userId, item.id)
          : item.ownerUserId === userId,
      ),
    );
    return {
      items: items.map(({ _count, ...item }, index) => ({
        ...item,
        documentCount: _count.documents,
        canWrite: writePermissions[index],
        canDelete: deletePermissions[index],
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
      ...(search && search.trim()
        ? {
            OR: [
              { title: { contains: search.trim(), mode: "insensitive" } },
              { mdPath: { contains: search.trim(), mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.document.count({ where }),
    ]);
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
      items.map(async (item) => {
        let sizeBytes: number | null = null;
        if (item.rawFileOid) {
          try {
            const fileStat = await stat(item.rawFileOid);
            sizeBytes = fileStat.size;
          } catch {}
        }
        if (!sizeBytes) {
          try {
            const contentStat = await stat(
              join(this.uploadRoot, item.id, "content.md"),
            );
            sizeBytes = contentStat.size;
          } catch {}
        }
        return {
          ...item,
          sizeBytes,
          uploadedBy: item.uploadedById
            ? uploaderById.get(item.uploadedById) || null
            : null,
        };
      }),
    );
    return {
      items: itemsWithStats,
      total,
      page: pageNumber,
      limit: pageSize,
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
