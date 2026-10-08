import { uploadRoot, resolveUploadPath } from '../storage/upload-paths';
import { Injectable, BadRequestException, ForbiddenException, Logger, NotFoundException, Optional } from '@nestjs/common';
import { getPrismaClient } from "../prisma";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { ObjectStorageService } from "../storage/object-storage.service";
import { join, dirname, basename } from "node:path";
import { withServiceContext } from "../db/tenant-context.service";
import { PermissionService } from "../permission/permission.service";

import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
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


function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

@Injectable()
export class DocumentLifecycleService {
  private readonly logger = new Logger(DocumentLifecycleService.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot = uploadRoot();
  constructor(
    private readonly permissionService: PermissionService,
    private readonly compilerService: BrainCompilerService,
    private readonly ingestionService: IngestionService,
    private readonly objectStorage: ObjectStorageService,
    @Optional() private readonly graphRagService?: GraphRagService,
    @Optional() private readonly raptorService?: RaptorService,
    @Optional() private readonly lexicalIndexService?: LexicalIndexService,
  ) {}
  async persistUpload(data: any, duplicateMode: 'skip' | 'copy') {
    return withServiceContext(this.prisma, async tx => {
      await tx.$executeRaw`SELECT id FROM "KnowledgeBase" WHERE id = ${data.kbId}::uuid FOR UPDATE`;
      if (duplicateMode === 'skip') {
        const existing = await tx.document.findFirst({ where: {
          kbId: data.kbId, title: data.title, contentHash: data.contentHash,
          lifecycleStatus: 'current', status: { not: 'failed' },
        } });
        if (existing) return { document: existing, reused: true };
      }
      return { document: await tx.document.create({ data }), reused: false };
    });
  }

  async addTextDocument(userId: string, kbId: string, body: { title?: string; content?: string; duplicateMode?: 'skip' | 'copy' }) {
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
    const duplicateMode = body?.duplicateMode ?? 'copy';
    if (!['skip', 'copy'].includes(duplicateMode))
      throw new BadRequestException("duplicateMode must be skip or copy.");
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const documentId = randomUUID();
    const rawPath = `${documentId}/${normalizeUploadFilename(`${title}.txt`)}`;
    await mkdir(join(this.uploadRoot, documentId), { recursive: true });
    await writeFile(join(this.uploadRoot, rawPath), content, "utf8");
    let objectKey: string | undefined;
    let storageProvider = "local";
    try {
      const stored = await this.objectStorage.put(`raw/${documentId}`, Buffer.from(content, "utf8"));
      objectKey = stored.objectKey;
      storageProvider = stored.provider;
    } catch { /* fail-open to local raw path */ }
    const uploaded = await this.persistUpload({
        id: documentId,
        kbId,
        mdPath: `${documentId}/content.md`,
        title,
        contentHash,
        sourceType: "text",
        rawFileOid: join(this.uploadRoot, rawPath),
        objectKey,
        storageProvider,
        uploadedById: userId,
        status: "parsing",
    }, duplicateMode);
    const document = uploaded.document;
    if (uploaded.reused) {
      await rm(join(this.uploadRoot, documentId), { recursive: true, force: true });
      if (objectKey) await this.objectStorage.delete(objectKey, storageProvider === "minio" ? "minio" : "local");
      return { documents: [document], status: "accepted", reused: true };
    }
    await this.ingestionService.enqueue(document.id, "upload", document.version, 1);
    return { documents: [document], status: "accepted" };
  }

  async retryDocument(userId: string, kbId: string, docId: string) {
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
    const pendingVersion = immutableVersionsEnabled() && document.buildingVersionId
      ? await this.prisma.documentVersion.findUnique({ where: { id: document.buildingVersionId } }) : null;
    const isStaleParsing =
      document.status === "parsing" &&
      Date.now() - new Date(document.updatedAt).getTime() > 3 * 60 * 1000;
    if (!["failed", "needs_review"].includes(document.status) && !isStaleParsing && !['failed', 'needs_review'].includes(pendingVersion?.state || ''))
      throw new BadRequestException(
        "Only failed, review-held, or stale parsing documents can be retried.",
      );
    if (!document.rawFileOid)
      throw new BadRequestException("Original upload is no longer available.");

    const retriedDocument = await this.prisma.document.update({
      where: { id: docId },
      data: {
        ...(immutableVersionsEnabled() ? { ingestVersion: { increment: 1 }, ...(!document.activeVersionId ? { status: 'parsing' } : {}) }
          : { version: { increment: 1 }, status: 'parsing' }),
        qualityStatus: "unknown",
        qualityScore: null,
        qualityIssues: [],
      },
    });
    await this.ingestionService.enqueue(docId, "manual-retry", immutableVersionsEnabled() ? retriedDocument.ingestVersion || retriedDocument.version : retriedDocument.version);
    return { document: retriedDocument, status: "accepted" };
  }

  async deleteDocument(userId: string, kbId: string, docId: string) {
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
      select: { id: true, rawFileOid: true, objectKey: true, storageProvider: true },
    });
    if (!document) throw new NotFoundException("Document not found.");
    // Repair the BM25 corpus statistics BEFORE the row (and its cascading
    // ChunkLexicalDoc postings) disappear: df/N are maintained incrementally,
    // so a delete that skipped this step left every later query scored against
    // a corpus that still contained the deleted document.
    await this.lexicalIndexService?.removeDocument(kbId, docId, { strict: true });
    await this.compilerService.onKnowledgeDeleted(kbId, docId);
    // Accuracy first: stale graph/global-summary facts must be invalidated
    // before the delete request completes. Both cleanup operations are
    // idempotent; GraphRAG internally degrades to a logged zero-result.
    await Promise.all([
      this.graphRagService?.removeDocumentFromGraph(kbId, docId, { strict: true }),
      this.raptorService?.removeDocument(kbId, docId),
    ]);
    await this.prisma.document.delete({ where: { id: docId } });
    // Object-storage delete first keys off objectKey (MinIO or local object
    // namespace); rawFileOid removal below covers the parser's local copy.
    if (document.objectKey) {
      const provider = (document.storageProvider === "minio" ? "minio" : "local") as
        | "minio"
        | "local";
      await this.objectStorage
        .delete(document.objectKey, provider)
        .catch((err) => {
          this.logger.warn(
            `Object storage delete failed for ${document.objectKey}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
    if (document.rawFileOid)
      await unlink(resolveUploadPath(document.rawFileOid)).catch(() => undefined);
    const directories = new Set([join(this.uploadRoot, docId)]);
    if (document.rawFileOid) {
      const legacyDirectory = dirname(resolveUploadPath(document.rawFileOid));
      if (basename(legacyDirectory) === docId) directories.add(legacyDirectory);
    }
    for (const directory of directories) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, documentId: docId };
  }
}
