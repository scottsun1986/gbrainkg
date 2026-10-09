import { DocumentLifecycleService } from './document-lifecycle.service';
import { uploadRoot, resolveUploadPath } from '../storage/upload-paths';
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
  UnsupportedMediaTypeException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { getPrismaClient } from "../prisma";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { ObjectStorageService } from "../storage/object-storage.service";
import { extname, join, dirname, basename } from "node:path";
import { withServiceContext } from "../db/tenant-context.service";
import { PermissionService } from "../permission/permission.service";
import { AuthService } from "../auth/auth.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { AuthGuard } from "../auth/auth.guard";
import { immutableVersionsEnabled } from './document-version-store';
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { IngestionService } from "./ingestion.service";
import { RaptorService } from "../raptor/raptor.service";
import { LexicalIndexService } from "../retrieval/lexical-index.service";

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
      return decodeURIComponent(raw).replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 240);
  } catch {
    /* keep the original filename when it is not valid URI encoding */
  }
  return raw;
}

import { SUPPORTED_UPLOAD_EXTENSIONS, isArchiveFilename } from './parser-capabilities';
import { associateMarkdownResources } from './markdown-resources';
import { extractArchiveDocuments, ArchiveManifestItem } from './archive-extractor';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * True when the buffer holds at least one non-whitespace character.
 * Scans in 64KB chunks so a 200MB upload is never materialised as a single
 * JS string (the previous `buffer.toString("utf8")` did exactly that).
 */
function bufferHasNonWhitespace(buffer: Buffer): boolean {
  const CHUNK = 64 * 1024;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    const chunk = buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length));
    if (chunk.toString("utf8").trim().length > 0) return true;
  }
  return false;
}

