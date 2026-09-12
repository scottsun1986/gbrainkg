import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { getPrismaClient } from "../prisma";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { PermissionService } from "../permission/permission.service";
import { AuthService } from "../auth/auth.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { AuthGuard } from "../auth/auth.guard";
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { IngestionService } from "./ingestion.service";

function normalizeUploadFilename(value: unknown): string {
  const raw = String(value || "upload.bin")
    .replace(/[\\/\0-\x1f\x7f]/g, "_")
    .slice(0, 240);
  // Some multipart clients expose a UTF-8 filename as a Latin-1 string, e.g. "æµ‹è¯•.pdf".
  if (/[ÃÂà-ÿ]/.test(raw)) {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (decoded !== raw && !decoded.includes("\uFFFD")) {
      return decoded.replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 240);
    }
  }

  try {
    if (/%[0-9a-f]{2}/i.test(raw))
      return decodeURIComponent(raw).replace(/[\\/]/g, "_");
  } catch {
    /* keep the original filename when it is not valid URI encoding */
  }
  return raw;
}

import { SUPPORTED_UPLOAD_EXTENSIONS } from './parser-capabilities';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

@UseGuards(AuthGuard)
@Controller("api/v1/kbs")
export class IngestionController {
  private readonly logger = new Logger(IngestionController.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";

  constructor(
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
    private readonly compilerService: BrainCompilerService,
    private readonly ingestionService: IngestionService,
    @Optional() private readonly graphRagService?: GraphRagService,
  ) {}

  @Post(":kbId/documents")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }),
  )
  async uploadDocument(
    @Param("kbId") kbId: string,
    @UploadedFile() file: any,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!file) throw new BadRequestException("A file is required.");

    // Fast-fail empty content synchronously: such uploads must never occupy
    // an ingestion-queue slot behind long-running parses of large documents.
    if (!file.size || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException("上传的文件为空，已拒绝受理。");
    }
    const filename = normalizeUploadFilename(file.originalname);
    const extension = extname(filename).toLowerCase();
    const textLikeExtensions = new Set([".md", ".txt", ".csv", ".html", ".htm"]);
    if (
      textLikeExtensions.has(extension) &&
      !file.buffer.toString("utf8").trim()
    ) {
      throw new BadRequestException("文件内容为空或纯空白，已拒绝受理。");
    }

    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: {
        id: true,
        type: true,
        ownerUserId: true,
        orgNodeId: true,
        status: true,
      },
    });
    if (!kb || kb.status !== "active")
      throw new NotFoundException("Knowledge base not found.");
    const visible =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visible.includes(kbId))
      throw new ForbiddenException(
        "Knowledge base is not visible to this user.",
      );
    const canWrite = await this.permissionService.canManageKnowledgeBase(
      userId,
      kbId,
    );
    if (!canWrite)
      throw new ForbiddenException(
        "Only the knowledge base owner or administrator can upload.",
      );

    const documentId = randomUUID();
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
      throw new BadRequestException("Unsupported file type.");
    }
    const rawPath = `${documentId}/${filename}`;
    await mkdir(join(this.uploadRoot, documentId), { recursive: true });
    await writeFile(join(this.uploadRoot, rawPath), file.buffer);
    const document = await this.prisma.document.create({
      data: {
        id: documentId,
        kbId,
        mdPath: `${documentId}/content.md`,
        title: filename,
        sourceType: "upload",
        rawFileOid: join(this.uploadRoot, rawPath),
        uploadedById: userId,
        status: "parsing",
      },
    });
    await this.ingestionService.enqueue(
      document.id,
      "upload",
      document.version,
      // Small files ride a high-priority lane so negative/boundary cases and
      // light documents are not stuck behind long parses of large files.
      file.size <= 1_000_000 ? 1 : 10,
    );
    return { documents: [document], status: "accepted" };
  }

  @Post(":kbId/documents/text")
  async addTextDocument(
    @Param("kbId") kbId: string,
    @Body() body: { title?: string; content?: string },
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, status: true },
    });
    if (!kb || kb.status !== "active")
      throw new NotFoundException("Knowledge base not found.");
    if (
      !(await this.permissionService.getVisibleKnowledgeBases(userId)).includes(
        kbId,
      )
    )
      throw new ForbiddenException(
        "Knowledge base is not visible to this user.",
      );
    if (!(await this.permissionService.canManageKnowledgeBase(userId, kbId)))
      throw new ForbiddenException(
        "Only the knowledge base owner or administrator can add knowledge.",
      );
    const content = String(body?.content || "").trim();
    if (!content) throw new BadRequestException("Text content is required.");
    if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024)
      throw new BadRequestException("Text content cannot exceed 10 MB.");
    const title =
      String(body?.title || "")
        .trim()
        .slice(0, 200) || "未命名文本知识";
    const documentId = randomUUID();
    const rawPath = `${documentId}/${normalizeUploadFilename(`${title}.txt`)}`;
    await mkdir(join(this.uploadRoot, documentId), { recursive: true });
    await writeFile(join(this.uploadRoot, rawPath), content, "utf8");
    const document = await this.prisma.document.create({
      data: {
        id: documentId,
        kbId,
        mdPath: `${documentId}/content.md`,
        title,
        sourceType: "text",
        rawFileOid: join(this.uploadRoot, rawPath),
        uploadedById: userId,
        status: "parsing",
      },
    });
    await this.ingestionService.enqueue(document.id, "upload", document.version, 1);
    return { documents: [document], status: "accepted" };
  }

  @Post(":kbId/documents/:docId/retry")
  async retryDocument(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: {
        id: true,
        type: true,
        ownerUserId: true,
        orgNodeId: true,
        status: true,
      },
    });
    if (!kb || kb.status !== "active")
      throw new NotFoundException("Knowledge base not found.");
    const visible =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visible.includes(kbId))
      throw new ForbiddenException(
        "Knowledge base is not visible to this user.",
      );
    const canWrite = await this.permissionService.canManageKnowledgeBase(
      userId,
      kbId,
    );
    if (!canWrite)
      throw new ForbiddenException(
        "Only the knowledge base owner or administrator can retry parsing.",
      );

    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
    });
    if (!document) throw new NotFoundException("Document not found.");
    if (!["failed", "needs_review"].includes(document.status))
      throw new BadRequestException(
        "Only failed or review-held documents can be retried.",
      );
    if (!document.rawFileOid)
      throw new BadRequestException("Original upload is no longer available.");

    const retriedDocument = await this.prisma.document.update({
      where: { id: docId },
      data: {
        version: { increment: 1 },
        status: "parsing",
        qualityStatus: "unknown",
        qualityScore: null,
        qualityIssues: [],
      },
    });
    await this.ingestionService.enqueue(docId, "manual-retry", retriedDocument.version);
    return { document: retriedDocument, status: "accepted" };
  }

  @Delete(":kbId/documents/:docId")
  async deleteDocument(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!isUuid(kbId) || !isUuid(docId))
      throw new NotFoundException("Document not found.");
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: {
        id: true,
        type: true,
        ownerUserId: true,
        orgNodeId: true,
        status: true,
      },
    });
    if (!kb || kb.status !== "active")
      throw new NotFoundException("Knowledge base not found.");
    const visible =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visible.includes(kbId))
      throw new ForbiddenException(
        "Knowledge base is not visible to this user.",
      );
    if (!(await this.permissionService.canManageKnowledgeBase(userId, kbId)))
      throw new ForbiddenException(
        "Only an organization administrator or knowledge base administrator can delete documents.",
      );
    const document = await this.prisma.document.findFirst({
      where: { id: docId, kbId },
      select: { id: true, rawFileOid: true },
    });
    if (!document) throw new NotFoundException("Document not found.");
    await this.compilerService.onKnowledgeDeleted(kbId, docId);
    await this.prisma.document.delete({ where: { id: docId } });
    // Fire-and-forget graph cleanup: prune relations/entities contributed by
    // the deleted document (the method itself is idempotent and swallows its
    // own errors; the catch below only guards against unexpected rejections).
    // Must never block or fail the deletion main flow.
    this.graphRagService
      ?.removeDocumentFromGraph(kbId, docId)
      .catch((err: unknown) => {
        this.logger.warn(
          `Post-delete graph cleanup failed for document ${docId} in KB ${kbId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    if (document.rawFileOid)
      await unlink(document.rawFileOid).catch(() => undefined);
    await unlink(join(this.uploadRoot, docId, "content.md")).catch(
      () => undefined,
    );
    return { ok: true, documentId: docId };
  }
}