@UseGuards(AuthGuard)
@Controller("api/v1/kbs")
export class IngestionController {
  private readonly logger = new Logger(IngestionController.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    uploadRoot();

  constructor(
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
    private readonly compilerService: BrainCompilerService,
    private readonly ingestionService: IngestionService,
    private readonly objectStorage: ObjectStorageService,
    @Optional() private readonly graphRagService?: GraphRagService,
    @Optional() private readonly raptorService?: RaptorService,
    @Optional() private readonly lexicalIndexService?: LexicalIndexService,
  ) {}

  private get lifecycle() {
    return new DocumentLifecycleService(this.permissionService, this.compilerService, this.ingestionService,
      this.objectStorage, this.graphRagService, this.raptorService, this.lexicalIndexService);
  }
  private persistUpload(data: any, duplicateMode: 'skip' | 'copy') {
    return this.lifecycle.persistUpload(data, duplicateMode);
  }

  @Post(":kbId/documents")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }),
  )
  async uploadDocument(
    @Param("kbId") kbId: string,
    @UploadedFile() file: any,
    @Req() req: any,
    @Body() body?: { duplicateMode?: 'skip' | 'copy' },
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (!file) throw new BadRequestException("A file is required.");

    // Fast-fail empty content synchronously: such uploads must never occupy
    // an ingestion-queue slot behind long-running parses of large documents.
    if (!file.size || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException("上传的文件为空，已拒绝受理。");
    }
    let filename = normalizeUploadFilename(file.originalname);
    // A filename without an extension is plain text; parser-worker already
    // defaults such uploads to Markdown, so accept them here instead of
    // rejecting the same payload the parser would have handled.
    if (!extname(filename)) filename = `${filename}.md`;
    const extension = extname(filename).toLowerCase();
    const textLikeExtensions = new Set([".md", ".txt", ".csv", ".html", ".htm"]);
    if (
      textLikeExtensions.has(extension) &&
      !bufferHasNonWhitespace(file.buffer)
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

    // File uploads create a separate document by default. Older automated
    // clients can still explicitly request idempotent reuse with "skip".
    const duplicateMode = body?.duplicateMode ?? 'copy';
    if (!['skip', 'copy'].includes(duplicateMode))
      throw new BadRequestException("duplicateMode must be skip or copy.");

    const isArchive = isArchiveFilename(filename);
    if (isArchive) {
      const manifest: ArchiveManifestItem[] = [];
      const extractedFiles = await extractArchiveDocuments(file.buffer, filename, { manifest });
      const { dependencies, usedAssets } = associateMarkdownResources(extractedFiles);
      const batchId = randomUUID();
      const batchStore = (this.prisma as any).importBatch;
      await batchStore.create({ data: { id: batchId, kbId, uploadedById: userId, archiveName: filename, items: manifest } });
      const createdDocuments = [];
      let reusedCount = 0;
      for (const item of extractedFiles) {
        const entry = manifest.find(entry => entry.path === item.relativePath)!;
        entry.hash = createHash('sha256').update(item.buffer).digest('hex');
        if (usedAssets.has(item.relativePath)) { entry.status = 'asset'; entry.reason = 'Markdown 相对资源，随所属文档保存'; continue; }
        try {
        const childFilename = normalizeUploadFilename(item.filename);
        const contentHash = createHash('sha256').update(item.buffer).digest('hex');
        const childDocId = randomUUID();
        const rawPath = `${childDocId}/${childFilename}`;
        await mkdir(join(this.uploadRoot, childDocId), { recursive: true });
        await writeFile(join(this.uploadRoot, rawPath), item.buffer);
        let objectKey: string | undefined;
        let storageProvider = "local";
        try {
          const stored = await this.objectStorage.put(`raw/${childDocId}`, item.buffer);
          objectKey = stored.objectKey;
          storageProvider = stored.provider;
        } catch { /* fail-open to local raw path */ }
        const packageAssets = [];
        for (const asset of dependencies.get(item.relativePath) || []) {
          const path = `${childDocId}/package.${asset.id}`;
          await writeFile(join(this.uploadRoot, path), asset.buffer);
          packageAssets.push({ id: asset.id, sha256: asset.id, mime: asset.mime, filename: asset.filename, relativePath: asset.relativePath, path });
        }
        const uploaded = await this.persistUpload({
            id: childDocId,
            kbId,
            mdPath: `${childDocId}/content.md`,
            title: childFilename,
            contentHash,
            sourceType: "upload",
            rawFileOid: join(this.uploadRoot, rawPath),
            objectKey,
            storageProvider,
            uploadedById: userId,
            parserMetadata: { archive: { batchId, path: item.relativePath }, package_assets: packageAssets },
            status: "parsing",
        }, duplicateMode);
        const document = uploaded.document;
        entry.documentId = document.id;
        if (uploaded.reused) {
          await rm(join(this.uploadRoot, childDocId), { recursive: true, force: true });
          if (objectKey) await this.objectStorage.delete(objectKey, storageProvider === "minio" ? "minio" : "local");
          createdDocuments.push(document);
          reusedCount += 1; entry.status = 'reused';
          continue;
        }
        await this.ingestionService.enqueue(
          document.id,
          "upload",
          document.version,
          item.size <= 1_000_000 ? 1 : 10,
        );
        createdDocuments.push(document);
        } catch (error) { entry.status = 'failed'; entry.reason = error instanceof Error ? error.message : String(error); }
        finally { await batchStore.update({ where: { id: batchId }, data: { items: manifest } }); }
      }

      await batchStore.update({ where:{id:batchId},data:{items:manifest} });
      // 压缩包本身则删除：解压完成后压缩包在内存及临时流中被丢弃，从未落库或持久化，确保压缩包本身被物理删除。
      return {
        documents: createdDocuments,
        total: createdDocuments.length,
        reusedCount,
        status: "accepted",
        isArchive: true,
        archiveName: filename, batchId, manifest,
      };
    }

    const documentId = randomUUID();
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
      // 415 keeps the machine-readable contract aligned with the parser worker,
      // which rejects unknown types with 415 as well.
      throw new UnsupportedMediaTypeException(
        `不支持的文件类型：${extension || "无扩展名"}。支持：${[...SUPPORTED_UPLOAD_EXTENSIONS].join(" ")}`,
      );
    }
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const rawPath = `${documentId}/${filename}`;
    await mkdir(join(this.uploadRoot, documentId), { recursive: true });
    await writeFile(join(this.uploadRoot, rawPath), file.buffer);
    // check-then-act race: two concurrent uploads of identical content can
    // both pass the duplicate check and both insert. Serialize them by
    // locking the KB row (SELECT ... FOR UPDATE) so the second uploader
    // observes the first one's committed document and reuses it.
    const upload = await withServiceContext(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT id FROM "KnowledgeBase" WHERE id = ${kbId}::uuid FOR UPDATE`;
      if (duplicateMode === 'skip') {
        const existing = await tx.document.findFirst({
          where: { kbId, title: filename, contentHash, lifecycleStatus: 'current', status: { not: 'failed' } },
        });
        if (existing) return { reused: true as const, document: existing };
      }
      const created = await tx.document.create({
        data: {
          id: documentId,
          kbId,
          mdPath: `${documentId}/content.md`,
          title: filename,
          contentHash,
          sourceType: "upload",
          rawFileOid: join(this.uploadRoot, rawPath),
          objectKey: undefined,
          storageProvider: "local",
          uploadedById: userId,
          status: "parsing",
        },
      });
      return { reused: false as const, document: created };
    });
    if (upload.reused) {
      await rm(join(this.uploadRoot, documentId), { recursive: true, force: true });
      return { documents: [upload.document], status: 'accepted', reused: true };
    }
    try {
      const stored = await this.objectStorage.put(`raw/${documentId}`, file.buffer);
      await this.prisma.document.update({
        where: { id: documentId },
        data: { objectKey: stored.objectKey, storageProvider: stored.provider },
      });
      upload.document.objectKey = stored.objectKey;
      upload.document.storageProvider = stored.provider;
    } catch { /* fail-open to local raw path */ }
    const document = upload.document;
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
    @Body() body: { title?: string; content?: string; duplicateMode?: 'skip' | 'copy' },
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.lifecycle.addTextDocument(userId, kbId, body);
  }

  @Post(":kbId/documents/:docId/retry")
  async retryDocument(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.lifecycle.retryDocument(userId, kbId, docId);
  }

  @Delete(":kbId/documents/:docId")
  async deleteDocument(
    @Param("kbId") kbId: string,
    @Param("docId") docId: string,
    @Req() req: any,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.lifecycle.deleteDocument(userId, kbId, docId);
  }


}
